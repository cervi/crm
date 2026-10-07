import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, INTEGRATION_ACTOR, type Actor } from "./events";
import { linksIn } from "./email-track";
import { hrefsIn, sanitizeEmailHtml } from "./email-html";
import { appendSignature, senderVars, signatureFor } from "./signatures";
import { DEVICE_LABEL, readerOf, type Device, type ReaderInfo } from "./reader";
import { notify } from "./notifications";
import { bookingLinkFor } from "./booking";
import { connectionOf, sendEmail } from "./mailbox";
import { renderTemplate } from "./automations";
import type { SessionUser } from "./session";
import { id, optId, parse, text } from "./validation";

// ===========================================================================
// Correos: conversación de cada deal, plantillas, envío programado y
// seguimiento de aperturas y clics.
// ===========================================================================

export type EmailRow = {
  id: string; direction: "in" | "out"; status: "scheduled" | "sending" | "sent" | "failed" | "cancelled";
  subject: string; body: string; from_email: string | null; to_email: string | null; to_name: string | null;
  person_name: string | null; user_name: string | null; at: Date; scheduled_at: Date | null; sent_at: Date | null;
  track: boolean; open_count: number; first_opened_at: Date | null; last_opened_at: Date | null;
  click_count: number; last_clicked_at: Date | null; error: string | null;
};

export async function listEmails(ref: { dealId?: string; personId?: string; organizationId?: string }, limit = 100): Promise<EmailRow[]> {
  return sql<EmailRow[]>`
    SELECT e.id, e.direction, e.status, e.subject, e.body, e.from_email, e.to_email, e.to_name,
           p.full_name AS person_name, u.name AS user_name, coalesce(e.sent_at, e.scheduled_at, e.created_at) AS at,
           e.scheduled_at, e.sent_at, e.track, e.open_count, e.first_opened_at, e.last_opened_at, e.click_count, e.last_clicked_at, e.error
    FROM emails e
    LEFT JOIN persons p ON p.id = e.person_id
    LEFT JOIN users u ON u.id = e.user_id
    WHERE ${ref.dealId ? sql`e.deal_id = ${ref.dealId}`
      : ref.organizationId ? sql`(e.organization_id = ${ref.organizationId} OR e.deal_id IN (SELECT id FROM deals WHERE organization_id = ${ref.organizationId})
                                  OR e.person_id IN (SELECT person_id FROM person_organizations WHERE organization_id = ${ref.organizationId} AND status = 'current'))`
      : sql`e.person_id = ${ref.personId ?? null}`}
      AND e.status <> 'cancelled'
    ORDER BY coalesce(e.sent_at, e.scheduled_at, e.created_at) DESC
    LIMIT ${limit}`;
}

// ---------------------------------------------------------------------------
// Envío desde la ficha del deal (ahora o programado)

const composeSchema = z.object({
  person_id: id,
  subject: text("El asunto", 300),
  body: text("El texto", 20000),
  send_at: z.string().optional(),
  track: z.string().optional(),
  track_present: z.string().optional(),
  template_id: optId,
  signature: z.string().optional(),
});

export type ComposeResult = { scheduled: boolean; at?: Date };

