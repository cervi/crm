import { sql } from "./db";

// ===========================================================================
// Informes de secuencias (como los de Apollo): lista con métricas, embudo por
// contacto y por correo, resultados por paso, buzón y público, y analítica
// del equipo.
// ===========================================================================

export type SequenceRow = {
  id: string; name: string; description: string | null; folder: string | null; is_active: boolean; archived_at: Date | null;
  owner_name: string | null; steps: number; channels: string[]; active: number; paused: number; finished: number; bounced: number; failed: number;
  total: number; delivered: number; opened: number; replied: number; interested: number; created_at: Date; is_example: boolean;
};

/** Personas que respondieron (sin contar «fuera de la oficina» ni rebotes) después de entrar. */
const REPLIED = sql`EXISTS (SELECT 1 FROM emails r WHERE r.person_id = e.person_id AND r.direction = 'in' AND r.sent_at > e.created_at
                      AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce')`;
const INTERESTED = sql`EXISTS (SELECT 1 FROM emails r WHERE r.person_id = e.person_id AND r.direction = 'in' AND r.sent_at > e.created_at
                      AND r.reply_class = 'interesado')`;

export async function listSequencesFull(f: { archived?: boolean; folder?: string | null; q?: string | null; status?: "active" | "paused" | null } = {}) {
  const q = (f.q ?? "").trim().toLowerCase();
  return sql<SequenceRow[]>`
    SELECT s.id, s.name, s.description, s.folder, s.is_active, s.archived_at, u.name AS owner_name, s.created_at, s.example IS NOT NULL AS is_example,
           (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS steps,
           coalesce((SELECT array_agg(DISTINCT CASE WHEN st.kind IN ('email', 'manual_email') THEN 'email' WHEN st.kind = 'call' THEN 'call'
                                              WHEN st.kind LIKE 'linkedin%' THEN 'linkedin' ELSE 'task' END)
                     FROM sequence_steps st WHERE st.sequence_id = s.id), '{}') AS channels,
           count(e.id) FILTER (WHERE e.status = 'active')::int AS active,
           count(e.id) FILTER (WHERE e.status = 'paused')::int AS paused,
           count(e.id) FILTER (WHERE e.status IN ('completed', 'stopped'))::int AS finished,
           count(e.id) FILTER (WHERE EXISTS (SELECT 1 FROM emails m WHERE m.enrollment_id = e.id AND m.bounced))::int AS bounced,
           count(e.id) FILTER (WHERE e.status = 'failed')::int AS failed,
           count(e.id) FILTER (WHERE e.status <> 'removed')::int AS total,
           count(e.id) FILTER (WHERE EXISTS (SELECT 1 FROM emails m WHERE m.enrollment_id = e.id AND m.direction = 'out' AND m.status = 'sent' AND NOT coalesce(m.bounced, false)))::int AS delivered,
           count(e.id) FILTER (WHERE EXISTS (SELECT 1 FROM emails m WHERE m.enrollment_id = e.id AND m.open_count > 0))::int AS opened,
           count(e.id) FILTER (WHERE ${REPLIED})::int AS replied,
           count(e.id) FILTER (WHERE ${INTERESTED})::int AS interested
    FROM sequences s
    LEFT JOIN users u ON u.id = coalesce(s.owner_id, s.created_by)
    LEFT JOIN sequence_enrollments e ON e.sequence_id = s.id
    WHERE (s.archived_at IS NOT NULL) = ${Boolean(f.archived)}
      AND (${f.folder ?? null}::text IS NULL OR s.folder = ${f.folder ?? null}::text)
      AND (${q} = '' OR lower(s.name) LIKE ${`%${q}%`})
      AND (${f.status ?? null}::text IS NULL OR s.is_active = (${f.status ?? null}::text = 'active'))
    GROUP BY s.id, u.name
    ORDER BY s.is_active DESC, s.created_at DESC`;
}

export async function sequenceFolders(): Promise<{ folder: string; n: number }[]> {
  return sql`SELECT folder, count(*)::int AS n FROM sequences WHERE folder IS NOT NULL AND archived_at IS NULL GROUP BY folder ORDER BY lower(folder)`;
}

