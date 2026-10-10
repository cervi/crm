import { sql } from "./db";

// ===========================================================================
// Informe de seguimiento: cómo responden los clientes a los correos, qué
// documentos miran y cuánto tardan en firmar. Últimos 90 días.
// ===========================================================================

export async function engagementReport(ownerId: string | null = null) {
  const [byOwner, weekly, docs, [sign], fastest] = await Promise.all([
    sql<{ name: string; sent: number; opened: number; replied: number }[]>`
      SELECT u.name, count(*)::int AS sent, count(*) FILTER (WHERE e.track AND e.open_count > 0)::int AS opened,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emails r WHERE r.direction = 'in' AND r.person_id = e.person_id AND r.sent_at > e.sent_at AND r.sent_at < e.sent_at + interval '14 days'))::int AS replied
      FROM emails e JOIN users u ON u.id = e.user_id
      WHERE e.direction = 'out' AND e.status = 'sent' AND e.sent_at > now() - interval '90 days' AND e.person_id IS NOT NULL
        AND (${ownerId}::uuid IS NULL OR e.user_id = ${ownerId}::uuid)
      GROUP BY u.name HAVING count(*) >= 3 ORDER BY sent DESC LIMIT 12`,
    sql<{ week: string; sent: number; opened: number; replied: number }[]>`
      SELECT to_char(w, 'IYYY-"S"IW') AS week,
             count(e.id)::int AS sent, count(e.id) FILTER (WHERE e.track AND e.open_count > 0)::int AS opened,
             count(e.id) FILTER (WHERE EXISTS (SELECT 1 FROM emails r WHERE r.direction = 'in' AND r.person_id = e.person_id AND r.sent_at > e.sent_at AND r.sent_at < e.sent_at + interval '14 days'))::int AS replied
      FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') w
      LEFT JOIN emails e ON e.direction = 'out' AND e.status = 'sent' AND e.person_id IS NOT NULL AND e.sent_at >= w AND e.sent_at < w + interval '1 week'
        AND (${ownerId}::uuid IS NULL OR e.user_id = ${ownerId}::uuid)
      GROUP BY w ORDER BY w`,
    sql<{ name: string; shared: number; opened: number; views: number; seconds: number }[]>`
      SELECT coalesce(i.name, f.name) AS name, count(l.id)::int AS shared, count(l.id) FILTER (WHERE l.view_count > 0)::int AS opened,
             coalesce(sum(l.view_count), 0)::int AS views, coalesce(sum(l.seconds), 0)::int AS seconds
      FROM doc_links l LEFT JOIN library_items i ON i.id = l.library_id LEFT JOIN files f ON f.id = l.file_id
      WHERE l.created_at > now() - interval '90 days' AND (${ownerId}::uuid IS NULL OR l.created_by = ${ownerId}::uuid)
      GROUP BY 1 ORDER BY views DESC, shared DESC LIMIT 10`.catch(() => []),
    sql<{ sent: number; completed: number; pending: number; declined: number; avg_days: number | null }[]>`
      SELECT count(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sent, count(*) FILTER (WHERE status = 'completed')::int AS completed,
             count(*) FILTER (WHERE status = 'sent')::int AS pending, count(*) FILTER (WHERE status IN ('declined', 'expired'))::int AS declined,
             avg(extract(epoch FROM completed_at - sent_at) / 86400) FILTER (WHERE status = 'completed')::float8 AS avg_days
      FROM sign_requests WHERE coalesce(sent_at, created_at) > now() - interval '90 days'
        AND (${ownerId}::uuid IS NULL OR coalesce(sender_id, created_by) = ${ownerId}::uuid)`.catch(() => [{ sent: 0, completed: 0, pending: 0, declined: 0, avg_days: null }]),
    sql<{ hour: number; sent: number; replies: number }[]>`
      SELECT extract(hour FROM (e.sent_at AT TIME ZONE ${process.env.TZ || "Europe/Madrid"}))::int AS hour, count(*)::int AS sent,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emails r WHERE r.direction = 'in' AND r.person_id = e.person_id AND r.sent_at > e.sent_at AND r.sent_at < e.sent_at + interval '3 days'))::int AS replies
      FROM emails e WHERE e.direction = 'out' AND e.status = 'sent' AND e.sent_at > now() - interval '180 days' AND e.person_id IS NOT NULL
        AND (${ownerId}::uuid IS NULL OR e.user_id = ${ownerId}::uuid)
      GROUP BY 1 HAVING count(*) >= 5 ORDER BY 1`,
  ]);
  return { byOwner, weekly, docs, sign, replyHours: fastest };
}
