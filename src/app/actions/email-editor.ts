"use server";

import { currentUser } from "@/lib/auth";
import { toUserMessage } from "@/lib/errors";
import { sql } from "@/lib/db";
import { composeEmail, getSequence, type Format } from "@/lib/sequences";
import { connectionOf, sendPlainEmail } from "@/lib/mailbox";
import { sampleVars, VARIABLES, type MergeVars } from "@/lib/merge";
import { mergeContext } from "@/lib/merge-context";
import { generate, parseJsonReply } from "@/lib/ai";
import { saveTemplate } from "@/lib/emails";
import { htmlToText, sanitizeEmailHtml, textToHtml } from "@/lib/email-html";
import { isId } from "@/lib/validation";

// ===========================================================================
// Acciones del editor de correos: vista previa con un contacto real, envío
// de prueba, redacción con IA y guardar como plantilla.
// ===========================================================================

export type EditorDraft = { subject: string; body: string; format: Format; personId?: string | null; sequenceId?: string | null };

export type PreviewResult = {
  error?: string; subject?: string; html?: string; missing?: string[]; unknown?: string[]; errors?: string[];
  contact?: string | null; to?: string | null;
};

async function writerUser() {
  const user = await currentUser();
  if (!user) throw new Error("Tu sesión ha caducado: vuelve a entrar.");
  if (user.role === "viewer") throw new Error("Tu usuario es de solo lectura.");
  return user;
}

async function compose(d: EditorDraft, userId: string) {
  const seq = d.sequenceId && isId(d.sequenceId) ? await getSequence(d.sequenceId) : null;
  const conn = await connectionOf(userId).catch(() => null);
  const personId = d.personId && isId(d.personId) ? d.personId : null;
  let vars: MergeVars | undefined;
  let contact: string | null = null;
  let to: string | null = null;
  let dealId: string | null = null;
  if (personId) {
    const [p] = await sql<{ full_name: string | null; email: string | null; deal_id: string | null }[]>`
      SELECT p.full_name,
             (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
             coalesce((SELECT e.deal_id FROM sequence_enrollments e WHERE e.person_id = p.id AND e.sequence_id = ${seq?.id ?? null}
                       ORDER BY e.created_at DESC LIMIT 1),
                      (SELECT dp.deal_id FROM deal_participants dp JOIN deals d ON d.id = dp.deal_id AND d.status = 'open' AND d.deleted_at IS NULL
                       WHERE dp.person_id = p.id ORDER BY dp.is_primary DESC, d.updated_at DESC LIMIT 1)) AS deal_id
      FROM persons p WHERE p.id = ${personId} AND p.deleted_at IS NULL`;
    if (p) { contact = p.full_name; to = p.email; dealId = p.deal_id; }
  }
  if (!contact) {
    // Sin contacto: datos de ejemplo, con los tuyos como remitente.
    const [u] = await sql<{ name: string; email: string | null }[]>`SELECT name, email FROM users WHERE id = ${userId}`;
    vars = { ...sampleVars(), remitente: u?.name ?? "", remitente_nombre: (u?.name ?? "").split(/\s+/)[0], remitente_email: conn?.email ?? u?.email ?? "",
             responsable: u?.name ?? "" };
  }
  const c = await composeEmail({
    subject: d.subject, body: d.body, format: d.format, personId: personId ?? "00000000-0000-0000-0000-000000000000", dealId,
    senderId: userId, conn, settings: seq ?? undefined, vars,
  });
  return { c, contact, to };
}

/** Vista previa del correo tal y como le llegaría a un contacto (o con datos de ejemplo). */
export async function previewEmailAction(d: EditorDraft): Promise<PreviewResult> {
  try {
    const user = await writerUser();
    const { c, contact, to } = await compose(d, user.id);
    return { subject: c.subject, html: c.html ?? textToHtml(c.text), missing: c.missing, unknown: c.unknown, errors: c.errors, contact, to };
  } catch (err) {
    return { error: err instanceof Error ? err.message : toUserMessage(err) };
  }
}