export type SequenceReport = {
  status: { active: number; paused: number; finished: number; bounced: number; failed: number; removed: number; scheduled: number };
  contacts: { total: number; contacted: number; delivered: number; opened: number; replied: number; interested: number; unsubscribed: number };
  emails: { sent: number; bounced: number; opened: number; clicked: number; replied: number };
  tasks: { pending: number; done: number; calls_answered: number };
  byMailbox: { email: string; sent: number; opened: number; replied: number; bounced: number }[];
  byTitle: { label: string; contacts: number; replied: number; interested: number }[];
  byIndustry: { label: string; contacts: number; replied: number; interested: number }[];
};

export async function sequenceReport(id: string): Promise<SequenceReport> {
  const [st] = await sql<SequenceReport["status"][]>`
    SELECT count(*) FILTER (WHERE status = 'active')::int AS active, count(*) FILTER (WHERE status = 'paused')::int AS paused,
           count(*) FILTER (WHERE status IN ('completed', 'stopped'))::int AS finished,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emails m WHERE m.enrollment_id = e.id AND m.bounced))::int AS bounced,
           count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'removed')::int AS removed,
           count(*) FILTER (WHERE status = 'active' AND next_run_at IS NOT NULL AND waiting_activity_id IS NULL)::int AS scheduled
    FROM sequence_enrollments e WHERE sequence_id = ${id}`;
  const [ct] = await sql<SequenceReport["contacts"][]>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emails m WHERE m.enrollment_id = e.id AND m.direction = 'out' AND m.status = 'sent'))::int AS contacted,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emails m WHERE m.enrollment_id = e.id AND m.direction = 'out' AND m.status = 'sent' AND NOT coalesce(m.bounced, false)))::int AS delivered,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emails m WHERE m.enrollment_id = e.id AND m.open_count > 0))::int AS opened,
           count(*) FILTER (WHERE ${REPLIED})::int AS replied,
           count(*) FILTER (WHERE ${INTERESTED})::int AS interested,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM persons p WHERE p.id = e.person_id AND p.unsubscribed_at > e.created_at))::int AS unsubscribed
    FROM sequence_enrollments e WHERE sequence_id = ${id} AND status <> 'removed'`;
  const [em] = await sql<SequenceReport["emails"][]>`
    SELECT count(*)::int AS sent, count(*) FILTER (WHERE m.bounced)::int AS bounced,
           count(*) FILTER (WHERE m.open_count > 0)::int AS opened, count(*) FILTER (WHERE m.click_count > 0)::int AS clicked,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emails r WHERE r.person_id = m.person_id AND r.direction = 'in' AND r.sent_at > m.sent_at
             AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce'
             AND NOT EXISTS (SELECT 1 FROM emails m2 WHERE m2.enrollment_id = m.enrollment_id AND m2.direction = 'out' AND m2.sent_at > m.sent_at AND m2.sent_at < r.sent_at)))::int AS replied
    FROM emails m JOIN sequence_enrollments e ON e.id = m.enrollment_id
    WHERE e.sequence_id = ${id} AND m.direction = 'out' AND m.status = 'sent'`;
  const [tk] = await sql<SequenceReport["tasks"][]>`
    SELECT count(*) FILTER (WHERE NOT a.done)::int AS pending, count(*) FILTER (WHERE a.done)::int AS done,
           count(*) FILTER (WHERE a.call_outcome = 'answered')::int AS calls_answered
    FROM activities a JOIN sequence_enrollments e ON e.id = a.enrollment_id
    WHERE e.sequence_id = ${id} AND a.step_kind IS NOT NULL AND a.step_kind <> 'manual_email'`;
  const byMailbox = await sql<SequenceReport["byMailbox"]>`
    SELECT m.from_email AS email, count(*)::int AS sent, count(*) FILTER (WHERE m.open_count > 0)::int AS opened,
           count(*) FILTER (WHERE m.bounced)::int AS bounced,
           count(DISTINCT m.person_id) FILTER (WHERE EXISTS (SELECT 1 FROM emails r WHERE r.person_id = m.person_id AND r.direction = 'in' AND r.sent_at > m.sent_at
             AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce'))::int AS replied
    FROM emails m JOIN sequence_enrollments e ON e.id = m.enrollment_id
    WHERE e.sequence_id = ${id} AND m.direction = 'out' AND m.status = 'sent'
    GROUP BY m.from_email ORDER BY sent DESC`;
  const audience = (label: ReturnType<typeof sql>) => sql<{ label: string; contacts: number; replied: number; interested: number }[]>`
    SELECT coalesce(nullif(trim(x.label), ''), 'Sin dato') AS label, count(*)::int AS contacts,
           count(*) FILTER (WHERE ${REPLIED})::int AS replied, count(*) FILTER (WHERE ${INTERESTED})::int AS interested
    FROM sequence_enrollments e
    LEFT JOIN LATERAL (SELECT po.job_title, o.industry, o.employee_count FROM person_organizations po LEFT JOIN organizations o ON o.id = po.organization_id
                       WHERE po.person_id = e.person_id AND po.status = 'current' ORDER BY po.created_at DESC LIMIT 1) po ON true
    CROSS JOIN LATERAL (SELECT ${label} AS label) x
    WHERE e.sequence_id = ${id} AND e.status <> 'removed'
    GROUP BY 1 ORDER BY contacts DESC LIMIT 8`;
  const [byTitle, byIndustry] = await Promise.all([audience(sql`po.job_title`), audience(sql`po.industry`)]);
  return { status: st, contacts: ct, emails: em, tasks: tk, byMailbox, byTitle, byIndustry };
}

export type SequenceEmail = {
  id: string; kind: "scheduled" | "sent"; person_id: string; person_name: string; to: string | null; subject: string | null; step: number | null;
  at: Date | null; from_email: string | null; opened: boolean; clicked: boolean; replied: boolean; bounced: boolean; open_count: number;
};

/** Correos de la secuencia: los que van a salir (programados) y los enviados con su estado. */
export async function sequenceEmails(id: string, view: "scheduled" | "sent", filter?: string | null): Promise<SequenceEmail[]> {
  if (view === "scheduled") {
    return sql<SequenceEmail[]>`
      SELECT e.id, 'scheduled' AS kind, e.person_id, p.full_name AS person_name,
             (SELECT email FROM person_emails WHERE person_id = p.id AND bounced_at IS NULL ORDER BY is_primary DESC LIMIT 1) AS to,
             nullif(st.subject, '') AS subject, st.position AS step, e.next_run_at AS at,
             coalesce(mb.email, (SELECT email FROM mailbox_connections WHERE user_id = e.user_id AND purpose = 'main' LIMIT 1)) AS from_email,
             false AS opened, false AS clicked, false AS replied, false AS bounced, 0 AS open_count
      FROM sequence_enrollments e
      JOIN persons p ON p.id = e.person_id
      JOIN sequence_steps st ON st.sequence_id = e.sequence_id AND st.position = e.next_step + 1 AND st.kind = 'email' AND st.is_active
      LEFT JOIN mailbox_connections mb ON mb.id = e.mailbox_id
      WHERE e.sequence_id = ${id} AND e.status = 'active' AND e.next_run_at IS NOT NULL
      ORDER BY e.next_run_at LIMIT 300`;
  }
  const f = filter ?? "";
  return sql<SequenceEmail[]>`
    SELECT * FROM (
      SELECT m.id, 'sent' AS kind, m.person_id, p.full_name AS person_name, m.to_email AS to, m.subject, st.position AS step, m.sent_at AS at, m.from_email,
             m.open_count > 0 AS opened, m.click_count > 0 AS clicked, coalesce(m.bounced, false) AS bounced, m.open_count,
             EXISTS (SELECT 1 FROM emails r WHERE r.person_id = m.person_id AND r.direction = 'in' AND r.sent_at > m.sent_at
                       AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce') AS replied
      FROM emails m JOIN sequence_enrollments e ON e.id = m.enrollment_id JOIN persons p ON p.id = m.person_id
      LEFT JOIN sequence_steps st ON st.id = m.sequence_step_id
      WHERE e.sequence_id = ${id} AND m.direction = 'out' AND m.status = 'sent') x
    WHERE (${f} = '' OR (${f} = 'abiertos' AND opened) OR (${f} = 'sin_abrir' AND NOT opened AND NOT bounced) OR (${f} = 'clics' AND clicked)
           OR (${f} = 'respondidos' AND replied) OR (${f} = 'rebotados' AND bounced))
    ORDER BY at DESC LIMIT 300`;
}

// ---------------------------------------------------------------------------
// Analítica del equipo

export type WeekPoint = { week: string; sent: number; replied: number; opened: number };

export async function teamAnalytics(days = 90) {
  const since = new Date(Date.now() - days * 86400000);
  const weeks = await sql<WeekPoint[]>`
    SELECT to_char(date_trunc('week', m.sent_at), 'YYYY-MM-DD') AS week, count(*)::int AS sent,
           count(*) FILTER (WHERE m.open_count > 0)::int AS opened,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emails r WHERE r.person_id = m.person_id AND r.direction = 'in' AND r.sent_at > m.sent_at
             AND r.sent_at < m.sent_at + interval '14 days' AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce'))::int AS replied
    FROM emails m WHERE m.enrollment_id IS NOT NULL AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at >= ${since}
    GROUP BY 1 ORDER BY 1`;
  const byUser = await sql<{ name: string; enrolled: number; sent: number; replied: number; interested: number; tasks_done: number }[]>`
    SELECT u.name,
           (SELECT count(*)::int FROM sequence_enrollments e WHERE e.user_id = u.id AND e.created_at >= ${since}) AS enrolled,
           (SELECT count(*)::int FROM emails m WHERE m.user_id = u.id AND m.enrollment_id IS NOT NULL AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at >= ${since}) AS sent,
           (SELECT count(*)::int FROM sequence_enrollments e WHERE e.user_id = u.id AND e.created_at >= ${since} AND ${REPLIED}) AS replied,
           (SELECT count(*)::int FROM sequence_enrollments e WHERE e.user_id = u.id AND e.created_at >= ${since} AND ${INTERESTED}) AS interested,
           (SELECT count(*)::int FROM activities a WHERE a.owner_id = u.id AND a.enrollment_id IS NOT NULL AND a.done AND a.done_at >= ${since}) AS tasks_done
    FROM users u WHERE u.kind = 'human' AND u.is_active
    ORDER BY sent DESC`;
  const steps = await sql<{ sequence_id: string; sequence: string; position: number; kind: string; subject: string | null; sent: number; opened: number; replied: number }[]>`
    SELECT s.id AS sequence_id, s.name AS sequence, st.position, st.kind, nullif(st.subject, '') AS subject, count(m.id)::int AS sent,
           count(m.id) FILTER (WHERE m.open_count > 0)::int AS opened,
           count(m.id) FILTER (WHERE EXISTS (SELECT 1 FROM emails r WHERE r.person_id = m.person_id AND r.direction = 'in' AND r.sent_at > m.sent_at
             AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce'
             AND NOT EXISTS (SELECT 1 FROM emails m2 WHERE m2.enrollment_id = m.enrollment_id AND m2.direction = 'out' AND m2.sent_at > m.sent_at AND m2.sent_at < r.sent_at)))::int AS replied
    FROM emails m JOIN sequence_steps st ON st.id = m.sequence_step_id JOIN sequences s ON s.id = st.sequence_id
    WHERE m.direction = 'out' AND m.status = 'sent' AND m.sent_at >= ${since}
    GROUP BY s.id, s.name, st.position, st.kind, st.subject HAVING count(m.id) >= 5
    ORDER BY (count(m.id) FILTER (WHERE m.open_count > 0))::float / count(m.id) DESC LIMIT 10`;
  return { weeks, byUser, steps };
}
