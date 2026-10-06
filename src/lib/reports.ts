import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { CATALOG, CHARTS, PERIODS, normalizeConfig, safeRun, type WidgetConfig } from "./analytics";
import { generate, parseJsonReply } from "./ai";
import { parse } from "./validation";

// ===========================================================================
// Informes: previsión ponderada, objetivos, embudo por fases, velocidad de
// ventas y preguntas en lenguaje natural (la IA elige un informe del catálogo;
// nunca escribe SQL).
// ===========================================================================

const TZ = () => process.env.TZ || "Europe/Madrid";

export type ForecastRow = { month: string | null; deals: number; value: number; weighted: number };

/** Deals abiertos por mes de cierre previsto: importe y ponderado por la probabilidad de su fase. */
export async function forecast(f: { pipelineId?: string | null; ownerId?: string | null } = {}) {
  const rows = await sql<ForecastRow[]>`
    SELECT CASE WHEN d.expected_close_date IS NULL THEN NULL
                WHEN d.expected_close_date < date_trunc('month', now())::date THEN 'vencido'
                ELSE to_char(d.expected_close_date, 'YYYY-MM') END AS month,
           count(*)::int AS deals, coalesce(sum(d.value), 0)::float8 AS value,
           coalesce(sum(d.value * coalesce(s.win_probability, 0) / 100.0), 0)::float8 AS weighted
    FROM deals d JOIN stages s ON s.id = d.stage_id
    WHERE d.status = 'open' AND d.deleted_at IS NULL
      AND (${f.pipelineId ?? null}::uuid IS NULL OR d.pipeline_id = ${f.pipelineId ?? null}::uuid)
      AND (${f.ownerId ?? null}::uuid IS NULL OR d.owner_id = ${f.ownerId ?? null}::uuid)
    GROUP BY 1 ORDER BY 1 NULLS LAST`;
  const [won] = await sql<{ value: number; deals: number }[]>`
    SELECT coalesce(sum(value), 0)::float8 AS value, count(*)::int AS deals FROM deals
    WHERE status = 'won' AND deleted_at IS NULL AND won_at >= date_trunc('month', now())
      AND (${f.pipelineId ?? null}::uuid IS NULL OR pipeline_id = ${f.pipelineId ?? null}::uuid)
      AND (${f.ownerId ?? null}::uuid IS NULL OR owner_id = ${f.ownerId ?? null}::uuid)`;
  const byOwner = await sql<{ owner: string; deals: number; value: number; weighted: number }[]>`
    SELECT coalesce(u.name, 'Sin responsable') AS owner, count(*)::int AS deals, coalesce(sum(d.value), 0)::float8 AS value,
           coalesce(sum(d.value * coalesce(s.win_probability, 0) / 100.0), 0)::float8 AS weighted
    FROM deals d JOIN stages s ON s.id = d.stage_id LEFT JOIN users u ON u.id = d.owner_id
    WHERE d.status = 'open' AND d.deleted_at IS NULL
      AND (${f.pipelineId ?? null}::uuid IS NULL OR d.pipeline_id = ${f.pipelineId ?? null}::uuid)
    GROUP BY 1 ORDER BY weighted DESC`;
  return { months: rows, wonThisMonth: won, byOwner };
}

export type FunnelStage = { id: string; name: string; position: number; reached: number; conversion: number | null; avg_days: number | null; probability: number | null };

/**
 * Embudo de un pipeline: de los deals creados en el periodo, cuántos llegaron a
 * cada fase (o más allá), la conversión a la siguiente y los días medios en ella.
 */