/** Envía una prueba (a ti o a la dirección que digas), con los datos del contacto elegido. */
export async function sendTestEmailAction(d: EditorDraft & { to?: string }): Promise<{ error?: string; message?: string }> {
  try {
    const user = await writerUser();
    const conn = await connectionOf(user.id);
    if (!conn || conn.status !== "active") return { error: "Conecta tu correo en Ajustes → Correo para enviar pruebas." };
    const to = (d.to ?? "").trim() || conn.email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { error: "Escribe una dirección de correo válida." };
    const { c, contact } = await compose(d, user.id);
    const html = c.html ?? textToHtml(c.text);
    await sendPlainEmail(conn, to, `[Prueba] ${c.subject || "(sin asunto)"}`, c.html ? htmlToText(html) : c.text, html);
    const gaps = [...c.missing, ...c.unknown];
    return {
      message: `Prueba enviada a ${to}${contact ? ` con los datos de ${contact}` : " con datos de ejemplo"}.`
        + (gaps.length ? ` Ojo: faltan ${gaps.map((k) => `{{${k}}}`).join(", ")} (a ese contacto no le saldría).` : ""),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : toUserMessage(err) };
  }
}

export type AiMode = "escribir" | "mejorar" | "acortar" | "tono" | "asuntos";

/** Redacta o mejora el correo con la IA (respetando las variables). */
export async function aiEmailAction(d: EditorDraft & { mode: AiMode; instructions?: string; tone?: string }): Promise<{ error?: string; subject?: string; body?: string }> {
  try {
    const user = await writerUser();
    let contacto: MergeVars | null = null;
    if (d.personId && isId(d.personId)) {
      const v = await mergeContext({ personId: d.personId });
      contacto = Object.fromEntries(Object.entries(v).filter(([k]) => !["enlace_baja", "email", "telefono"].includes(k)));
    }
    const [icp] = await sql<{ sectors: string[]; roles: string[]; must_have: string | null }[]>`SELECT sectors, roles, must_have FROM icp_profile LIMIT 1`;
    const reply = await generate("write_email", {
      accion: d.mode, formato: d.format, instrucciones: d.instructions?.slice(0, 2000) ?? "", tono: d.tone ?? "",
      asunto_actual: d.subject, correo_actual: d.format === "html" ? d.body : d.body.slice(0, 20000),
      variables: VARIABLES.map((v) => ({ variable: `{{${v.key}}}`, que_es: v.label })),
      ejemplo_de_contacto: contacto, remitente: user.name, perfil_de_cliente: icp ? { sectores: icp.sectors, cargos: icp.roles, otros: icp.must_have } : null,
    }, { maxTokens: 1500 });
    if (!reply) return { error: "La IA no está configurada o no ha respondido (Ajustes → IA)." };
    const j = parseJsonReply<{ asunto?: string; texto?: string }>(reply);
    if (!j?.texto && !j?.asunto) return { error: "La IA no devolvió un correo válido. Prueba otra vez." };
    const body = j.texto ? (d.format === "html" ? sanitizeEmailHtml(/<\w/.test(j.texto) ? j.texto : textToHtml(j.texto)) : /<\w/.test(j.texto) ? htmlToText(j.texto) : j.texto) : undefined;
    return { subject: j.asunto?.trim(), body };
  } catch (err) {
    return { error: err instanceof Error ? err.message : toUserMessage(err) };
  }
}

/** Guarda el correo como plantilla (tuya). */
export async function saveEmailTemplateAction(d: { name: string; subject: string; body: string; format: Format }): Promise<{ error?: string; message?: string; id?: string }> {
  try {
    const user = await writerUser();
    const id = await saveTemplate(user, null, { name: d.name, subject: d.subject, body: d.body, format: d.format });
    return { message: `Plantilla «${d.name}» guardada.`, id: id ?? undefined };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}

/** Firma de los correos de la persona (HTML saneado). */
export async function saveSignatureAction(_: { error?: string; ok?: boolean; message?: string } | undefined, form: FormData) {
  try {
    const user = await writerUser();
    const html = sanitizeEmailHtml(String(form.get("signature") ?? ""));
    if (html.length > 10000) return { error: "La firma es demasiado larga." };
    await sql`UPDATE users SET email_signature = ${htmlToText(html).trim() ? html : null} WHERE id = ${user.id}`;
    return { ok: true, message: "Firma guardada." };
  } catch (err) {
    return { error: err instanceof Error ? err.message : toUserMessage(err) };
  }
}
