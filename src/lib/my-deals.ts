import { sql } from "./db";

// ===========================================================================
// «Mis deals»: todos los deals de una persona, de cualquier pipeline, en una
// lista con su siguiente paso. Pensada para repasar la cartera de un vistazo.
// ===========================================================================

export const MY_DEAL_FILTERS = [
  { key: "open", label: "Abiertos", hint: "Todos tus deals abiertos" },
  { key: "no_next", label: "Sin siguiente paso", hint: "Abiertos sin ninguna actividad pendiente" },
  { key: "overdue", label: "Con vencidas", hint: "Tienen una actividad con la fecha pasada" },
  { key: "closing", label: "Cierran este mes", hint: "Fecha de cierre prevista este mes o ya pasada" },
  { key: "rotten", label: "Parados", hint: "Llevan en la fase más tiempo del que toca" },
  { key: "won", label: "Ganados", hint: "Ganados en los últimos 90 días" },
  { key: "lost", label: "Perdidos", hint: "Perdidos en los últimos 90 días" },
] as const;
export type MyDealFilter = (typeof MY_DEAL_FILTERS)[number]["key"];

export type MyDealRow = {
  id: string; title: string; status: string; value: string | null; currency: string;
  pipeline_id: string; pipeline: string; stage: string; days_in_stage: number; is_rotten: boolean;
  organization_id: string | null; organization: string | null; person: string | null; owner: string | null;
  expected_close_date: Date | null; created_at: Date; closed_at: Date | null;
  next_id: string | null; next_subject: string | null; next_type: string | null; next_due: Date | null; overdue: number;
  last_done: Date | null; health: number | null;
};

export async function listMyDeals(opts: { ownerId: string | null; filter: MyDealFilter; pipelineId?: string | null; q?: string }) {
  const { ownerId, filter, pipelineId } = opts;
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  const closed = filter === "won" || filter === "lost";
  const rows = await sql<MyDealRow[]>`
    SELECT d.id, d.title, d.status, d.value::text, d.currency, d.pipeline_id, p.name AS pipeline, s.name AS stage,
           floor(extract(epoch FROM now() - d.stage_entered_at) / 86400)::int AS days_in_stage,
           (d.status = 'open' AND s.rotten_after_days IS NOT NULL AND now() - d.stage_entered_at > make_interval(days => s.rotten_after_days)) AS is_rotten,
           d.organization_id, o.name AS organization, pe.full_name AS person, u.name AS owner,
           d.expected_close_date, d.created_at, coalesce(d.won_at, d.lost_at) AS closed_at,
           na.id AS next_id, na.subject AS next_subject, na.type AS next_type, na.due_at AS next_due,
           (SELECT count(*)::int FROM activities a WHERE a.deal_id = d.id AND NOT a.done AND a.due_at < now()) AS overdue,
           (SELECT max(a.done_at) FROM activities a WHERE a.deal_id = d.id AND a.done) AS last_done,
           h.score AS health
    FROM deals d
    JOIN pipelines p ON p.id = d.pipeline_id JOIN stages s ON s.id = d.stage_id
    LEFT JOIN organizations o ON o.id = d.organization_id
    LEFT JOIN LATERAL (SELECT x.full_name FROM deal_participants dp JOIN persons x ON x.id = dp.person_id
                       WHERE dp.deal_id = d.id ORDER BY dp.is_primary DESC, dp.created_at LIMIT 1) pe ON true
    LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN deal_health h ON h.deal_id = d.id
    LEFT JOIN LATERAL (SELECT a.id, a.subject, a.type, a.due_at FROM activities a
                       WHERE a.deal_id = d.id AND NOT a.done ORDER BY a.due_at NULLS LAST LIMIT 1) na ON true
    WHERE d.deleted_at IS NULL
      AND (${ownerId}::uuid IS NULL OR d.owner_id = ${ownerId}::uuid)
      AND (${pipelineId ?? null}::uuid IS NULL OR d.pipeline_id = ${pipelineId ?? null}::uuid)
      AND (${q}::text IS NULL OR d.title ILIKE ${q} OR o.name ILIKE ${q} OR pe.full_name ILIKE ${q})
      AND ${closed
        ? sql`d.status = ${filter} AND coalesce(d.won_at, d.lost_at) > now() - interval '90 days'`
        : sql`d.status = 'open'`}
    ORDER BY ${closed ? sql`coalesce(d.won_at, d.lost_at) DESC` : sql`(na.id IS NULL) DESC, na.due_at NULLS FIRST, d.value DESC NULLS LAST`}
    LIMIT 1000`;
  const today = new Date(); const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59);
  const pick: Record<MyDealFilter, (r: MyDealRow) => boolean> = {
    open: () => true, won: () => true, lost: () => true,
    no_next: (r) => !r.next_id,
    overdue: (r) => r.overdue > 0,
    closing: (r) => Boolean(r.expected_close_date && new Date(r.expected_close_date) <= monthEnd),
    rotten: (r) => r.is_rotten,
  };
  return rows.filter(pick[filter]);
}

/** Cuántos hay en cada filtro de abiertos (para las pestañas). */
export async function myDealCounts(ownerId: string | null, pipelineId?: string | null, q?: string) {
  const all = await listMyDeals({ ownerId, filter: "open", pipelineId, q });
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0, 23, 59);
  return {
    open: all.length,
    no_next: all.filter((r) => !r.next_id).length,
    overdue: all.filter((r) => r.overdue > 0).length,
    closing: all.filter((r) => r.expected_close_date && new Date(r.expected_close_date) <= monthEnd).length,
    rotten: all.filter((r) => r.is_rotten).length,
    // Importe por moneda (no se suman euros con dólares).
    byCurrency: Object.entries(all.reduce<Record<string, number>>((acc, r) => { acc[r.currency] = (acc[r.currency] ?? 0) + Number(r.value ?? 0); return acc; }, {})),
  };
}