export async function funnel(pipelineId: string, days = 365) {
  const stages = await sql<FunnelStage[]>`
    WITH cohort AS (
      SELECT d.id, d.status, d.stage_id FROM deals d
      WHERE d.pipeline_id = ${pipelineId} AND d.deleted_at IS NULL AND d.created_at >= now() - make_interval(days => ${days})
    ), reached AS (
      SELECT c.id, max(s.position) AS maxpos
      FROM cohort c
      LEFT JOIN deal_stage_history h ON h.deal_id = c.id
      JOIN stages s ON (s.id = h.to_stage_id OR s.id = c.stage_id) AND s.pipeline_id = ${pipelineId}
      GROUP BY c.id
    ), durations AS (
      SELECT h.to_stage_id AS stage_id,
             extract(epoch FROM coalesce(lead(h.changed_at) OVER (PARTITION BY h.deal_id ORDER BY h.changed_at), now()) - h.changed_at) / 86400 AS days
      FROM deal_stage_history h JOIN cohort c ON c.id = h.deal_id
    )
    SELECT s.id, s.name, s.position, s.win_probability AS probability,
           (SELECT count(*)::int FROM reached r WHERE r.maxpos >= s.position) AS reached,
           NULL::float8 AS conversion,
           (SELECT avg(du.days)::float8 FROM durations du WHERE du.stage_id = s.id) AS avg_days
    FROM stages s WHERE s.pipeline_id = ${pipelineId} AND s.is_active ORDER BY s.position`;
  for (let i = 0; i < stages.length; i++) {
    const next = stages[i + 1];
    stages[i].conversion = next && stages[i].reached ? next.reached / stages[i].reached : null;
  }
  const [c] = await sql<{ total: number; won: number; lost: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'won')::int AS won, count(*) FILTER (WHERE status = 'lost')::int AS lost
    FROM deals WHERE pipeline_id = ${pipelineId} AND deleted_at IS NULL AND created_at >= now() - make_interval(days => ${days})`;
  return { stages, total: c.total, won: c.won, lost: c.lost };
}

/** Velocidad de ventas: (deals abiertos × importe medio ganado × tasa de cierre) / duración media del ciclo. */
export async function velocity(pipelineId?: string | null) {
  const [v] = await sql<{ open: number; avg_won: number | null; win_rate: number | null; cycle: number | null }[]>`
    SELECT (SELECT count(*)::int FROM deals WHERE status = 'open' AND deleted_at IS NULL
              AND (${pipelineId ?? null}::uuid IS NULL OR pipeline_id = ${pipelineId ?? null}::uuid)) AS open,
           avg(value) FILTER (WHERE status = 'won')::float8 AS avg_won,
           (count(*) FILTER (WHERE status = 'won'))::float8 / nullif(count(*) FILTER (WHERE status IN ('won', 'lost')), 0) AS win_rate,
           avg(extract(epoch FROM won_at - created_at) / 86400) FILTER (WHERE status = 'won')::float8 AS cycle
    FROM deals
    WHERE deleted_at IS NULL AND coalesce(won_at, lost_at, created_at) >= now() - interval '12 months'
      AND (${pipelineId ?? null}::uuid IS NULL OR pipeline_id = ${pipelineId ?? null}::uuid)`;
  const perDay = v.avg_won && v.win_rate && v.cycle ? (v.open * v.avg_won * v.win_rate) / Math.max(1, v.cycle) : null;
  return { ...v, perMonth: perDay === null ? null : perDay * 30 };
}

// ---------------------------------------------------------------------------
// Objetivos

export const GOAL_METRICS = {
  won_value: { label: "Importe ganado", money: true },
  won_count: { label: "Deals ganados", money: false },
  new_deals: { label: "Deals nuevos", money: false },
  activities_done: { label: "Actividades hechas", money: false },
} as const;
export type GoalMetric = keyof typeof GOAL_METRICS;

export type GoalProgress = {
  id: string; user_id: string | null; user_name: string | null; metric: GoalMetric; period: "month" | "quarter"; target: number;
  pipeline_id: string | null; pipeline_name: string | null; actual: number; expected: number;
};

/** Objetivos con lo conseguido en el periodo actual y lo que «tocaría» llevar a estas alturas. */
export async function goalsProgress(): Promise<GoalProgress[]> {
  return sql<GoalProgress[]>`
    WITH g AS (
      SELECT g.*, date_trunc(g.period, now() AT TIME ZONE ${TZ()}) AT TIME ZONE ${TZ()} AS since,
             (date_trunc(g.period, now() AT TIME ZONE ${TZ()}) + CASE WHEN g.period = 'month' THEN interval '1 month' ELSE interval '3 months' END) AT TIME ZONE ${TZ()} AS until
      FROM goals g
    )
    SELECT g.id, g.user_id, u.name AS user_name, g.metric, g.period, g.target::float8 AS target, g.pipeline_id, p.name AS pipeline_name,
           CASE g.metric
             WHEN 'won_value' THEN (SELECT coalesce(sum(d.value), 0) FROM deals d WHERE d.status = 'won' AND d.deleted_at IS NULL
                 AND d.won_at >= g.since AND (g.user_id IS NULL OR d.owner_id = g.user_id) AND (g.pipeline_id IS NULL OR d.pipeline_id = g.pipeline_id))
             WHEN 'won_count' THEN (SELECT count(*) FROM deals d WHERE d.status = 'won' AND d.deleted_at IS NULL
                 AND d.won_at >= g.since AND (g.user_id IS NULL OR d.owner_id = g.user_id) AND (g.pipeline_id IS NULL OR d.pipeline_id = g.pipeline_id))
             WHEN 'new_deals' THEN (SELECT count(*) FROM deals d WHERE d.deleted_at IS NULL
                 AND d.created_at >= g.since AND (g.user_id IS NULL OR d.owner_id = g.user_id) AND (g.pipeline_id IS NULL OR d.pipeline_id = g.pipeline_id))
             ELSE (SELECT count(*) FROM activities a WHERE a.done AND a.done_at >= g.since AND (g.user_id IS NULL OR a.owner_id = g.user_id))
           END::float8 AS actual,
           (g.target * extract(epoch FROM now() - g.since) / extract(epoch FROM g.until - g.since))::float8 AS expected
    FROM g LEFT JOIN users u ON u.id = g.user_id LEFT JOIN pipelines p ON p.id = g.pipeline_id
    ORDER BY u.name NULLS FIRST, g.metric`;
}

const goalSchema = z.object({
  user_id: z.string().optional(),
  metric: z.enum(["won_value", "won_count", "new_deals", "activities_done"]),
  period: z.enum(["month", "quarter"]),
  target: z.coerce.number().positive("El objetivo tiene que ser mayor que 0").max(1e12),
  pipeline_id: z.string().optional(),
});

export async function saveGoal(data: unknown) {
  const v = parse(goalSchema, data);
  const uuid = (x?: string) => (x && /^[0-9a-f-]{36}$/i.test(x) ? x : null);
  await sql`INSERT INTO goals (user_id, metric, period, target, pipeline_id)
            VALUES (${uuid(v.user_id)}, ${v.metric}, ${v.period}, ${v.target}, ${uuid(v.pipeline_id)})`;
}

export async function deleteGoal(id: string) {
  await sql`DELETE FROM goals WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Preguntas en lenguaje natural

export type Answer = { title: string; config: WidgetConfig; result: Awaited<ReturnType<typeof safeRun>> };

/** La IA traduce la pregunta a un informe del catálogo, que se ejecuta como cualquier widget. */
export async function ask(question: string): Promise<Answer> {
  const q = question.trim();
  if (q.length < 4) throw new UserError("Escribe una pregunta un poco más larga.");
  if (q.length > 500) throw new UserError("La pregunta es demasiado larga.");
  const [pipelines, users] = await Promise.all([
    sql<{ id: string; name: string }[]>`SELECT id, name FROM pipelines WHERE is_active ORDER BY position`,
    sql<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE kind = 'human' AND is_active ORDER BY name`,
  ]);
  const catalogo = Object.fromEntries(Object.entries(CATALOG).map(([k, c]) => [k, {
    metricas: Object.fromEntries(Object.entries(c.metrics).map(([m, d]) => [m, d.label])),
    agrupaciones: Object.fromEntries(Object.entries(c.groups).map(([g, d]) => [g, d.label])),
    fechas: c.dates,
  }]));
  const raw = await generate("report_question", {
    pregunta: q, catalogo, periodos: PERIODS, graficos: CHARTS, pipelines, responsables: users,
    filtros: { pipeline_id: "id de pipeline", owner_id: "id de responsable", status: "open | won | lost (deals) / open | converted | archived (leads)", source: "origen exacto" },
  }, { maxTokens: 500 });
  if (raw === null) throw new UserError("Configura el modelo de IA en Ajustes → Modelo de IA para hacer preguntas.");
  const j = parseJsonReply<Partial<WidgetConfig> & { titulo?: string }>(raw);
  if (!j?.source) throw new UserError("No he sabido convertir la pregunta en un informe. Prueba a decirlo de otra forma.");
  let config: WidgetConfig;
  try {
    config = await normalizeConfig({ ...j, filters: j.filters ?? {} });
  } catch (err) {
    throw new UserError(`No he sabido convertir la pregunta en un informe (${err instanceof Error ? err.message : "configuración no válida"}).`);
  }
  return { title: (j.titulo ?? q).slice(0, 120), config, result: await safeRun(config) };
}