/** Envía (o programa) el correo escrito en la ficha del deal. Sale de tu buzón o, si no tienes, del del responsable. */
export async function composeDealEmail(actor: Actor, dealId: string | null, data: unknown): Promise<ComposeResult> {
  const v = parse(composeSchema, data);
  const [p] = await sql<{ full_name: string; email: string | null; owner_id: string | null; organization_id: string | null }[]>`
    SELECT p.full_name,
           (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY (bounced_at IS NULL) DESC, is_primary DESC, created_at LIMIT 1) AS email,
           coalesce(d.owner_id, p.owner_id) AS owner_id,
           coalesce(d.organization_id, (SELECT organization_id FROM person_organizations WHERE person_id = p.id AND status = 'current'
                                        ORDER BY created_at DESC LIMIT 1)) AS organization_id
    FROM persons p LEFT JOIN deals d ON d.id = ${dealId}::uuid WHERE p.id = ${v.person_id}`;
  if (!p?.email) throw new UserError("Ese contacto no tiene email.");
  const mine = actor.id ? await connectionOf(actor.id) : null;
  const conn = mine?.status === "active" ? mine : p.owner_id ? await connectionOf(p.owner_id) : null;
  if (!conn || conn.status !== "active") throw new UserError("Conecta tu cuenta en Ajustes → Correo, calendario y documentos para enviar desde aquí.");
  const track = v.track_present ? v.track === "on" : undefined;
  // Firma de quien envía (la de su buzón o la suya), salvo que se desmarque.
  const sig = v.signature === "on" ? await signatureFor(conn) : "";
  const mail = appendSignature(sig, senderVars(conn), { text: v.body });

  if (v.send_at) {
    const at = new Date(v.send_at);
    if (Number.isNaN(at.getTime())) throw new UserError("Fecha de envío no válida.");
    if (at.getTime() < Date.now() + 60000) throw new UserError("Programa el envío al menos para dentro de un minuto (o envíalo ya).");
    if (at.getTime() > Date.now() + 365 * 86400000) throw new UserError("Como mucho, con un año de antelación.");
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO emails (direction, status, deal_id, person_id, organization_id, user_id, from_email, to_email, to_name,
                          subject, body, body_html, scheduled_at, template_id, track, created_by)
      VALUES ('out', 'scheduled', ${dealId}, ${v.person_id}, ${p.organization_id}, ${conn.user_id}, ${conn.email}, ${p.email},
              ${p.full_name}, ${v.subject}, ${mail.text}, ${mail.html}, ${at}, ${v.template_id ?? null}, ${track ?? true}, ${actor.id})
      RETURNING id`;
    await recordEvent(sql, actor, dealId ? "deal" : "person", dealId ?? v.person_id, "email.scheduled", { email_id: row.id, subject: v.subject, at: at.toISOString() });
    return { scheduled: true, at };
  }
  await sendEmail(conn, actor, {
    to: { email: p.email, name: p.full_name }, subject: v.subject, body: mail.text, html: mail.html,
    dealId, personId: v.person_id, organizationId: p.organization_id, track, templateId: v.template_id ?? null,
  });
  return { scheduled: false };
}

export async function cancelScheduledEmail(user: SessionUser, emailId: string) {
  const [e] = await sql<{ user_id: string | null; created_by: string | null }[]>`
    SELECT user_id, created_by FROM emails WHERE id = ${emailId} AND status = 'scheduled'`;
  if (!e) throw new UserError("Ese correo ya no está programado.");
  if (user.role !== "admin" && e.created_by !== user.id && e.user_id !== user.id) throw new UserError("Ese correo no es tuyo.");
  await sql`UPDATE emails SET status = 'cancelled' WHERE id = ${emailId} AND status = 'scheduled'`;
}

/** Envía los correos programados cuya hora ha llegado (lo llama el ciclo periódico). */
export async function sendDueEmails(limit = 20): Promise<{ sent: number; failed: number }> {
  const due = await sql<{ id: string; user_id: string | null; created_by: string | null; to_email: string; to_name: string | null;
                          subject: string; body: string; deal_id: string | null; person_id: string | null; organization_id: string | null;
                          track: boolean; template_id: string | null; body_html: string | null }[]>`
    UPDATE emails SET status = 'sending'
    WHERE id IN (SELECT id FROM emails WHERE status = 'scheduled' AND scheduled_at <= now()
                 ORDER BY scheduled_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, user_id, created_by, to_email, to_name, subject, body, body_html, deal_id, person_id, organization_id, track, template_id`;
  let sent = 0, failed = 0;
  for (const e of due) {
    try {
      const conn = e.user_id ? await connectionOf(e.user_id) : null;
      if (!conn || conn.status !== "active") throw new Error("La cuenta de correo con la que se programó ya no está conectada.");
      await sendEmail(conn, { type: "user", id: e.created_by }, {
        to: { email: e.to_email, name: e.to_name }, subject: e.subject, body: e.body, html: e.body_html, dealId: e.deal_id,
        personId: e.person_id, organizationId: e.organization_id, track: e.track, templateId: e.template_id, emailId: e.id,
      });
      sent++;
    } catch (err) {
      failed++;
      await sql`UPDATE emails SET status = 'failed', error = ${err instanceof Error ? err.message.slice(0, 500) : "Error al enviar"}
                WHERE id = ${e.id} AND status <> 'sent'`;
    }
  }
  return { sent, failed };
}

// ---------------------------------------------------------------------------
// Seguimiento: cada apertura y cada clic quedan registrados con su fecha,
// dispositivo y programa. Las automáticas (escáneres, precarga de Apple Mail)
// se guardan pero no cuentan.

type TrackedEmail = {
  id: string; deal_id: string | null; person_id: string | null; sent_at: Date | null; user_id: string | null; created_by: string | null;
  subject: string; to_name: string | null; to_email: string | null; open_count: number; last_opened_at: Date | null;
  open_alert_at: Date | null; body: string; click_count: number; deal_title: string | null; deal_owner: string | null;
};

async function trackedEmail(token: string) {
  const [e] = await sql<TrackedEmail[]>`
    SELECT e.id, e.deal_id, e.person_id, e.sent_at, e.user_id, e.created_by, e.subject, coalesce(p.full_name, e.to_name) AS to_name,
           e.to_email, e.open_count, e.last_opened_at, e.open_alert_at, e.body, e.click_count, d.title AS deal_title, d.owner_id AS deal_owner
    FROM emails e LEFT JOIN persons p ON p.id = e.person_id LEFT JOIN deals d ON d.id = e.deal_id
    WHERE e.token = ${token} AND e.status = 'sent'`;
  return e ?? null;
}

const REOPEN_GAP_MS = 12 * 3600000;

/** Cuenta una apertura de una persona: actualiza los contadores, la historia del deal y avisa a quien lo envió. */
async function countOpen(e: TrackedEmail, info: ReaderInfo) {
  const [u] = await sql<{ open_count: number }[]>`
    UPDATE emails SET open_count = open_count + 1, last_opened_at = now(), first_opened_at = coalesce(first_opened_at, now())
    WHERE id = ${e.id} RETURNING open_count`;
  const first = u.open_count === 1;
  const reopened = !first && e.last_opened_at !== null && Date.now() - new Date(e.last_opened_at).getTime() > REOPEN_GAP_MS;
  const detail = { email_id: e.id, subject: e.subject, count: u.open_count, device: info.device, client: info.client, place: info.place };
  if (e.deal_id && (first || reopened)) {
    await recordEvent(sql, INTEGRATION_ACTOR, "deal", e.deal_id, first ? "email.opened" : "email.reopened", detail);
  }
  if (!first && !reopened) return;
  const [s] = await sql<{ open_alerts: "all" | "reopen" | "off" }[]>`SELECT open_alerts FROM app_settings LIMIT 1`;
  const mode = s?.open_alerts ?? "all";
  if (mode === "off" || (mode === "reopen" && first)) return;
  // Un aviso como mucho cada 12 horas por correo.
  if (e.open_alert_at && Date.now() - new Date(e.open_alert_at).getTime() < REOPEN_GAP_MS) return;
  const to = e.user_id ?? e.created_by ?? e.deal_owner;
  if (!to) return;
  await sql`UPDATE emails SET open_alert_at = now() WHERE id = ${e.id}`;
  const who = e.to_name ?? e.to_email ?? "El contacto";
  const where = [info.device !== "unknown" ? DEVICE_LABEL[info.device].toLowerCase() : null, info.client, info.place].filter(Boolean).join(" · ");
  await notify(sql, {
    userId: to, kind: first ? "email.opened" : "email.reopened",
    title: first ? `${who} ha abierto «${e.subject || "(sin asunto)"}»` : `${who} ha vuelto a abrir «${e.subject || "(sin asunto)"}» (${u.open_count}.ª vez)`,
    body: [e.deal_title, where].filter(Boolean).join(" — ") || null, link: `/emails/${e.id}`,
  });
}

export async function recordOpen(token: string, headers: Headers = new Headers()) {
  const e = await trackedEmail(token);
  if (!e) return;
  const info = readerOf(headers, e.sent_at);
  // El mismo lector recargando la imagen en menos de un minuto no es otra apertura.
  const [dup] = await sql`SELECT 1 FROM email_opens WHERE email_id = ${e.id} AND reader = ${info.reader} AND at > now() - interval '60 seconds'`;
  if (dup) return;
  await sql`INSERT INTO email_opens (email_id, device, client, place, reader, automatic)
            VALUES (${e.id}, ${info.device}, ${info.client}, ${info.place}, ${info.reader}, ${info.automatic})`;
  if (!info.automatic) await countOpen(e, info);
}

/** Registra el clic y devuelve a dónde redirigir (solo enlaces que estaban en el correo). */
export async function recordClick(token: string, url: string, headers: Headers = new Headers()): Promise<string | null> {
  const [raw] = await sql<{ id: string; body: string; body_html: string | null }[]>`SELECT id, body, body_html FROM emails WHERE token = ${token}`;
  if (!raw || !(linksIn(raw.body).includes(url) || hrefsIn(raw.body_html).includes(url))) return null;
  const e = await trackedEmail(token);
  if (!e) return url;
  const info = readerOf(headers, e.sent_at);
  await sql`INSERT INTO email_clicks (email_id, url, device, reader, automatic)
            VALUES (${e.id}, ${url.slice(0, 2000)}, ${info.device}, ${info.reader}, ${info.automatic})`;
  if (info.automatic) return url;
  await sql`UPDATE emails SET click_count = click_count + 1, last_clicked_at = now() WHERE id = ${e.id}`;
  if (e.click_count === 0 && e.deal_id) await recordEvent(sql, INTEGRATION_ACTOR, "deal", e.deal_id, "email.clicked", { email_id: e.id, url, subject: e.subject });
  // Si las imágenes estaban bloqueadas, el clic demuestra que lo abrió.
  if (e.open_count === 0) {
    await sql`INSERT INTO email_opens (email_id, device, client, place, reader, automatic)
              VALUES (${e.id}, ${info.device}, ${info.client}, ${info.place}, ${info.reader}, false)`;
    await countOpen(e, info);
  }
  return url;
}

// ---------------------------------------------------------------------------
// Correos enviados: la bandeja con su lectura

export type OpenRow = { at: Date; device: Device | null; client: string | null; place: string | null; automatic: boolean };
export type ClickRow = { at: Date; url: string; device: string | null; automatic: boolean };

export const SENT_FILTERS = {
  all: "Todos",
  opened: "Abiertos",
  unopened: "Sin abrir",
  opened_no_reply: "Abiertos sin responder",
  reopened: "Abiertos varias veces",
  clicked: "Con clics",
  replied: "Respondidos",
} as const;
export type SentFilter = keyof typeof SENT_FILTERS;
export const isSentFilter = (v: unknown): v is SentFilter => typeof v === "string" && v in SENT_FILTERS;

export type SentRow = {
  id: string; subject: string; to_email: string | null; to_name: string | null; person_id: string | null; deal_id: string | null;
  deal_title: string | null; user_name: string | null; sent_at: Date; track: boolean; open_count: number; first_opened_at: Date | null;
  last_opened_at: Date | null; click_count: number; replied_at: Date | null; sequence_name: string | null;
};

/** Primera respuesta del contacto posterior al envío. */
const REPLIED = sql`(SELECT min(r.sent_at) FROM emails r WHERE r.direction = 'in' AND r.sent_at > e.sent_at
                       AND (r.person_id = e.person_id OR lower(r.from_email) = lower(e.to_email)))`;

export async function listSent(opts: { userId?: string | null; filter?: SentFilter; q?: string | null; page?: number }): Promise<SentRow[]> {
  const f = opts.filter ?? "all";
  const q = opts.q?.trim() ? `%${opts.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const page = Math.max(0, opts.page ?? 0);
  return sql<SentRow[]>`
    SELECT * FROM (
      SELECT e.id, e.subject, e.to_email, coalesce(p.full_name, e.to_name) AS to_name, e.person_id, e.deal_id, d.title AS deal_title,
             u.name AS user_name, e.sent_at, e.track, e.open_count, e.first_opened_at, e.last_opened_at, e.click_count,
             ${REPLIED} AS replied_at, sq.name AS sequence_name
      FROM emails e
      LEFT JOIN persons p ON p.id = e.person_id
      LEFT JOIN deals d ON d.id = e.deal_id
      LEFT JOIN users u ON u.id = e.user_id
      LEFT JOIN sequence_enrollments se ON se.id = e.enrollment_id
      LEFT JOIN sequences sq ON sq.id = se.sequence_id
      WHERE e.direction = 'out' AND e.status = 'sent'
        AND (${opts.userId ?? null}::uuid IS NULL OR e.user_id = ${opts.userId ?? null}::uuid)
        AND (${q}::text IS NULL OR e.subject ILIKE ${q}::text OR e.to_email ILIKE ${q}::text OR p.full_name ILIKE ${q}::text OR d.title ILIKE ${q}::text)
    ) e
    WHERE ${f === "opened" ? sql`e.open_count > 0`
      : f === "unopened" ? sql`e.track AND e.open_count = 0`
      : f === "opened_no_reply" ? sql`e.open_count > 0 AND e.replied_at IS NULL`
      : f === "reopened" ? sql`e.open_count > 1`
      : f === "clicked" ? sql`e.click_count > 0`
      : f === "replied" ? sql`e.replied_at IS NOT NULL`
      : sql`true`}
    ORDER BY e.sent_at DESC
    LIMIT 101 OFFSET ${page * 100}`;
}

/** Totales de lectura para la cabecera de la bandeja. */
export async function sentStats(userId: string | null, days = 30) {
  const [r] = await sql<{ sent: number; tracked: number; opened: number; clicked: number; replied: number }[]>`
    SELECT count(*)::int AS sent, count(*) FILTER (WHERE e.track)::int AS tracked,
           count(*) FILTER (WHERE e.open_count > 0)::int AS opened, count(*) FILTER (WHERE e.click_count > 0)::int AS clicked,
           count(*) FILTER (WHERE ${REPLIED} IS NOT NULL)::int AS replied
    FROM emails e
    WHERE e.direction = 'out' AND e.status = 'sent' AND e.sent_at > now() - make_interval(days => ${days})
      AND (${userId}::uuid IS NULL OR e.user_id = ${userId}::uuid)`;
  return r;
}

export type SentDetail = SentRow & { body: string; from_email: string | null; opens: OpenRow[]; clicks: ClickRow[] };

export async function getSentEmail(id: string): Promise<SentDetail | null> {
  const [e] = await sql<(SentRow & { body: string; from_email: string | null })[]>`
    SELECT e.id, e.subject, e.to_email, coalesce(p.full_name, e.to_name) AS to_name, e.person_id, e.deal_id, d.title AS deal_title,
           u.name AS user_name, e.sent_at, e.track, e.open_count, e.first_opened_at, e.last_opened_at, e.click_count,
           ${REPLIED} AS replied_at, sq.name AS sequence_name, e.body, e.from_email
    FROM emails e
    LEFT JOIN persons p ON p.id = e.person_id
    LEFT JOIN deals d ON d.id = e.deal_id
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN sequence_enrollments se ON se.id = e.enrollment_id
    LEFT JOIN sequences sq ON sq.id = se.sequence_id
    WHERE e.id = ${id} AND e.direction = 'out'`;
  if (!e) return null;
  const [opens, clicks] = await Promise.all([
    sql<OpenRow[]>`SELECT at, device, client, place, automatic FROM email_opens WHERE email_id = ${id} ORDER BY at DESC LIMIT 200`,
    sql<ClickRow[]>`SELECT at, url, device, automatic FROM email_clicks WHERE email_id = ${id} ORDER BY at DESC LIMIT 200`,
  ]);
  return { ...e, opens, clicks };
}

/** Las aperturas (de personas) de varios correos, para mostrarlas en la ficha del deal. */
export async function opensFor(emailIds: string[]): Promise<Map<string, OpenRow[]>> {
  if (emailIds.length === 0) return new Map();
  const rows = await sql<(OpenRow & { email_id: string })[]>`
    SELECT email_id, at, device, client, place, automatic FROM email_opens
    WHERE email_id = ANY(${emailIds}::uuid[]) AND NOT automatic ORDER BY at DESC`;
  const out = new Map<string, OpenRow[]>();
  for (const r of rows) out.set(r.email_id, [...(out.get(r.email_id) ?? []), r]);
  return out;
}

// ---------------------------------------------------------------------------
// Plantillas

export type Template = { id: string; name: string; subject: string; body: string; format: "text" | "html"; shared: boolean; mine: boolean; author: string | null };

export async function listTemplates(userId: string): Promise<Template[]> {
  return sql<Template[]>`
    SELECT t.id, t.name, t.subject, t.body, t.format, t.user_id IS NULL AS shared, t.user_id = ${userId} AS mine, u.name AS author
    FROM email_templates t LEFT JOIN users u ON u.id = t.created_by
    WHERE t.user_id IS NULL OR t.user_id = ${userId}
    ORDER BY lower(t.name)`;
}

const templateSchema = z.object({
  name: text("El nombre", 100),
  subject: z.string().trim().max(300).default(""),
  body: text("El texto", 100000),
  shared: z.string().optional(),
  format: z.enum(["text", "html"]).optional(),
});

function canEdit(user: SessionUser, t: { user_id: string | null }) {
  return t.user_id ? t.user_id === user.id : user.role === "admin";
}

export async function saveTemplate(user: SessionUser, templateId: string | null, data: unknown) {
  const v = parse(templateSchema, data);
  const shared = v.shared === "on";
  if (shared && user.role !== "admin") throw new UserError("Solo un administrador puede compartir plantillas con el equipo.");
  let format: "text" | "html" = v.format ?? "text";
  const clean = () => (format === "html" ? sanitizeEmailHtml(v.body) : v.body);
  if (templateId) {
    const [t] = await sql<{ user_id: string | null; format: "text" | "html" }[]>`SELECT user_id, format FROM email_templates WHERE id = ${templateId}`;
    if (!t) throw new UserError("Esa plantilla ya no existe.");
    format = v.format ?? t.format;
    const body = clean();
    if (!canEdit(user, t)) throw new UserError("No puedes cambiar esa plantilla.");
    await sql`UPDATE email_templates SET name = ${v.name}, subject = ${v.subject}, body = ${body}, format = ${format},
                     user_id = ${shared ? null : t.user_id ?? user.id}, updated_at = now() WHERE id = ${templateId}`;
    return;
  }
  const body = clean();
  const [row] = await sql<{ id: string }[]>`INSERT INTO email_templates (name, subject, body, format, user_id, created_by)
            VALUES (${v.name}, ${v.subject}, ${body}, ${format}, ${shared ? null : user.id}, ${user.id}) RETURNING id`;
  return row.id;
}

export async function deleteTemplate(user: SessionUser, templateId: string) {
  const [t] = await sql<{ user_id: string | null }[]>`SELECT user_id FROM email_templates WHERE id = ${templateId}`;
  if (!t) return;
  if (!canEdit(user, t)) throw new UserError("No puedes borrar esa plantilla.");
  await sql`DELETE FROM email_templates WHERE id = ${templateId}`;
}

/** Variables de una plantilla para un deal y un contacto ({huecos} se rellena en el navegador). */
export async function templateVars(dealId: string): Promise<Record<string, string>> {
  const [d] = await sql<{ title: string; organization: string | null; owner: string | null; owner_id: string | null;
                          person: string | null; person_id: string | null }[]>`
    SELECT d.title, o.name AS organization, u.name AS owner, d.owner_id, pp.full_name AS person, pp.id AS person_id
    FROM deals d LEFT JOIN organizations o ON o.id = d.organization_id LEFT JOIN users u ON u.id = d.owner_id
    LEFT JOIN LATERAL (
      SELECT p.id, p.full_name FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
      WHERE dp.deal_id = d.id ORDER BY dp.is_primary DESC LIMIT 1
    ) pp ON true
    WHERE d.id = ${dealId}`;
  if (!d) return {};
  const link = await bookingLinkFor(d.owner_id, dealId, d.person_id).catch(() => null);
  return {
    deal: d.title, empresa: d.organization ?? "", responsable: d.owner ?? "",
    nombre: (d.person ?? "").split(/\s+/)[0] ?? "",
    ...(link ? { enlace_reserva: link } : {}),
  };
}

export const renderWith = (tpl: string, vars: Record<string, string>) => renderTemplate(tpl, vars);
