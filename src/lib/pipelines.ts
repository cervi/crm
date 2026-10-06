import { z } from "zod";
import { sql, transaction } from "./db";
import { UserError } from "./errors";
import { checkbox, optional, optText, parse, text } from "./validation";
import { assertActivityType } from "./activity-types";

export type Pipeline = { id: string; name: string; description: string | null; is_active: boolean; position: number };
export type Stage = {
  id: string;
  pipeline_id: string;
  name: string;
  position: number;
  win_probability: number | null;
  rotten_after_days: number | null;
  required_activity_type: string | null;
  deals: number;
};

export async function listPipelines(includeInactive = false): Promise<Pipeline[]> {
  return sql<Pipeline[]>`
    SELECT id, name, description, is_active, position FROM pipelines
    WHERE ${includeInactive} OR is_active ORDER BY position, name`;
}

export async function getPipeline(id: string): Promise<Pipeline | null> {
  const [p] = await sql<Pipeline[]>`
    SELECT id, name, description, is_active, position FROM pipelines WHERE id = ${id}`;
  return p ?? null;
}

export async function listStages(pipelineId: string): Promise<Stage[]> {
  return sql<Stage[]>`
    SELECT s.id, s.pipeline_id, s.name, s.position, s.win_probability, s.rotten_after_days,
           s.required_activity_type,
           (SELECT count(*)::int FROM deals d WHERE d.stage_id = s.id AND d.deleted_at IS NULL) AS deals
    FROM stages s WHERE s.pipeline_id = ${pipelineId} AND s.is_active ORDER BY s.position`;
}

/** Todas las fases activas de todos los pipelines (para selectores). */
export async function listAllStages() {
  return sql<{ id: string; pipeline_id: string; name: string; position: number }[]>`
    SELECT s.id, s.pipeline_id, s.name, s.position FROM stages s
    JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.is_active AND p.is_active ORDER BY p.position, s.position`;
}

export type BoardDeal = {
  id: string;
  title: string;
  organization_name: string | null;
  person_name: string | null;
  owner_name: string | null;
  value: string | null;
  currency: string;
  days_in_stage: number;
  is_rotten: boolean;
  has_upcoming_session: boolean;
  next_activity_at: Date | null;
  /** Propuestas de la IA esperando decisión. */
  pending_ai: number;
};

export type BoardStage = {
  id: string;
  name: string;
  position: number;
  rotten_after_days: number | null;
  win_probability: number | null;
  total_value: string;
  deals: BoardDeal[];
};

export const BOARD_SORTS = {
  attention: "Requieren atención",
  value: "Importe",
  days: "Días en la fase",
  next_activity: "Próxima actividad",
  created: "Fecha de alta",
  close: "Cierre previsto",
  title: "Título",
} as const;
export type BoardSort = keyof typeof BOARD_SORTS;
export const isBoardSort = (v: unknown): v is BoardSort => typeof v === "string" && v in BOARD_SORTS;

/** Orden de las tarjetas dentro de cada columna (lista cerrada de opciones). */
function boardOrder(sort: BoardSort) {
  switch (sort) {
    case "value": return sql`o.value DESC NULLS LAST, o.title`;
    case "days": return sql`o.days_in_stage DESC, o.title`;
    case "next_activity": return sql`na.due_at ASC NULLS LAST, o.title`;
    case "created": return sql`dd.created_at DESC`;
    case "close": return sql`dd.expected_close_date ASC NULLS LAST, o.title`;
    case "title": return sql`lower(o.title)`;
    default: return sql`o.is_rotten DESC, o.has_upcoming_session ASC, o.days_in_stage DESC`;
  }
}

