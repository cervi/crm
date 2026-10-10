import { sql } from "./db";
import { generate } from "./ai";
import { dealSignals, nextStep, type NextStep, type Signals } from "./briefs";
import { listConnections, sendPlainEmail } from "./mailbox";
import { UserError } from "./errors";
import { activityLabel, isSessionType, money } from "./format";
import { activityTypes } from "./activity-types";
import { healthMovers } from "./health";
import { AGENT_INFO, AGENT_KEYS } from "./agent-jobs";

// ===========================================================================
// Parte del día: lo que hay que decidir, la agenda, lo vencido, los deals que
// piden atención (con su siguiente paso), lo que hizo la IA y lo que entró.
// Se ve en la página «Hoy» y llega por correo a quien tenga su cuenta conectada.
// ===========================================================================

const TZ = () => process.env.TZ || "Europe/Madrid";

export type DigestSettings = { enabled: boolean; hour: number; days: number[] };

export async function getDigestSettings(): Promise<DigestSettings> {
  const [s] = await sql<{ digest_enabled: boolean; digest_hour: number; digest_days: number[] }[]>`
    SELECT digest_enabled, digest_hour, digest_days FROM automation_settings`;
  return { enabled: s?.digest_enabled ?? true, hour: s?.digest_hour ?? 8, days: s?.digest_days ?? [1, 2, 3, 4, 5] };
}

export async function saveDigestSettings(data: Record<string, unknown>) {
  const hour = Number(data.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new UserError("Hora no válida.");
  const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => data[`day_${d}`] === "on");
  if (data.enabled === "on" && days.length === 0) throw new UserError("Elige al menos un día.");
  await sql`UPDATE automation_settings SET digest_enabled = ${data.enabled === "on"}, digest_hour = ${hour},
                   digest_days = ${days.length ? days : [1, 2, 3, 4, 5]}::int[]`;
}

/** Fecha, hora y día de la semana (1 = lunes) en la zona horaria del CRM. */
export function localNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(now).map((x) => [x.type, x.value]));
  const weekday = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday as string] ?? 1;
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), weekday };
}

export type DigestItem = { title: string; detail?: string | null; href?: string; at?: Date | null; tone?: "bad" | "good" | null };
export type AttentionItem = { deal: Signals; step: NextStep };

export type Digest = {
  ownerId: string | null;
  ownerName: string | null;
  date: Date;
  focus: string;
  focusSource: "ai" | "rules";
  decisions: { count: number; items: DigestItem[] };
  agenda: DigestItem[];
  tasks: DigestItem[];
  overdue: DigestItem[];
  attention: AttentionItem[];
  aiDone: { count: number; items: DigestItem[] };
  leads: { count: number; items: DigestItem[] };
  closed: DigestItem[];
  pipeline: { count: number; value: number };
  /** Deals cuya salud ha cambiado 10 puntos o más desde ayer. */
  movers: { id: string; title: string; score: number; before: number; why: string | null }[];
  /** Correos abiertos recientemente sin respuesta: buen momento para llamar. */
  hotOpens: DigestItem[];
  /** Lo hecho por cada agente en 24 h (el resumen del jefe de agentes). */
  agents: { name: string; done: number; pending: number }[];
};

/**
 * Construye el parte. `ai`: «cached» usa el enfoque de la IA de hoy si ya
 * existe; «generate» además lo pide si falta (tarda unos segundos).
 */
