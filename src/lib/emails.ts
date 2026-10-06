import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, INTEGRATION_ACTOR, type Actor } from "./events";
import { linksIn } from "./email-track";
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

export async function listEmails(ref: { dealId?: string; personId?: string }, limit = 100): Promise<EmailRow[]> {
  return sql<EmailRow[]>`
    SELECT e.id, e.direction, e.status, e.subject, e.body, e.from_email, e.to_email, e.to_name,
           p.full_name AS person_name, u.name AS user_name, coalesce(e.sent_at, e.scheduled_at, e.created_at) AS at,
           e.scheduled_at, e.sent_at, e.track, e.open_count, e.first_opened_at, e.last_opened_at, e.click_count, e.last_clicked_at, e.error
    FROM emails e
    LEFT JOIN persons p ON p.id = e.person_id
    LEFT JOIN users u ON u.id = e.user_id
    WHERE ${ref.dealId ? sql`e.deal_id = ${ref.dealId}` : sql`e.person_id = ${ref.personId ?? null}`}
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
});

export type ComposeResult = { scheduled: boolean; at?: Date };

/** Envía (o programa) el correo escrito en la ficha del deal. Sale de tu buzón o, si no tienes, del del responsable. */
export async function composeDealEmail(actor: Actor, dealId: string, data: unknown): Promise<ComposeResult> {
  const v = parse(composeSchema, data);
  const [p] = await sql<{ full_name: string; email: string | null; owner_id: string | null; organization_id: string | null }[]>`
    SELECT p.full_name,
           (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           d.owner_id, d.organization_id
    FROM persons p, deals d WHERE p.id = ${v.person_id} AND d.id = ${dealId}`;
  if (!p?.email) throw new UserError("Ese contacto no tiene email.");
  const mine = actor.id ? await connectionOf(actor.id) : null;
  const conn = mine?.status === "active" ? mine : p.owner_id ? await connectionOf(p.owner_id) : null;
  if (!conn || conn.status !== "active") throw new UserError("Conecta tu cuenta en Ajustes → Correo, calendario y documentos para enviar desde aquí.");
  const track = v.track_present ? v.track === "on" : undefined;

  if (v.send_at) {
    const at = new Date(v.send_at);
    if (Number.isNaN(at.getTime())) throw new UserError("Fecha de envío no válida.");
    if (at.getTime() < Date.now() + 60000) throw new UserError("Programa el envío al menos para dentro de un minuto (o envíalo ya).");
    if (at.getTime() > Date.now() + 365 * 86400000) throw new UserError("Como mucho, con un año de antelación.");
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO emails (direction, status, deal_id, person_id, organization_id, user_id, from_email, to_email, to_name,
                          subject, body, scheduled_at, template_id, track, created_by)
      VALUES ('out', 'scheduled', ${dealId}, ${v.person_id}, ${p.organization_id}, ${conn.user_id}, ${conn.email}, ${p.email},
              ${p.full_name}, ${v.subject}, ${v.body}, ${at}, ${v.template_id ?? null}, ${track ?? true}, ${actor.id})
      RETURNING id`;
    await recordEvent(sql, actor, "deal", dealId, "email.scheduled", { email_id: row.id, subject: v.subject, at: at.toISOString() });
    return { scheduled: true, at };
  }
  await sendEmail(conn, actor, {
    to: { email: p.email, name: p.full_name }, subject: v.subject, body: v.body,
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
                          track: boolean; template_id: string | null }[]>`
    UPDATE emails SET status = 'sending'
    WHERE id IN (SELECT id FROM emails WHERE status = 'scheduled' AND scheduled_at <= now()
                 ORDER BY scheduled_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, user_id, created_by, to_email, to_name, subject, body, deal_id, person_id, organization_id, track, template_id`;
  let sent = 0, failed = 0;
  for (const e of due) {
    try {
      const conn = e.user_id ? await connectionOf(e.user_id) : null;
      if (!conn || conn.status !== "active") throw new Error("La cuenta de correo con la que se programó ya no está conectada.");
      await sendEmail(conn, { type: "user", id: e.created_by }, {
        to: { email: e.to_email, name: e.to_name }, subject: e.subject, body: e.body, dealId: e.deal_id,
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
// Seguimiento

export async function recordOpen(token: string) {
  const [e] = await sql<{ id: string; deal_id: string | null; first: boolean }[]>`
    UPDATE emails SET open_count = open_count + 1, last_opened_at = now(), first_opened_at = coalesce(first_opened_at, now())
    WHERE token = ${token} AND status = 'sent'
    RETURNING id, deal_id, open_count = 1 AS first`;
  if (e?.first && e.deal_id) await recordEvent(sql, INTEGRATION_ACTOR, "deal", e.deal_id, "email.opened", { email_id: e.id });
}

/** Registra el clic y devuelve a dónde redirigir (solo enlaces que estaban en el correo). */
export async function recordClick(token: string, url: string): Promise<string | null> {
  const [e] = await sql<{ id: string; body: string; deal_id: string | null; click_count: number }[]>`
    SELECT id, body, deal_id, click_count FROM emails WHERE token = ${token}`;
  if (!e || !linksIn(e.body).includes(url)) return null;
  await sql`UPDATE emails SET click_count = click_count + 1, last_clicked_at = now() WHERE id = ${e.id}`;
  await sql`INSERT INTO email_clicks (email_id, url) VALUES (${e.id}, ${url.slice(0, 2000)})`;
  if (e.click_count === 0 && e.deal_id) await recordEvent(sql, INTEGRATION_ACTOR, "deal", e.deal_id, "email.clicked", { email_id: e.id, url });
  return url;
}

// ---------------------------------------------------------------------------
// Plantillas

export type Template = { id: string; name: string; subject: string; body: string; shared: boolean; mine: boolean; author: string | null };

export async function listTemplates(userId: string): Promise<Template[]> {
  return sql<Template[]>`
    SELECT t.id, t.name, t.subject, t.body, t.user_id IS NULL AS shared, t.user_id = ${userId} AS mine, u.name AS author
    FROM email_templates t LEFT JOIN users u ON u.id = t.created_by
    WHERE t.user_id IS NULL OR t.user_id = ${userId}
    ORDER BY lower(t.name)`;
}

const templateSchema = z.object({
  name: text("El nombre", 100),
  subject: z.string().trim().max(300).default(""),
  body: text("El texto", 20000),
  shared: z.string().optional(),
});

function canEdit(user: SessionUser, t: { user_id: string | null }) {
  return t.user_id ? t.user_id === user.id : user.role === "admin";
}

export async function saveTemplate(user: SessionUser, templateId: string | null, data: unknown) {
  const v = parse(templateSchema, data);
  const shared = v.shared === "on";
  if (shared && user.role !== "admin") throw new UserError("Solo un administrador puede compartir plantillas con el equipo.");
  if (templateId) {
    const [t] = await sql<{ user_id: string | null }[]>`SELECT user_id FROM email_templates WHERE id = ${templateId}`;
    if (!t) throw new UserError("Esa plantilla ya no existe.");
    if (!canEdit(user, t)) throw new UserError("No puedes cambiar esa plantilla.");
    await sql`UPDATE email_templates SET name = ${v.name}, subject = ${v.subject}, body = ${v.body},
                     user_id = ${shared ? null : t.user_id ?? user.id}, updated_at = now() WHERE id = ${templateId}`;
    return;
  }
  await sql`INSERT INTO email_templates (name, subject, body, user_id, created_by)
            VALUES (${v.name}, ${v.subject}, ${v.body}, ${shared ? null : user.id}, ${user.id})`;
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