/** Tablero de un pipeline: fases en orden, cada una con sus deals abiertos. */
export async function getBoard(pipelineId: string, ownerId?: string | null, sort: BoardSort = "attention"): Promise<BoardStage[]> {
  return sql<BoardStage[]>`
    SELECT s.id, s.name, s.position, s.rotten_after_days, s.win_probability,
           coalesce(sum(o.value), 0)::text AS total_value,
           coalesce(
             json_agg(json_build_object(
               'id', o.id, 'title', o.title, 'organization_name', org.name,
               'person_name', pp.full_name, 'owner_name', u.name,
               'value', o.value::text, 'currency', o.currency,
               'days_in_stage', o.days_in_stage, 'is_rotten', o.is_rotten,
               'has_upcoming_session', o.has_upcoming_session,
               'next_activity_at', na.due_at,
               'pending_ai', (SELECT count(*) FROM automation_actions x WHERE x.deal_id = o.id AND x.status = 'pending')
             ) ORDER BY ${boardOrder(sort)}) FILTER (WHERE o.id IS NOT NULL),
             '[]'
           ) AS deals
    FROM stages s
    LEFT JOIN open_deals_status o ON o.stage_id = s.id AND (${ownerId ?? null}::uuid IS NULL OR o.owner_id = ${ownerId ?? null}::uuid)
    LEFT JOIN deals dd ON dd.id = o.id
    LEFT JOIN organizations org ON org.id = o.organization_id
    LEFT JOIN users u ON u.id = o.owner_id
    LEFT JOIN LATERAL (
      SELECT p.full_name FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
      WHERE dp.deal_id = o.id ORDER BY dp.is_primary DESC LIMIT 1
    ) pp ON true
    LEFT JOIN LATERAL (
      SELECT min(a.due_at) AS due_at FROM activities a WHERE a.deal_id = o.id AND NOT a.done
    ) na ON true
    WHERE s.pipeline_id = ${pipelineId} AND s.is_active
    GROUP BY s.id
    ORDER BY s.position`;
}

export type PipelineDealRow = {
  id: string;
  title: string;
  status: "open" | "won" | "lost";
  value: string | null;
  currency: string;
  stage_name: string;
  stage_position: number;
  organization_id: string | null;
  organization_name: string | null;
  person_name: string | null;
  owner_name: string | null;
  days_in_stage: number;
  is_rotten: boolean;
  next_activity_at: Date | null;
  expected_close_date: string | null;
  created_at: Date;
  source: string | null;
  owner_id: string | null;
  stage_id: string;
  custom: Record<string, unknown>;
};

/** Filtros rápidos de la lista de deals. */
export const DEAL_FLAGS = {
  rotten: "Parados",
  no_activity: "Sin próxima actividad",
  overdue: "Con actividad vencida",
  closing_month: "Cierran este mes",
  no_close_date: "Sin fecha de cierre",
} as const;
export type DealFlag = keyof typeof DEAL_FLAGS;
export const isDealFlag = (v: unknown): v is DealFlag => typeof v === "string" && v in DEAL_FLAGS;

export type DealListFilters = {
  ownerId?: string | null; status?: "open" | "all" | "won" | "lost"; sort?: ListSort; dir?: "asc" | "desc";
  q?: string | null; stageId?: string | null; min?: number | null; max?: number | null; flag?: DealFlag | null;
};

const LIST_ORDER = {
  title: sql`lower(d.title)`,
  value: sql`d.value`,
  stage: sql`s.position`,
  organization: sql`lower(o.name)`,
  owner: sql`lower(u.name)`,
  days: sql`d.stage_entered_at`,
  next_activity: sql`na.due_at`,
  close: sql`d.expected_close_date`,
  created: sql`d.created_at`,
} as const;
export type ListSort = keyof typeof LIST_ORDER;
export const isListSort = (v: unknown): v is ListSort => typeof v === "string" && v in LIST_ORDER;