export async function buildDigest(ownerId: string | null, opts: { ai?: "cached" | "generate" } = {}): Promise<Digest> {
  const byOwner = (col: ReturnType<typeof sql.unsafe>) => (ownerId ? sql`${col} = ${ownerId}` : sql`true`);
  await activityTypes();
  const [owner] = ownerId ? await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${ownerId}` : [];

  const [signals, decisions, agenda, overdue, aiDone, leads, closed, [pipeline]] = await Promise.all([
    dealSignals(byOwner(sql.unsafe("ods.owner_id"))),
    sql<{ id: string; title: string; deal_id: string | null; deal_title: string | null; n: number }[]>`
      SELECT x.id, x.title, x.deal_id, d.title AS deal_title, count(*) OVER ()::int AS n
      FROM automation_actions x LEFT JOIN deals d ON d.id = x.deal_id
      WHERE x.status = 'pending' AND (${ownerId}::uuid IS NULL OR d.owner_id = ${ownerId}::uuid OR x.deal_id IS NULL)
      ORDER BY x.created_at LIMIT 6`,
    sql<{ subject: string; type: string; due_at: Date; deal_id: string | null; deal_title: string | null; person: string | null; meeting_url: string | null }[]>`
      SELECT a.subject, a.type, a.due_at, a.deal_id, d.title AS deal_title, p.full_name AS person, a.meeting_url
      FROM activities a LEFT JOIN deals d ON d.id = a.deal_id LEFT JOIN persons p ON p.id = a.person_id
      WHERE NOT a.done AND a.due_at >= date_trunc('day', now()) AND a.due_at < date_trunc('day', now()) + interval '1 day'
        AND ${byOwner(sql.unsafe("a.owner_id"))}
      ORDER BY a.due_at LIMIT 60`,
    sql<{ subject: string; type: string; due_at: Date; deal_id: string | null; deal_title: string | null }[]>`
      SELECT a.subject, a.type, a.due_at, a.deal_id, d.title AS deal_title
      FROM activities a LEFT JOIN deals d ON d.id = a.deal_id
      WHERE NOT a.done AND a.due_at < date_trunc('day', now()) AND ${byOwner(sql.unsafe("a.owner_id"))}
      ORDER BY a.due_at DESC LIMIT 10`,
    sql<{ title: string; mode: string; deal_id: string | null; n: number }[]>`
      SELECT x.title, x.mode, x.deal_id, count(*) OVER ()::int AS n
      FROM automation_actions x LEFT JOIN deals d ON d.id = x.deal_id
      WHERE x.status = 'done' AND x.executed_at > now() - interval '24 hours'
        AND (${ownerId}::uuid IS NULL OR d.owner_id = ${ownerId}::uuid OR x.deal_id IS NULL)
      ORDER BY x.executed_at DESC LIMIT 5`,
    sql<{ id: string; title: string; source: string | null; funnel_stage: string | null; n: number }[]>`
      SELECT l.id, l.title, l.source, l.funnel_stage, count(*) OVER ()::int AS n FROM leads l
      WHERE l.created_at > now() - interval '24 hours' AND l.deleted_at IS NULL
      ORDER BY l.created_at DESC LIMIT 5`,
    sql<{ id: string; title: string; status: string; value: string | null; currency: string }[]>`
      SELECT d.id, d.title, d.status, d.value::text, d.currency FROM deals d
      WHERE d.deleted_at IS NULL AND ((d.status = 'won' AND d.won_at > now() - interval '24 hours')
                                   OR (d.status = 'lost' AND d.lost_at > now() - interval '24 hours'))
        AND ${byOwner(sql.unsafe("d.owner_id"))}
      ORDER BY coalesce(d.won_at, d.lost_at) DESC LIMIT 10`,
    sql<{ count: number; value: string }[]>`
      SELECT count(*)::int AS count, coalesce(sum(value), 0)::text AS value FROM open_deals_status ods WHERE ${byOwner(sql.unsafe("ods.owner_id"))}`,
  ]);

  const agentRows = await sql<{ agent: string; done: number; pending: number }[]>`
    SELECT r.agent, count(*) FILTER (WHERE x.status = 'done' AND x.executed_at > now() - interval '24 hours')::int AS done,
           count(*) FILTER (WHERE x.status = 'pending')::int AS pending
    FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id LEFT JOIN deals d ON d.id = x.deal_id
    WHERE r.agent IS NOT NULL AND (${ownerId}::uuid IS NULL OR d.owner_id = ${ownerId}::uuid OR x.deal_id IS NULL)
    GROUP BY r.agent`;
  const [movers, hotOpens] = await Promise.all([
    healthMovers(ownerId).catch(() => []),
    sql<{ id: string; subject: string; who: string | null; deal_title: string | null; opens: number; last: Date }[]>`
      SELECT e.id, e.subject, coalesce(p.full_name, e.to_name, e.to_email) AS who, d.title AS deal_title,
             count(o.id)::int AS opens, max(o.at) AS last
      FROM emails e JOIN email_opens o ON o.email_id = e.id AND NOT o.automatic AND o.at > now() - interval '48 hours'
      LEFT JOIN persons p ON p.id = e.person_id LEFT JOIN deals d ON d.id = e.deal_id
      WHERE e.direction = 'out' AND (${ownerId}::uuid IS NULL OR e.user_id = ${ownerId}::uuid)
        AND NOT EXISTS (SELECT 1 FROM emails r WHERE r.direction = 'in' AND r.sent_at > e.sent_at
                          AND (r.person_id = e.person_id OR lower(r.from_email) = lower(e.to_email)))
      GROUP BY e.id, p.full_name, d.title
      ORDER BY count(o.id) DESC, max(o.at) DESC LIMIT 6`,
  ]);

  const attention = signals
    .map((deal) => ({ deal, step: nextStep(deal) }))
    .filter((a) => a.step.priority <= 2)
    .sort((a, b) => a.step.priority - b.step.priority || Number(b.deal.value ?? 0) - Number(a.deal.value ?? 0))
    .slice(0, 8);

  const d: Digest = {
    ownerId, ownerName: owner?.name ?? null, date: new Date(),
    focus: "", focusSource: "rules",
    decisions: { count: decisions[0]?.n ?? 0, items: decisions.map((x) => ({ title: x.title, detail: x.deal_title, href: x.deal_id ? `/deals/${x.deal_id}` : "/inbox" })) },
    // Agenda: las sesiones con hora. Las tareas del día van aparte.
    agenda: agenda.filter((a) => isSessionType(a.type)).map((a) => ({ title: `${activityLabel(a.type)}: ${a.subject}`, detail: [a.deal_title, a.person].filter(Boolean).join(" · ") || null,
                                 href: a.deal_id ? `/deals/${a.deal_id}` : undefined, at: a.due_at })),
    tasks: agenda.filter((a) => !isSessionType(a.type)).map((a) => ({
      title: a.subject, detail: a.deal_title, href: a.deal_id ? `/deals/${a.deal_id}` : "/activities", at: a.due_at })),
    overdue: overdue.map((a) => ({ title: a.subject, detail: a.deal_title, href: a.deal_id ? `/deals/${a.deal_id}` : "/activities", at: a.due_at, tone: "bad" as const })),
    attention,
    aiDone: { count: aiDone[0]?.n ?? 0, items: aiDone.map((x) => ({ title: x.title, detail: x.mode === "auto" ? "Lo hizo sola" : "Aprobada por ti", href: x.deal_id ? `/deals/${x.deal_id}` : undefined })) },
    leads: { count: leads[0]?.n ?? 0, items: leads.map((l) => ({ title: l.title, detail: [l.source, l.funnel_stage?.toUpperCase()].filter(Boolean).join(" · ") || null, href: `/leads/${l.id}` })) },
    closed: closed.map((c) => ({ title: c.title, detail: `${c.status === "won" ? "Ganado" : "Perdido"} · ${money(c.value, c.currency)}`, href: `/deals/${c.id}`, tone: c.status === "won" ? "good" as const : "bad" as const })),
    pipeline: { count: pipeline?.count ?? 0, value: Number(pipeline?.value ?? 0) },
    movers: movers.map((m) => ({
      id: m.id, title: m.title, score: m.score, before: m.before,
      why: m.signals.find((x) => (m.score < m.before ? x.tone === "risk" : x.tone === "good"))?.label ?? null,
    })),
    agents: AGENT_KEYS.map((k) => ({ name: AGENT_INFO[k].name, done: agentRows.find((r) => r.agent === k)?.done ?? 0, pending: agentRows.find((r) => r.agent === k)?.pending ?? 0 }))
      .filter((a) => a.done || a.pending),
    hotOpens: hotOpens.map((e) => ({
      title: `${e.who ?? "Alguien"} ha abierto «${e.subject || "(sin asunto)"}» ${e.opens} ${e.opens === 1 ? "vez" : "veces"}`,
      detail: e.deal_title ? `${e.deal_title} · sin responder` : "sin responder", href: `/emails/${e.id}`, at: e.last, tone: "good" as const,
    })),
  };
  d.focus = ruleFocus(d);
  if (opts.ai) {
    const key = ownerId ?? "all", day = localNow().day;
    const [cached] = await sql<{ focus: string }[]>`SELECT focus FROM digest_focus WHERE owner_key = ${key} AND day = ${day}`;
    let text: string | null = cached?.focus ?? null;
    if (!text && opts.ai === "generate") {
      text = await generate("daily_digest", digestFacts(d));
      if (text) {
        await sql`INSERT INTO digest_focus (owner_key, day, focus) VALUES (${key}, ${day}, ${text})
                  ON CONFLICT (owner_key, day) DO UPDATE SET focus = EXCLUDED.focus, generated_at = now()`;
      }
    }
    if (text) { d.focus = text; d.focusSource = "ai"; }
  }
  return d;
}

/** Enfoque del día por reglas: las tres cosas más importantes. */
function ruleFocus(d: Digest): string {
  const lines: string[] = [];
  if (d.decisions.count > 0) lines.push(`Decide ${d.decisions.count === 1 ? "la propuesta" : `las ${d.decisions.count} propuestas`} de la IA en la bandeja.`);
  for (const a of d.attention.slice(0, 3 - lines.length)) lines.push(`${a.deal.title}: ${a.step.text.charAt(0).toLowerCase()}${a.step.text.slice(1)}.`);
  if (lines.length < 3 && d.agenda.length) lines.push(`Tienes ${d.agenda.length} ${d.agenda.length === 1 ? "reunión" : "reuniones"} hoy.`);
  if (lines.length < 3 && d.tasks.length) lines.push(`Y ${d.tasks.length} ${d.tasks.length === 1 ? "tarea" : "tareas"} para hoy.`);
  if (lines.length === 0) return "Nada urgente: buen día para generar pipeline nuevo.";
  return lines.map((l, i) => `${i + 1}. ${l}`).join("\n");
}

function digestFacts(d: Digest) {
  return {
    persona: d.ownerName ?? "todo el equipo",
    decisiones_pendientes: d.decisions.items.map((x) => x.title),
    agenda_de_hoy: d.agenda.map((x) => ({ que: x.title, con: x.detail })),
    tareas_de_hoy: d.tasks.map((x) => ({ que: x.title, deal: x.detail })),
    vencidas: d.overdue.map((x) => ({ que: x.title, deal: x.detail })),
    deals_que_piden_atencion: d.attention.map((a) => ({ deal: a.deal.title, importe: money(a.deal.value, a.deal.currency),
                                                         siguiente_paso: a.step.text, motivo: a.step.why })),
    hecho_por_la_ia_24h: d.aiDone.items.map((x) => x.title),
    leads_nuevos_24h: d.leads.count,
    cerrados_24h: d.closed.map((x) => `${x.title} (${x.detail})`),
    salud_cambios_desde_ayer: d.movers.map((m) => `${m.title}: ${m.before} → ${m.score}${m.why ? ` (${m.why})` : ""}`),
    correos_abiertos_sin_respuesta_48h: d.hotOpens.map((x) => x.title),
  };
}

const hhmm = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("es-ES", { timeZone: TZ(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d)) : "";

/** El parte en texto, para el correo. */
export function digestEmail(d: Digest, appUrl: string) {
  const url = (p?: string) => (p ? `${appUrl}${p}` : "");
  const section = (title: string, items: string[]) => (items.length ? [`${title}`, ...items, ""] : []);
  const today = new Intl.DateTimeFormat("es-ES", { timeZone: TZ(), weekday: "long", day: "numeric", month: "long" }).format(d.date);
  const body = [
    `Parte del día — ${today}${d.ownerName ? ` · ${d.ownerName}` : ""}`,
    "",
    d.focusSource === "ai" ? "Enfoque del día (IA):" : "Enfoque del día:",
    d.focus,
    "",
    ...section(`Decisiones pendientes (${d.decisions.count}) — ${url("/inbox")}`, d.decisions.items.map((x) => `- ${x.title}${x.detail ? ` (${x.detail})` : ""}`)),
    ...section("Agenda de hoy", d.agenda.map((x) => `- ${hhmm(x.at)} ${x.title}${x.detail ? ` — ${x.detail}` : ""}`)),
    ...section(`Tareas de hoy (${d.tasks.length})`, d.tasks.slice(0, 10).map((x) => `- ${x.title}${x.detail ? ` (${x.detail})` : ""}`)),
    ...section("Vencidas", d.overdue.map((x) => `- ${x.title}${x.detail ? ` (${x.detail})` : ""}`)),
    ...section("Salud: cambios desde ayer", d.movers.map((m) => `- ${m.title}: ${m.before} → ${m.score}${m.why ? ` (${m.why})` : ""} ${url(`/deals/${m.id}`)}`)),
    ...section("Abiertos sin responder (48 h): buen momento para llamar", d.hotOpens.map((x) => `- ${x.title} (${x.detail})`)),
    ...section("Deals que piden atención", d.attention.map((a) => `- ${a.deal.title} (${money(a.deal.value, a.deal.currency)}): ${a.step.text}. ${a.step.why} ${url(`/deals/${a.deal.id}`)}`)),
    ...section(`Lo que hizo la IA en las últimas 24 h (${d.aiDone.count})`, d.aiDone.items.map((x) => `- ${x.title} — ${x.detail}`)),
    ...section("Agentes (24 h)", d.agents.map((a) => `- ${a.name}: ${a.done} hecho${a.done === 1 ? "" : "s"}${a.pending ? `, ${a.pending} esperando tu decisión` : ""}`)),
    ...section(`Leads nuevos en las últimas 24 h (${d.leads.count})`, d.leads.items.map((x) => `- ${x.title}${x.detail ? ` (${x.detail})` : ""}`)),
    ...section("Cerrados en las últimas 24 h", d.closed.map((x) => `- ${x.title}: ${x.detail}`)),
    `Pipeline abierto: ${d.pipeline.count} deals · ${money(d.pipeline.value)}`,
    "",
    `Ábrelo en el CRM: ${url("/")}`,
  ].join("\n");
  return { subject: `Tu parte del día: ${d.decisions.count} decisiones, ${d.agenda.length} reuniones, ${d.attention.length} deals con atención`, body };
}

const appUrl = () => (process.env.APP_URL || "").replace(/\/$/, "");

/** Pide a la IA el enfoque del día (y lo guarda para hoy). */
export async function refreshDigestFocus(ownerId: string | null) {
  await sql`DELETE FROM digest_focus WHERE owner_key = ${ownerId ?? "all"} AND day = ${localNow().day}`;
  const d = await buildDigest(ownerId, { ai: "generate" });
  if (d.focusSource !== "ai") throw new UserError("La IA no está configurada o no ha respondido (ver Ajustes → Modelo de IA).");
}

/** Envía ahora el parte de una persona a su correo conectado. */
export async function sendDigestNow(userId: string) {
  const conn = (await listConnections()).find((c) => c.user_id === userId && c.status === "active");
  if (!conn) throw new UserError("Para recibir el parte por correo, conecta tu cuenta en Ajustes → Correo, calendario y documentos.");
  const d = await buildDigest(userId, { ai: "generate" });
  const { subject, body } = digestEmail(d, appUrl());
  await sendPlainEmail(conn, conn.email, subject, body);
  await sql`INSERT INTO digest_log (user_id, day, sent_to) VALUES (${userId}, ${localNow().day}, ${conn.email})
            ON CONFLICT (user_id, day) DO UPDATE SET sent_at = now(), sent_to = EXCLUDED.sent_to`;
  return conn.email;
}

/** Envía el parte a quien le toque hoy (a partir de la hora configurada, una vez al día). */
export async function sendDueDigests(now = new Date()): Promise<number> {
  const s = await getDigestSettings();
  const local = localNow(now);
  if (!s.enabled || !s.days.includes(local.weekday) || local.hour < s.hour) return 0;
  // Enfoque del día del equipo (para la página «Hoy»), una vez al día.
  await buildDigest(null, { ai: "generate" }).catch(() => null);
  const conns = (await listConnections()).filter((c) => c.status === "active");
  let sent = 0;
  for (const c of conns) {
    const [done] = await sql`SELECT 1 FROM digest_log WHERE user_id = ${c.user_id} AND day = ${local.day}`;
    if (done) continue;
    const [u] = await sql<{ notification_prefs: { daily?: boolean } }[]>`SELECT notification_prefs FROM users WHERE id = ${c.user_id} AND is_active`;
    if (!u || u.notification_prefs?.daily === false) continue;
    try {
      await sendDigestNow(c.user_id);
      sent++;
    } catch (err) {
      console.error("[parte del día]", c.email, err);
    }
  }
  return sent;
}
