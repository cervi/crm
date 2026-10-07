import { sql } from "./db";
import { UserError } from "./errors";
import { htmlToText, sanitizeEmailHtml, textToHtml } from "./email-html";
import { mergeTemplate, type MergeVars } from "./merge";
import type { Connection } from "./mailbox";

// ===========================================================================
// Firma de los correos: la de cada persona (Mi cuenta / Ajustes → Correo) o
// la de un buzón concreto (p. ej. uno de outbound con otro dominio), que manda
// sobre la de la persona. Se añade a los correos de la ficha del deal, de las
// secuencias, de las campañas y de los agentes.
// ===========================================================================

const MAX = 10000;
const clean = (html: string | null | undefined) => {
  const h = sanitizeEmailHtml(html ?? "");
  return htmlToText(h).trim() || /<img\b/i.test(h) ? h : "";
};

/** Firma que va en los correos de este buzón (o de esta persona). */
export async function signatureFor(ref: Pick<Connection, "signature" | "user_signature"> | string | null | undefined): Promise<string> {
  if (!ref) return "";
  if (typeof ref !== "string") return clean(ref.signature) || clean(ref.user_signature);
  const [u] = await sql<{ email_signature: string | null }[]>`SELECT email_signature FROM users WHERE id = ${ref}`;
  return clean(u?.email_signature);
}

/** Variables de quien envía, para la firma ({{remitente}}, {{remitente_email}}…). */
export function senderVars(conn: Pick<Connection, "user_name" | "email"> | null | undefined): MergeVars {
  const name = conn?.user_name ?? "";
  return { remitente: name, remitente_nombre: name.split(/\s+/)[0] ?? "", remitente_email: conn?.email ?? "", responsable: name };
}

/**
 * Añade la firma a un correo: al texto (versión sencilla) y al HTML. Si el
 * correo era solo texto, se pasa a HTML para que la firma conserve su formato
 * (logo, enlaces, negritas).
 */
export function appendSignature(signature: string, vars: MergeVars, mail: { text: string; html?: string | null }): { text: string; html: string | null } {
  if (!signature) return { text: mail.text, html: mail.html ?? null };
  const sig = sanitizeEmailHtml(mergeTemplate(signature, vars, { html: true }).text);
  const block = `<div class="firma" style="margin-top:16px">${sig}</div>`;
  const html = (mail.html ?? textToHtml(mail.text)) + block;
  return { text: `${mail.text.trimEnd()}\n\n${htmlToText(sig)}`, html };
}

function check(html: string) {
  const h = sanitizeEmailHtml(html);
  if (h.length > MAX) throw new UserError("La firma es demasiado larga.");
  return htmlToText(h).trim() || /<img\b/i.test(h) ? h : null;
}

export async function saveUserSignature(userId: string, html: string) {
  await sql`UPDATE users SET email_signature = ${check(html)} WHERE id = ${userId}`;
}

export async function saveMailboxSignature(mailboxId: string, html: string) {
  const res = await sql`UPDATE mailbox_connections SET signature = ${check(html)} WHERE id = ${mailboxId}`;
  if (res.count === 0) throw new UserError("Ese buzón ya no está conectado.");
}

/** Vista previa de la firma con los datos de quien envía (para mostrarla junto al editor). */
export function signaturePreview(signature: string, conn: Pick<Connection, "user_name" | "email"> | null) {
  return signature ? sanitizeEmailHtml(mergeTemplate(signature, senderVars(conn), { html: true }).text) : "";
}

