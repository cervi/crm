import { sql } from "./db";
import { localNow } from "./digest";
import { listConnections, sendPlainEmail, type Connection } from "./mailbox";
import { money } from "./format";
import { notify } from "./notifications";
import { getPrefs, isQuiet, withDefaults, type NotificationPrefs } from "./notification-prefs";

// ===========================================================================
// Correos que salen según las preferencias de cada persona:
//   · avisos «al momento» (agrupados en un solo correo si llegan varios juntos)
//   · avisos «agrupados» (a las 12:00 y a las 17:00)
//   · el plan del lunes, el balance del viernes y la semana del equipo
//   · recordatorio de correos sin respuesta tras N días
// Siempre desde la cuenta conectada de la propia persona y a ella misma, y
// nunca en sus horas de silencio (lo pendiente sale al terminar).
// ===========================================================================

const appUrl = () => (process.env.APP_URL || "").replace(/\/$/, "");
const url = (p?: string | null) => (p ? (p.startsWith("http") ? p : `${appUrl()}${p}`) : "");
const TZ = () => process.env.TZ || "Europe/Madrid";
const DIGEST_HOURS = [12, 17];

/** Semana ISO («2026-W41») en la zona del CRM. */
export function isoWeek(now = new Date()) {
  const { day } = localNow(now);
  const d = new Date(`${day}T12:00:00Z`);
  const wd = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - wd + 3);
  const y = d.getUTCFullYear();
  const first = new Date(Date.UTC(y, 0, 4));
  const w = 1 + Math.round(((d.getTime() - first.getTime()) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

async function logged(userId: string, kind: string, period: string) {
  const [r] = await sql`SELECT 1 FROM summary_log WHERE user_id = ${userId} AND kind = ${kind} AND period = ${period}`;
  return Boolean(r);
}
async function log(userId: string, kind: string, period: string) {
  await sql`INSERT INTO summary_log (user_id, kind, period) VALUES (${userId}, ${kind}, ${period}) ON CONFLICT DO NOTHING`;
}

type Pending = { id: string; kind: string; title: string; body: string | null; link: string | null; email_mode: string; created_at: Date };

const hhmm = (d: Date) => new Intl.DateTimeFormat("es-ES", { timeZone: TZ(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d));

async function prepFor(link: string | null) {
  const id = link?.match(/#act-([0-9a-f-]{36})/)?.[1];
  if (!id) return null;
  const [a] = await sql<{ prep: string | null }[]>`SELECT prep FROM activities WHERE id = ${id}`;
  return a?.prep ?? null;
}

async function noticesEmail(items: Pending[], grouped: boolean) {
  const lines: string[] = [];
  for (const n of items) {
    lines.push(`• ${n.title}${grouped ? ` (${hhmm(n.created_at)})` : ""}`);
    if (n.body) lines.push(`  ${n.body}`);
    if (n.link) lines.push(`  ${url(n.link)}`);
    if (n.kind === "meeting_prep") {
      const prep = await prepFor(n.link);
      if (prep) lines.push("", prep.split("\n").map((l) => `  ${l}`).join("\n"));
    }
    lines.push("");
  }
  const subject = items.length === 1 ? items[0].title : grouped ? `Tus avisos: ${items.length} novedades` : `${items.length} avisos: ${items[0].title}`;
  const body = [...lines, `Cambia qué te llega y cuándo en ${url("/account#avisos")}`].join("\n");
  return { subject: subject.slice(0, 200), body };
}

/** Envía los avisos pendientes de una persona que tocan ahora. Devuelve cuántos correos salieron. */
async function sendNotices(conn: Connection, prefs: NotificationPrefs, now: Date): Promise<number> {
  const local = localNow(now);
  if (isQuiet(prefs, local.hour)) return 0;
  const pending = await sql<Pending[]>`
    SELECT id, kind, title, body, link, email_mode, created_at FROM notifications
    WHERE user_id = ${conn.user_id} AND email_mode IS NOT NULL AND emailed_at IS NULL AND read_at IS NULL
      AND created_at > now() - interval '3 days'
    ORDER BY created_at`;
  if (pending.length === 0) return 0;
  // ¿Toca el resumen agrupado? A partir de cada hora fija, una vez.
  const slot = [...DIGEST_HOURS].reverse().find((h) => local.hour >= h);
  const digestDue = slot !== undefined && !(await logged(conn.user_id, "notif_digest", `${local.day}T${slot}`));
  // Lo urgente sale ya; si toca el agrupado, va todo junto en un correo.
  const now_ = pending.filter((n) => n.email_mode === "now");
  const batch = digestDue ? pending : now_;
  if (batch.length === 0) return 0;
  const { subject, body } = await noticesEmail(batch, digestDue && batch.length > now_.length);
  await sendPlainEmail(conn, conn.email, subject, body);
  await sql`UPDATE notifications SET emailed_at = now() WHERE id = ANY(${batch.map((n) => n.id)}::uuid[])`;
  if (digestDue) await log(conn.user_id, "notif_digest", `${local.day}T${slot}`);
  return 1;
}

// ---------------------------------------------------------------------------
// Resúmenes semanales

export async function weekPlanEmail(userId: string) {
  const [[agenda], tasks, overdue, closing, quiet] = await Promise.all([
    sql<{ sessions: number; tasks: number }[]>`
      SELECT count(*) FILTER (WHERE t.is_session)::int AS sessions, count(*) FILTER (WHERE NOT coalesce(t.is_session, false))::int AS tasks
      FROM activities a LEFT JOIN activity_types t ON t.key = a.type
      WHERE NOT a.done AND a.owner_id = ${userId} AND a.due_at >= date_trunc('week', now()) AND a.due_at < date_trunc('week', now()) + interval '7 days'`,
    sql<{ subject: string; due_at: Date; deal_id: string | null; deal: string | null; session: boolean }[]>`
      SELECT a.subject, a.due_at, a.deal_id, d.title AS deal, coalesce(t.is_session, false) AS session
      FROM activities a LEFT JOIN deals d ON d.id = a.deal_id LEFT JOIN activity_types t ON t.key = a.type
      WHERE NOT a.done AND a.owner_id = ${userId} AND a.due_at >= date_trunc('week', now()) AND a.due_at < date_trunc('week', now()) + interval '7 days'
        AND coalesce(t.is_session, false)
      ORDER BY a.due_at LIMIT 12`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activities WHERE NOT done AND owner_id = ${userId} AND due_at < date_trunc('day', now())`,
    sql<{ id: string; title: string; value: string | null; currency: string; expected_close_date: Date }[]>`
      SELECT id, title, value::text, currency, expected_close_date FROM deals
      WHERE status = 'open' AND deleted_at IS NULL AND owner_id = ${userId}
        AND expected_close_date < (date_trunc('week', now()) + interval '14 days')::date
      ORDER BY expected_close_date, value DESC NULLS LAST LIMIT 8`,
    sql<{ id: string; title: string; value: string | null; currency: string }[]>`
      SELECT d.id, d.title, d.value::text, d.currency FROM deals d
      WHERE d.status = 'open' AND d.deleted_at IS NULL AND d.owner_id = ${userId}
        AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.deal_id = d.id AND NOT a.done)
      ORDER BY d.value DESC NULLS LAST LIMIT 8`,
  ]);
  const day = new Intl.DateTimeFormat("es-ES", { timeZone: TZ(), weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const short = new Intl.DateTimeFormat("es-ES", { timeZone: TZ(), day: "numeric", month: "short" });
  const sec = (t: string, items: string[]) => (items.length ? [t, ...items, ""] : []);
  const body = [
    `Tu semana: ${agenda.sessions} ${agenda.sessions === 1 ? "reunión" : "reuniones"} y ${agenda.tasks} ${agenda.tasks === 1 ? "tarea" : "tareas"} con fecha.`,
    overdue[0].n ? `Arrastras ${overdue[0].n} ${overdue[0].n === 1 ? "actividad vencida" : "actividades vencidas"}: despéjalas hoy (${url("/activities?period=overdue")}).` : "No arrastras nada vencido.",
    "",
    ...sec("Reuniones de la semana", tasks.map((a) => `- ${day.format(new Date(a.due_at))} · ${a.subject}${a.deal ? ` (${a.deal})` : ""}`)),
    ...sec("Deals que deberían cerrarse en estas dos semanas (o ya van tarde)", closing.map((d) => `- ${d.title} · ${money(d.value, d.currency)} · ${short.format(new Date(d.expected_close_date))} ${url(`/deals/${d.id}`)}`)),
    ...sec("Deals sin ninguna actividad programada: dales un siguiente paso", quiet.map((d) => `- ${d.title} · ${money(d.value, d.currency)} ${url(`/deals/${d.id}`)}`)),
    `Ábrelo en el CRM: ${url("/")}`,
    `Cambia qué te llega en ${url("/account#avisos")}`,
  ].join("\n");
  return { subject: `Tu semana: ${agenda.sessions} reuniones, ${closing.length} deals por cerrar, ${quiet.length} sin siguiente paso`, body };
}

type WeekStats = { owner_id: string | null; name: string | null; won: number; won_value: string; lost: number; created: number; done: number; sessions: number; sent: number };

async function weekStats(userId: string | null): Promise<WeekStats[]> {
  return sql<WeekStats[]>`
    SELECT u.id AS owner_id, u.name,
      (SELECT count(*)::int FROM deals d WHERE d.owner_id = u.id AND d.status = 'won' AND d.deleted_at IS NULL AND d.won_at >= date_trunc('week', now())) AS won,
      (SELECT coalesce(sum(value), 0)::text FROM deals d WHERE d.owner_id = u.id AND d.status = 'won' AND d.deleted_at IS NULL AND d.won_at >= date_trunc('week', now())) AS won_value,
      (SELECT count(*)::int FROM deals d WHERE d.owner_id = u.id AND d.status = 'lost' AND d.deleted_at IS NULL AND d.lost_at >= date_trunc('week', now())) AS lost,
      (SELECT count(*)::int FROM deals d WHERE d.owner_id = u.id AND d.deleted_at IS NULL AND d.created_at >= date_trunc('week', now())) AS created,
      (SELECT count(*)::int FROM activities a WHERE a.owner_id = u.id AND a.done AND a.done_at >= date_trunc('week', now())) AS done,
      (SELECT count(*)::int FROM activities a JOIN activity_types t ON t.key = a.type AND t.is_session
         WHERE a.owner_id = u.id AND a.done AND a.done_at >= date_trunc('week', now())) AS sessions,
      (SELECT count(*)::int FROM emails e WHERE e.user_id = u.id AND e.direction = 'out' AND e.status = 'sent' AND e.sent_at >= date_trunc('week', now())) AS sent
    FROM users u WHERE u.is_active AND (${userId}::uuid IS NULL OR u.id = ${userId}::uuid)
    ORDER BY u.name`;
}

export async function weekReviewEmail(userId: string) {
  const [s] = await weekStats(userId);
  const [lostDeals, moved] = await Promise.all([
    sql<{ id: string; title: string; reason: string | null }[]>`
      SELECT d.id, d.title, coalesce(r.label, d.lost_note) AS reason FROM deals d LEFT JOIN lost_reasons r ON r.id = d.lost_reason_id
      WHERE d.owner_id = ${userId} AND d.status = 'lost' AND d.deleted_at IS NULL AND d.lost_at >= date_trunc('week', now()) LIMIT 6`,
    sql<{ n: number }[]>`
      SELECT count(DISTINCT entity_id)::int AS n FROM events
      WHERE entity_type = 'deal' AND event_type = 'deal.stage_changed' AND occurred_at >= date_trunc('week', now())
        AND entity_id IN (SELECT id FROM deals WHERE owner_id = ${userId})`,
  ]);
  const plan = await weekPlanEmail(userId);
  const body = [
    "Así ha ido tu semana:",
    `- Ganados: ${s?.won ?? 0} (${money(s?.won_value ?? 0)})`,
    `- Perdidos: ${s?.lost ?? 0}`,
    `- Deals nuevos: ${s?.created ?? 0} · deals que avanzaron de fase: ${moved[0]?.n ?? 0}`,
    `- Actividades hechas: ${s?.done ?? 0} (${s?.sessions ?? 0} reuniones o llamadas)`,
    `- Correos enviados: ${s?.sent ?? 0}`,
    "",
    ...(lostDeals.length ? ["Perdidos esta semana", ...lostDeals.map((d) => `- ${d.title}${d.reason ? ` — ${d.reason}` : ""}`), ""] : []),
    "Para dejar la semana que viene preparada:",
    ...plan.body.split("\n").filter((l) => l.startsWith("- ") || l.startsWith("Deals sin")).slice(0, 10),
    "",
    `Informes: ${url("/reports")}`,
  ].join("\n");
  return { subject: `Tu semana: ${s?.won ?? 0} ganados (${money(s?.won_value ?? 0)}), ${s?.done ?? 0} actividades, ${s?.sent ?? 0} correos`, body };
}

export async function teamWeekEmail() {
  const rows = (await weekStats(null)).filter((r) => r.won || r.lost || r.created || r.done || r.sent);
  const [[pipe], [stale]] = await Promise.all([
    sql<{ n: number; v: string }[]>`SELECT count(*)::int AS n, coalesce(sum(value), 0)::text AS v FROM deals WHERE status = 'open' AND deleted_at IS NULL`,
    sql<{ n: number }[]>`SELECT count(*)::int AS n FROM deals d WHERE d.status = 'open' AND d.deleted_at IS NULL
                           AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.deal_id = d.id AND NOT a.done)`,
  ]);
  const won = rows.reduce((a, r) => a + Number(r.won_value), 0);
  const body = [
    `El equipo la semana pasada (y lo que va de esta):`,
    "",
    ...rows.map((r) => `- ${r.name}: ${r.won} ganados (${money(r.won_value)}), ${r.lost} perdidos, ${r.created} nuevos, ${r.done} actividades, ${r.sent} correos`),
    "",
    `Pipeline abierto: ${pipe.n} deals · ${money(pipe.v)}`,
    `Deals sin siguiente paso: ${stale.n}`,
    "",
    `Informes: ${url("/reports")}`,
  ].join("\n");
  return { subject: `El equipo: ${rows.reduce((a, r) => a + r.won, 0)} ganados (${money(won)}), pipeline ${money(pipe.v)}`, body };
}

/** Lunes: el plan; viernes desde las 16:00: el balance. Lunes también el del equipo. */
async function sendWeekly(conn: Connection, prefs: NotificationPrefs, now: Date, digestHour: number): Promise<number> {
  const local = localNow(now), week = isoWeek(now);
  if (isQuiet(prefs, local.hour)) return 0;
  let sent = 0;
  const once = async (kind: string, build: () => Promise<{ subject: string; body: string }>) => {
    if (await logged(conn.user_id, kind, week)) return;
    await log(conn.user_id, kind, week);      // primero se apunta: si falla, no se reintenta en bucle
    const { subject, body } = await build();
    await sendPlainEmail(conn, conn.email, subject, body);
    sent++;
  };
  if (local.weekday === 1 && local.hour >= digestHour) {
    if (prefs.weekPlan) await once("week_plan", () => weekPlanEmail(conn.user_id));
    if (prefs.teamWeek) await once("team_week", teamWeekEmail);
  }
  if (local.weekday === 5 && local.hour >= 16 && prefs.weekReview) await once("week_review", () => weekReviewEmail(conn.user_id));
  return sent;
}

// ---------------------------------------------------------------------------
// Correos sin respuesta

/** Crea el aviso «sin respuesta» de los correos que llevan N días sin contestar (no los de secuencias). */
async function noReplyReminders(userId: string, days: number): Promise<number> {
  if (!days) return 0;
  const rows = await sql<{ id: string; subject: string; who: string | null; deal_id: string | null; deal: string | null; open_count: number }[]>`
    SELECT e.id, e.subject, coalesce(p.full_name, e.to_name, e.to_email) AS who, e.deal_id, d.title AS deal, e.open_count
    FROM emails e LEFT JOIN persons p ON p.id = e.person_id LEFT JOIN deals d ON d.id = e.deal_id
    WHERE e.user_id = ${userId} AND e.direction = 'out' AND e.status = 'sent' AND e.sequence_step_id IS NULL
      AND (e.deal_id IS NULL OR d.status = 'open')
      AND e.sent_at < now() - make_interval(days => ${days}) AND e.sent_at > now() - make_interval(days => ${days + 3})
      AND NOT EXISTS (SELECT 1 FROM emails r WHERE r.direction = 'in' AND r.sent_at > e.sent_at
                        AND (r.person_id = e.person_id OR lower(r.from_email) = lower(e.to_email)))
      AND NOT EXISTS (SELECT 1 FROM emails o WHERE o.direction = 'out' AND o.sent_at > e.sent_at AND o.person_id = e.person_id)
      AND NOT EXISTS (SELECT 1 FROM summary_log l WHERE l.user_id = ${userId} AND l.kind = 'no_reply' AND l.period = e.id::text)
    ORDER BY e.sent_at LIMIT 10`;
  for (const r of rows) {
    await log(userId, "no_reply", r.id);
    const seen = r.open_count > 0 ? `Lo abrió ${r.open_count} ${r.open_count === 1 ? "vez" : "veces"}, pero no ha contestado.` : "No consta que lo haya abierto.";
    await notify(sql, { userId, kind: "no_reply", title: `${r.who ?? "El contacto"} no ha respondido a «${r.subject || "(sin asunto)"}» en ${days} días`,
                        body: `${seen}${r.deal ? ` Deal: ${r.deal}.` : ""}`, link: r.deal_id ? `/deals/${r.deal_id}` : `/emails/${r.id}` });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------

/** Lo llama el ciclo de automatizaciones (cada pocos minutos). */
export async function sendNotificationMail(now = new Date(), digestHour = 8): Promise<number> {
  const conns = (await listConnections()).filter((c) => c.status === "active");
  const users = await sql<{ id: string; role: string; notification_prefs: Partial<NotificationPrefs> }[]>`
    SELECT id, role, notification_prefs FROM users WHERE is_active`;
  let sent = 0;
  for (const u of users) {
    const prefs = withDefaults(u.notification_prefs, u.role);
    try { await noReplyReminders(u.id, prefs.noReplyDays); } catch (err) { console.error("[sin respuesta]", err); }
    const conn = conns.find((c) => c.user_id === u.id);
    if (!conn) continue;
    try {
      sent += await sendNotices(conn, prefs, now);
      sent += await sendWeekly(conn, prefs, now, digestHour);
    } catch (err) {
      console.error("[avisos por correo]", conn.email, err);
    }
  }
  return sent;
}

export { getPrefs };