/** Vista de lista de un pipeline, con deals cerrados opcionalmente y filtros. */
export async function listPipelineDeals(pipelineId: string, opts: DealListFilters) {
  const status = opts.status ?? "open";
  const sort = LIST_ORDER[opts.sort ?? "stage"];
  // "días en la fase" crece cuanto más antigua es la fecha de entrada: se invierte.
  const asc = (opts.dir ?? "asc") === "asc" ? opts.sort !== "days" : opts.sort === "days";
  const q = opts.q?.trim() ? `%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const flag = opts.flag ?? null;
  return sql<PipelineDealRow[]>`
    SELECT d.id, d.title, d.status, d.value::text, d.currency, s.name AS stage_name, s.position AS stage_position,
           d.organization_id, o.name AS organization_name, pp.full_name AS person_name, u.name AS owner_name,
           floor(extract(epoch FROM now() - d.stage_entered_at) / 86400)::int AS days_in_stage,
           (d.status = 'open' AND s.rotten_after_days IS NOT NULL
             AND now() - d.stage_entered_at > make_interval(days => s.rotten_after_days)) AS is_rotten,
           na.due_at AS next_activity_at, d.expected_close_date::text, d.created_at,
           d.source, d.owner_id, d.stage_id, d.custom
    FROM deals d
    JOIN stages s ON s.id = d.stage_id
    LEFT JOIN organizations o ON o.id = d.organization_id
    LEFT JOIN users u ON u.id = d.owner_id
    LEFT JOIN LATERAL (
      SELECT p.full_name FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
      WHERE dp.deal_id = d.id ORDER BY dp.is_primary DESC LIMIT 1
    ) pp ON true
    LEFT JOIN LATERAL (
      SELECT min(a.due_at) AS due_at FROM activities a WHERE a.deal_id = d.id AND NOT a.done
    ) na ON true
    WHERE d.pipeline_id = ${pipelineId} AND d.deleted_at IS NULL
      AND (${status} = 'all' OR d.status = ${status})
      AND (${opts.ownerId ?? null}::uuid IS NULL OR d.owner_id = ${opts.ownerId ?? null}::uuid)
      AND (${opts.stageId ?? null}::uuid IS NULL OR d.stage_id = ${opts.stageId ?? null}::uuid)
      AND (${opts.min ?? null}::numeric IS NULL OR d.value >= ${opts.min ?? null}::numeric)
      AND (${opts.max ?? null}::numeric IS NULL OR d.value <= ${opts.max ?? null}::numeric)
      AND (${q}::text IS NULL OR d.title ILIKE ${q}::text OR o.name ILIKE ${q}::text OR pp.full_name ILIKE ${q}::text)
      AND (${flag}::text IS NULL
        OR (${flag}::text = 'rotten' AND d.status = 'open' AND s.rotten_after_days IS NOT NULL
              AND now() - d.stage_entered_at > make_interval(days => s.rotten_after_days))
        OR (${flag}::text = 'no_activity' AND d.status = 'open' AND na.due_at IS NULL)
        OR (${flag}::text = 'overdue' AND d.status = 'open' AND na.due_at < now())
        OR (${flag}::text = 'closing_month' AND d.status = 'open'
              AND date_trunc('month', d.expected_close_date) = date_trunc('month', now()))
        OR (${flag}::text = 'no_close_date' AND d.status = 'open' AND d.expected_close_date IS NULL))
    ORDER BY ${sort} ${asc ? sql`ASC` : sql`DESC`} NULLS LAST, d.created_at DESC
    LIMIT 1000`;
}

// ---------------------------------------------------------------------------
// Administración

const pipelineSchema = z.object({
  name: text("El nombre", 100),
  description: optText(500),
  is_active: checkbox,
});

export async function createPipeline(data: unknown): Promise<string> {
  const v = parse(pipelineSchema.extend({ stages: optText(4000) }), data);
  return transaction(async (tx) => {
    const [{ next }] = await tx<{ next: number }[]>`SELECT coalesce(max(position), 0) + 1 AS next FROM pipelines`;
    const [p] = await tx<{ id: string }[]>`
      INSERT INTO pipelines (name, description, position) VALUES (${v.name}, ${v.description ?? null}, ${next})
      RETURNING id`;
    const names = (v.stages ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    const stageNames = names.length ? names : ["Nuevo", "En curso", "Propuesta", "Negociación"];
    for (const [i, name] of stageNames.entries()) {
      await tx`INSERT INTO stages (pipeline_id, name, position) VALUES (${p.id}, ${name.slice(0, 100)}, ${i + 1})`;
    }
    return p.id;
  });
}

export async function updatePipeline(id: string, data: unknown) {
  const v = parse(pipelineSchema, data);
  if (!v.is_active) {
    const [{ open }] = await sql<{ open: number }[]>`
      SELECT count(*)::int AS open FROM deals WHERE pipeline_id = ${id} AND status = 'open' AND deleted_at IS NULL`;
    if (open > 0) throw new UserError(`No se puede desactivar: tiene ${open} deal(s) abiertos.`);
  }
  await sql`UPDATE pipelines SET name = ${v.name}, description = ${v.description ?? null}, is_active = ${v.is_active}
            WHERE id = ${id}`;
}

const stageSchema = z.object({
  name: text("El nombre", 100),
  win_probability: optional(z.coerce.number().int().min(0).max(100, "La probabilidad va de 0 a 100")),
  rotten_after_days: optional(z.coerce.number().int().min(1, "Los días deben ser 1 o más")),
  required_activity_type: optText(40),
});

export async function addStage(pipelineId: string, data: unknown) {
  const v = parse(stageSchema, data);
  await assertActivityType(v.required_activity_type, true);
  await sql`
    INSERT INTO stages (pipeline_id, name, position, win_probability, rotten_after_days, required_activity_type)
    SELECT ${pipelineId}, ${v.name}, coalesce(max(position), 0) + 1, ${v.win_probability ?? null},
           ${v.rotten_after_days ?? null}, ${v.required_activity_type ?? null}
    FROM stages WHERE pipeline_id = ${pipelineId}`;
}

export async function updateStage(stageId: string, data: unknown) {
  const v = parse(stageSchema, data);
  await assertActivityType(v.required_activity_type, true);
  await sql`
    UPDATE stages SET name = ${v.name}, win_probability = ${v.win_probability ?? null},
           rotten_after_days = ${v.rotten_after_days ?? null},
           required_activity_type = ${v.required_activity_type ?? null}
    WHERE id = ${stageId}`;
}

/** Sube o baja una fase intercambiando su posición con la vecina. */
export async function moveStage(stageId: string, direction: "up" | "down") {
  await transaction(async (tx) => {
    const [s] = await tx<{ pipeline_id: string; position: number }[]>`
      SELECT pipeline_id, position FROM stages WHERE id = ${stageId}`;
    if (!s) throw new UserError("La fase no existe.");
    const [n] = direction === "up"
      ? await tx<{ id: string; position: number }[]>`
          SELECT id, position FROM stages WHERE pipeline_id = ${s.pipeline_id} AND is_active AND position < ${s.position}
          ORDER BY position DESC LIMIT 1`
      : await tx<{ id: string; position: number }[]>`
          SELECT id, position FROM stages WHERE pipeline_id = ${s.pipeline_id} AND is_active AND position > ${s.position}
          ORDER BY position LIMIT 1`;
    if (!n) return;
    // La unicidad de la posición se comprueba al final de la transacción.
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    await tx`UPDATE stages SET position = ${n.position} WHERE id = ${stageId}`;
    await tx`UPDATE stages SET position = ${s.position} WHERE id = ${n.id}`;
  });
}

/** Elimina una fase sin deals (si tiene deals, hay que moverlos antes). */
export async function deleteStage(stageId: string) {
  await transaction(async (tx) => {
    const [s] = await tx<{ pipeline_id: string; deals: number; history: number; siblings: number }[]>`
      SELECT s.pipeline_id,
             (SELECT count(*)::int FROM deals d WHERE d.stage_id = s.id) AS deals,
             (SELECT count(*)::int FROM deal_stage_history h WHERE h.to_stage_id = s.id OR h.from_stage_id = s.id) AS history,
             (SELECT count(*)::int FROM stages x WHERE x.pipeline_id = s.pipeline_id AND x.is_active) AS siblings
      FROM stages s WHERE s.id = ${stageId}`;
    if (!s) throw new UserError("La fase no existe.");
    if (s.deals > 0) throw new UserError(`La fase tiene ${s.deals} deal(s). Muévelos a otra fase antes de eliminarla.`);
    if (s.siblings <= 1) throw new UserError("Un pipeline necesita al menos una fase.");
    // Si aparece en el historial de algún deal, se desactiva en vez de borrarse.
    if (s.history > 0) await tx`UPDATE stages SET is_active = false, position = position + 100000 WHERE id = ${stageId}`;
    else await tx`DELETE FROM stages WHERE id = ${stageId}`;
  });
}
