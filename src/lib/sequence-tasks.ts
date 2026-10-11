import { sql } from "./db";
import { UserError } from "./errors";
import type { Actor } from "./events";
import { isId } from "./validation";

// ===========================================================================
// Cola de tareas de las secuencias (como la página «Tasks» de Apollo):
// llamadas, LinkedIn, tareas y correos manuales, con prioridad y vencimiento.
// Al hacerla (o saltarla), la secuencia sigue con el paso siguiente.
// ===========================================================================

export const TASK_TABS = [
  { key: "todas", label: "Todas", kinds: null },
  { key: "correos", label: "Correos manuales", kinds: ["manual_email"] },
  { key: "llamadas", label: "Llamadas", kinds: ["call"] },
  { key: "linkedin", label: "LinkedIn", kinds: ["linkedin_connect", "linkedin_message", "linkedin_view", "linkedin_interact"] },
  { key: "tareas", label: "Tareas", kinds: ["action_item", "task"] },
] as const;
export type TaskTab = (typeof TASK_TABS)[number]["key"];

export type QueueTask = {
  activity_id: string; step_kind: string; subject: string; note: string | null; due_at: Date | null; priority: "high" | "medium" | "low" | null;
  enrollment_id: string; sequence_id: string; sequence_name: string; step: number; steps: number;
  person_id: string; person_name: string; job_title: string | null; organization: string | null; email: string | null; phone: string | null;
  linkedin_url: string | null; deal_id: string | null; deal_title: string | null; owner_name: string | null; overdue: boolean;
  draft_subject: string | null; draft_html: string | null; draft_to: string | null;
};

export async function listQueue(f: { userId: string | null; all?: boolean; tab?: TaskTab; when?: "hoy" | "proximas" | "todas"; sequenceId?: string | null; limit?: number }) {
  const kinds = TASK_TABS.find((t) => t.key === (f.tab ?? "todas"))?.kinds ?? null;
  const when = f.when ?? "hoy";
  return sql<QueueTask[]>`
    SELECT a.id AS activity_id, coalesce(a.step_kind, 'task') AS step_kind, a.subject, a.note, a.due_at, a.priority,
           e.id AS enrollment_id, s.id AS sequence_id, s.name AS sequence_name, e.next_step + 1 AS step,
           (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS steps,
           p.id AS person_id, p.full_name AS person_name, po.job_title, o.name AS organization, p.linkedin_url,
           (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           (SELECT phone FROM person_phones WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS phone,
           d.id AS deal_id, d.title AS deal_title, u.name AS owner_name, (a.due_at < now()) AS overdue,
           a.draft_subject, a.draft_html, a.draft_to
    FROM sequence_enrollments e
    JOIN activities a ON a.enrollment_id = e.id AND NOT a.done AND a.step_kind IS NOT NULL
    JOIN sequences s ON s.id = e.sequence_id
    JOIN persons p ON p.id = e.person_id
    LEFT JOIN LATERAL (SELECT job_title, organization_id FROM person_organizations WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1) po ON true
    LEFT JOIN organizations o ON o.id = po.organization_id
    LEFT JOIN deals d ON d.id = e.deal_id
    LEFT JOIN users u ON u.id = a.owner_id
    WHERE e.status = 'active'
      AND (${Boolean(f.all)} OR a.owner_id = ${f.userId})
      AND (${kinds === null} OR coalesce(a.step_kind, 'task') = ANY(${(kinds ?? []) as string[]}::text[]))
      AND (${f.sequenceId ?? null}::uuid IS NULL OR s.id = ${f.sequenceId ?? null}::uuid)
      AND (${when} = 'todas' OR (${when} = 'hoy' AND a.due_at < date_trunc('day', now()) + interval '1 day')
           OR (${when} = 'proximas' AND a.due_at >= date_trunc('day', now()) + interval '1 day'))
    ORDER BY (a.due_at < now()) DESC, CASE a.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, a.due_at, a.created_at
    LIMIT ${f.limit ?? 300}`;
}

export async function queueCounts(userId: string | null, all: boolean) {
  const rows = await sql<{ kind: string; n: number; overdue: number }[]>`
    SELECT coalesce(a.step_kind, 'task') AS kind, count(*)::int AS n, count(*) FILTER (WHERE a.due_at < now())::int AS overdue
    FROM sequence_enrollments e JOIN activities a ON a.enrollment_id = e.id AND NOT a.done AND a.step_kind IS NOT NULL
    WHERE e.status = 'active' AND (${all} OR a.owner_id = ${userId})
      AND a.due_at < date_trunc('day', now()) + interval '1 day'
    GROUP BY 1`;
  const out: Record<string, number> = { todas: 0 };
  for (const t of TASK_TABS) if (t.kinds) out[t.key] = rows.filter((r) => (t.kinds as readonly string[]).includes(r.kind)).reduce((n, r) => n + r.n, 0);
  out.todas = rows.reduce((n, r) => n + r.n, 0);
  return out;
}

/**
 * Marca hecha una tarea de la secuencia (con el resultado de la llamada si lo
 * hay) y la secuencia sigue al momento. Si la llamada se contestó, la regla de
 * Apollo la da por terminada.
 */
export async function completeQueueTask(actor: Actor, activityId: string, v: { outcome?: string | null; note?: string | null; skip?: boolean }) {
  if (!isId(activityId)) throw new UserError("Tarea no válida.");
  const outcome = v.outcome && ["answered", "no_answer", "voicemail", "busy", "wrong_number"].includes(v.outcome) ? v.outcome : null;
  const note = (v.note ?? "").trim().slice(0, 5000) || null;
  const [a] = await sql<{ id: string }[]>`
    UPDATE activities SET done = true, done_at = now(), call_outcome = coalesce(${outcome}, call_outcome),
           note = CASE WHEN ${note}::text IS NULL AND NOT ${Boolean(v.skip)} THEN note
                       ELSE concat_ws(E'\\n\\n', note, ${v.skip ? "Saltada en la secuencia." : null}::text, ${note}::text) END
    WHERE id = ${activityId} AND NOT done RETURNING id`;
  if (!a) throw new UserError("Esa tarea ya está hecha.");
  const { continueAfter } = await import("./sequences");
  await continueAfter(actor, activityId);
}
