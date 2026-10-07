import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";
import { createActivity } from "./activities";
import { connectionById, connectionOf, sendEmail, sentToday, warmupLimit, type Connection } from "./mailbox";
import { nextSendWindow, unsubscribeFooter, unsubscribeUrl, type Campaign } from "./campaigns";
import { isId, parse } from "./validation";
import { zonedToUtc } from "./slots";
import { mergeTemplate, usesVariable, type MergeVars } from "./merge";
import { escapeHtml, htmlToText, sanitizeEmailHtml, textToHtml } from "./email-html";
import { mergeContext } from "./merge-context";
import { signatureFor } from "./signatures";
import { notify } from "./notifications";

// ===========================================================================
// Secuencias: varios correos y tareas espaciados en días que salen solos
// desde el buzón del responsable y se paran en cuanto el contacto responde,
// agenda una reunión o el deal se cierra.
//
// Cada paso de correo puede ser automático o manual (se prepara el borrador
// y lo revisas y envías tú), con formato, variables, condiciones y pruebas
// A/B (variantes que se reparten a partes iguales). Si a un correo le falta
// un dato que no tiene valor por defecto, no sale: la inscripción queda en
// pausa hasta que se corrija y se reanude.
// ===========================================================================

export type StepKind = "email" | "manual_email" | "task";
export type Format = "text" | "html";

export type Sequence = {
  id: string; name: string; description: string | null; is_active: boolean; stop_on_reply: boolean; stop_on_meeting: boolean;
  steps: number; active: number; completed: number; replied: number; total: number; created_at: Date;
};

export type SequenceSettings = {
  send_days: number[]; send_from: number; send_to: number; track: boolean; add_signature: boolean; unsubscribe_link: boolean;
};

export type StepVariant = { id: string; label: string; subject: string; body: string; is_active: boolean };

export type SequenceStep = {
  id: string; position: number; delay_days: number; delay_hours: number; kind: StepKind; subject: string; body: string;
  task_type: string | null; format: Format; thread_reply: boolean; variants: StepVariant[];
};

export type Enrollment = {
  id: string; sequence_id: string; sequence_name: string; deal_id: string | null; deal_title: string | null;
  person_id: string; person_name: string; status: "active" | "paused" | "completed" | "stopped" | "failed"; next_step: number;
  steps: number; next_run_at: Date | null; stopped_reason: string | null; error: string | null; created_at: Date;
  user_name: string | null; waiting_activity_id: string | null;
};

export async function listSequences(): Promise<Sequence[]> {
  return sql<Sequence[]>`
    SELECT s.id, s.name, s.description, s.is_active, s.stop_on_reply, s.stop_on_meeting, s.created_at,
           (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id = s.id) AS steps,
           count(e.id) FILTER (WHERE e.status IN ('active', 'paused'))::int AS active,
           count(e.id) FILTER (WHERE e.status = 'completed')::int AS completed,
           count(e.id) FILTER (WHERE e.stopped_reason = 'Respondió')::int AS replied,
           count(e.id)::int AS total
    FROM sequences s LEFT JOIN sequence_enrollments e ON e.sequence_id = s.id
    GROUP BY s.id ORDER BY s.is_active DESC, lower(s.name)`;
}

async function loadSteps(sequenceId: string): Promise<SequenceStep[]> {
  const steps = await sql<Omit<SequenceStep, "variants">[]>`
    SELECT id, position, delay_days, delay_hours, kind, subject, body, task_type, format, thread_reply
    FROM sequence_steps WHERE sequence_id = ${sequenceId} ORDER BY position`;
  if (!steps.length) return [];
  const variants = await sql<(StepVariant & { step_id: string })[]>`
    SELECT id, step_id, label, subject, body, is_active FROM sequence_step_variants
    WHERE step_id IN ${sql(steps.map((s) => s.id))} ORDER BY label`;
  return steps.map((s) => ({ ...s, variants: variants.filter((v) => v.step_id === s.id).map(({ step_id: _, ...v }) => v) }));
}

export async function getSequence(id: string) {
  const [s] = await sql<(Omit<Sequence, "steps" | "active" | "completed" | "replied" | "total"> & SequenceSettings)[]>`
    SELECT id, name, description, is_active, stop_on_reply, stop_on_meeting, created_at,
           send_days, send_from, send_to, track, add_signature, unsubscribe_link
    FROM sequences WHERE id = ${id}`;
  if (!s) return null;
  return { ...s, steps: await loadSteps(id) };
}

const selectEnrollments = (where: ReturnType<typeof sql>) => sql<Enrollment[]>`
  SELECT e.id, e.sequence_id, s.name AS sequence_name, e.deal_id, d.title AS deal_title, e.person_id, p.full_name AS person_name,
         e.status, e.next_step, (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id = e.sequence_id) AS steps,
         e.next_run_at, e.stopped_reason, e.error, e.created_at, u.name AS user_name, e.waiting_activity_id
  FROM sequence_enrollments e
  JOIN sequences s ON s.id = e.sequence_id
  JOIN persons p ON p.id = e.person_id
  LEFT JOIN deals d ON d.id = e.deal_id
  LEFT JOIN users u ON u.id = e.user_id
  ${where}
  ORDER BY (e.status = 'paused') DESC, (e.status = 'active') DESC, e.created_at DESC
  LIMIT 300`;

export const listEnrollments = (ref: { sequenceId?: string; dealId?: string }) =>
  selectEnrollments(ref.sequenceId ? sql`WHERE e.sequence_id = ${ref.sequenceId}` : sql`WHERE e.deal_id = ${ref.dealId ?? null}`);

// ---------------------------------------------------------------------------
// Estadísticas por paso y variante

export type VariantStats = { step_id: string; variant: string; sent: number; opened: number; clicked: number; replied: number };

export async function sequenceStats(sequenceId: string): Promise<VariantStats[]> {
  return sql<VariantStats[]>`
    SELECT m.sequence_step_id AS step_id, coalesce(m.variant, 'A') AS variant, count(*)::int AS sent,
           count(*) FILTER (WHERE m.open_count > 0)::int AS opened,
           count(*) FILTER (WHERE m.click_count > 0)::int AS clicked,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM emails r WHERE r.person_id = m.person_id AND r.direction = 'in' AND r.sent_at > m.sent_at
               AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce'
               AND NOT EXISTS (SELECT 1 FROM emails m2 WHERE m2.enrollment_id = m.enrollment_id AND m2.direction = 'out'
                                 AND m2.sent_at > m.sent_at AND m2.sent_at < r.sent_at)))::int AS replied
    FROM emails m JOIN sequence_steps st ON st.id = m.sequence_step_id
    WHERE st.sequence_id = ${sequenceId} AND m.direction = 'out' AND m.status = 'sent'
    GROUP BY 1, 2 ORDER BY 1, 2`;
}

// ---------------------------------------------------------------------------
// Edición

const checkbox = z.string().optional().transform((v) => v === "on" || v === "true");

const seqSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120, "El nombre es demasiado largo"),
  description: z.string().trim().max(1000).optional(),
  is_active: z.string().optional(),
  stop_on_reply: z.string().optional(),
  stop_on_meeting: z.string().optional(),
});

export async function createSequence(actor: Actor, data: unknown): Promise<string> {
  const v = parse(seqSchema, data);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sequences (name, description, created_by) VALUES (${v.name}, ${v.description || null}, ${actor.id}) RETURNING id`;
  return row.id;
}

export async function updateSequence(id: string, data: unknown) {
  const v = parse(seqSchema, data);
  const res = await sql`
    UPDATE sequences SET name = ${v.name}, description = ${v.description || null}, is_active = ${v.is_active === "on"},
           stop_on_reply = ${v.stop_on_reply === "on"}, stop_on_meeting = ${v.stop_on_meeting === "on"}
    WHERE id = ${id}`;
  if (res.count === 0) throw new UserError("La secuencia no existe.");
}

const sendingSchema = z.object({
  send_days: z.array(z.coerce.number().int().min(1).max(7)).min(1, "Elige al menos un día de envío"),
  send_from: z.coerce.number().int().min(0).max(23),
  send_to: z.coerce.number().int().min(1).max(24),
  track: checkbox,
  add_signature: checkbox,
  unsubscribe_link: checkbox,
});

/** Ajustes de envío: días y horas, seguimiento, firma y enlace de baja. */
export async function updateSequenceSending(id: string, form: FormData) {
  const v = parse(sendingSchema, { ...Object.fromEntries(form), send_days: form.getAll("send_days").map(String) });
  if (v.send_to <= v.send_from) throw new UserError("La hora de fin debe ser posterior a la de inicio.");
  const res = await sql`
    UPDATE sequences SET send_days = ${[...new Set(v.send_days)].sort()}, send_from = ${v.send_from}, send_to = ${v.send_to},
           track = ${v.track}, add_signature = ${v.add_signature}, unsubscribe_link = ${v.unsubscribe_link}
    WHERE id = ${id}`;
  if (res.count === 0) throw new UserError("La secuencia no existe.");
}

export async function deleteSequence(id: string) {
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sequence_enrollments WHERE sequence_id = ${id} AND status IN ('active', 'paused')`;
  if (n > 0) throw new UserError(`Hay ${n} contacto${n === 1 ? "" : "s"} en marcha en esta secuencia: páralos o desactívala.`);
  await sql`DELETE FROM sequences WHERE id = ${id}`;
}

/** Comprueba que una plantilla está bien escrita (condiciones cerradas, variables que existen). */
export function assertTemplate(what: string, src: string) {
  const r = mergeTemplate(src, {});
  if (r.errors.length) throw new UserError(`${what}: ${r.errors[0]}`);
  const unknown = r.unknown.filter((k) => !/^(contacto|empresa|deal)\./.test(k));
  if (unknown.length) throw new UserError(`${what}: la variable {{${unknown[0]}}} no existe. Elígela en «Variables».`);
}

const stepSchema = z.object({
  kind: z.enum(["email", "manual_email", "task"], { message: "Tipo de paso no válido" }),
  delay_days: z.coerce.number().int().min(0, "Mínimo 0 días").max(90, "Máximo 90 días"),
  delay_hours: z.coerce.number().int().min(0).max(23).optional().default(0),
  subject: z.string().trim().max(300, "El asunto es demasiado largo").optional().default(""),
  body: z.string().max(100000).optional().default(""),
  format: z.enum(["text", "html"]).optional().default("text"),
  thread_reply: checkbox,
  task_type: z.string().trim().optional(),
});

function cleanBody(format: Format, body: string) {
  return format === "html" ? sanitizeEmailHtml(body) : body.replace(/\r\n/g, "\n");
}

export async function saveStep(sequenceId: string, stepId: string | null, data: unknown): Promise<string> {
  const v = parse(stepSchema, data);
  const isEmail = v.kind !== "task";
  const body = isEmail ? cleanBody(v.format, v.body) : v.body;
  const threadReply = isEmail && v.thread_reply;
  if (isEmail && !htmlToText(v.format === "html" ? body : escapeHtml(body)).trim()) throw new UserError("Falta el texto del correo.");
  if (!v.subject && !threadReply) throw new UserError("Falta el asunto.");
  if (isEmail) { assertTemplate("Asunto", v.subject); assertTemplate("Texto", body); }
  const taskType = v.kind === "task" ? v.task_type || "task" : null;
  const format = isEmail ? v.format : "text";
  if (stepId) {
    const res = await sql`UPDATE sequence_steps SET kind = ${v.kind}, delay_days = ${v.delay_days}, delay_hours = ${v.delay_hours},
                          subject = ${v.subject}, body = ${body}, task_type = ${taskType}, format = ${format}, thread_reply = ${threadReply}
                          WHERE id = ${stepId} AND sequence_id = ${sequenceId}`;
    if (res.count === 0) throw new UserError("El paso no existe.");
    return stepId;
  }
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sequence_steps (sequence_id, position, delay_days, delay_hours, kind, subject, body, task_type, format, thread_reply)
    VALUES (${sequenceId}, (SELECT coalesce(max(position), 0) + 1 FROM sequence_steps WHERE sequence_id = ${sequenceId}),
            ${v.delay_days}, ${v.delay_hours}, ${v.kind}, ${v.subject}, ${body}, ${taskType}, ${format}, ${threadReply})
    RETURNING id`;
  return row.id;
}

export async function deleteStep(sequenceId: string, stepId: string) {
  await sql.begin(async (tx) => {
    const [st] = await tx<{ position: number }[]>`DELETE FROM sequence_steps WHERE id = ${stepId} AND sequence_id = ${sequenceId} RETURNING position`;
    if (!st) return;
    await tx`UPDATE sequence_steps SET position = position - 1 WHERE sequence_id = ${sequenceId} AND position > ${st.position}`;
    // Quien estaba esperando un paso posterior no se lo salta.
    await tx`UPDATE sequence_enrollments SET next_step = next_step - 1
             WHERE sequence_id = ${sequenceId} AND status IN ('active', 'paused') AND next_step >= ${st.position}`;
  });
}

/** Sube o baja un paso. */
export async function moveStep(sequenceId: string, stepId: string, dir: -1 | 1) {
  await sql.begin(async (tx) => {
    const [st] = await tx<{ position: number }[]>`SELECT position FROM sequence_steps WHERE id = ${stepId} AND sequence_id = ${sequenceId} FOR UPDATE`;
    if (!st) return;
    const [other] = await tx<{ id: string }[]>`SELECT id FROM sequence_steps WHERE sequence_id = ${sequenceId} AND position = ${st.position + dir} FOR UPDATE`;
    if (!other) return;
    await tx`UPDATE sequence_steps SET position = -1 WHERE id = ${stepId}`;
    await tx`UPDATE sequence_steps SET position = ${st.position} WHERE id = ${other.id}`;
    await tx`UPDATE sequence_steps SET position = ${st.position + dir} WHERE id = ${stepId}`;
  });
}

// --- Variantes (pruebas A/B) ---

const variantSchema = z.object({
  subject: z.string().trim().max(300, "El asunto es demasiado largo").optional().default(""),
  body: z.string().max(100000).optional().default(""),
});

async function stepOf(sequenceId: string, stepId: string) {
  const [st] = await sql<{ kind: StepKind; format: Format; thread_reply: boolean }[]>`
    SELECT kind, format, thread_reply FROM sequence_steps WHERE id = ${stepId} AND sequence_id = ${sequenceId}`;
  if (!st) throw new UserError("El paso no existe.");
  if (st.kind === "task") throw new UserError("Solo los pasos de correo pueden tener variantes.");
  return st;
}

export async function saveVariant(sequenceId: string, stepId: string, variantId: string | null, data: unknown): Promise<string> {
  const st = await stepOf(sequenceId, stepId);
  const v = parse(variantSchema, data);
  const body = cleanBody(st.format, v.body);
  if (!htmlToText(st.format === "html" ? body : escapeHtml(body)).trim()) throw new UserError("Falta el texto del correo.");
  if (!v.subject && !st.thread_reply) throw new UserError("Falta el asunto.");
  assertTemplate("Asunto", v.subject); assertTemplate("Texto", body);
  if (variantId) {
    const res = await sql`UPDATE sequence_step_variants SET subject = ${v.subject}, body = ${body} WHERE id = ${variantId} AND step_id = ${stepId}`;
    if (res.count === 0) throw new UserError("La variante no existe.");
    return variantId;
  }
  const used = (await sql<{ label: string }[]>`SELECT label FROM sequence_step_variants WHERE step_id = ${stepId}`).map((r) => r.label);
  const label = "BCDEFGHIJKLMNOPQRSTUVWXYZ".split("").find((l) => !used.includes(l));
  if (!label) throw new UserError("Ya hay demasiadas variantes en este paso.");
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sequence_step_variants (step_id, label, subject, body) VALUES (${stepId}, ${label}, ${v.subject}, ${body}) RETURNING id`;
  return row.id;
}

export async function setVariantActive(sequenceId: string, stepId: string, variantId: string, active: boolean) {
  await stepOf(sequenceId, stepId);
  await sql`UPDATE sequence_step_variants SET is_active = ${active} WHERE id = ${variantId} AND step_id = ${stepId}`;
}

export async function deleteVariant(sequenceId: string, stepId: string, variantId: string) {
  await stepOf(sequenceId, stepId);
  await sql`DELETE FROM sequence_step_variants WHERE id = ${variantId} AND step_id = ${stepId}`;
}

/** Convierte una variante en la principal (la A) y la A pasa a ser esa variante: para quedarse con la ganadora. */
export async function promoteVariant(sequenceId: string, stepId: string, variantId: string) {
  await stepOf(sequenceId, stepId);
  await sql.begin(async (tx) => {
    const [v] = await tx<{ subject: string; body: string }[]>`SELECT subject, body FROM sequence_step_variants WHERE id = ${variantId} AND step_id = ${stepId}`;
    if (!v) return;
    const [st] = await tx<{ subject: string; body: string }[]>`SELECT subject, body FROM sequence_steps WHERE id = ${stepId}`;
    await tx`UPDATE sequence_steps SET subject = ${v.subject}, body = ${v.body} WHERE id = ${stepId}`;
    await tx`UPDATE sequence_step_variants SET subject = ${st.subject}, body = ${st.body}, is_active = false WHERE id = ${variantId}`;
  });
}

// ---------------------------------------------------------------------------
// Inscribir, parar y reanudar

/** Inscribe al contacto de un deal (por defecto, el principal). */
export async function enroll(actor: Actor, sequenceId: string, dealId: string, personId?: string | null): Promise<string> {
  if (!isId(sequenceId)) throw new UserError("Elige una secuencia.");
  if (personId && !isId(personId)) personId = null;
  const seq = await getSequence(sequenceId);
  if (!seq) throw new UserError("La secuencia no existe.");
  if (!seq.is_active) throw new UserError("La secuencia está desactivada.");
  if (seq.steps.length === 0) throw new UserError("La secuencia no tiene pasos.");
  const [d] = await sql<{ owner_id: string | null; status: string; person_id: string | null; email: string | null; unsubscribed: boolean }[]>`
    SELECT d.owner_id, d.status, p.id AS person_id, p.unsubscribed_at IS NOT NULL AS unsubscribed,
           (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email
    FROM deals d
    LEFT JOIN LATERAL (
      SELECT p.* FROM deal_participants dp JOIN persons p ON p.id = dp.person_id AND p.deleted_at IS NULL
      WHERE dp.deal_id = d.id AND (${personId ?? null}::uuid IS NULL OR p.id = ${personId ?? null}::uuid)
      ORDER BY dp.is_primary DESC, dp.created_at LIMIT 1
    ) p ON true
    WHERE d.id = ${dealId} AND d.deleted_at IS NULL`;
  if (!d) throw new UserError("El deal no existe.");
  if (d.status !== "open") throw new UserError("El deal ya está cerrado.");
  if (!d.person_id) throw new UserError("El deal no tiene contacto.");
  if (!d.email && seq.steps.some((s) => s.kind !== "task")) throw new UserError("El contacto no tiene email.");
  if (d.unsubscribed) throw new UserError("El contacto se dio de baja de las comunicaciones.");
  const [paused] = await sql`SELECT 1 FROM sequence_enrollments WHERE sequence_id = ${sequenceId} AND person_id = ${d.person_id} AND status = 'paused'`;
  if (paused) throw new UserError("Ese contacto ya está en esta secuencia (en pausa).");
  const sender = (d.owner_id && (await connectionOf(d.owner_id))?.status === "active") ? d.owner_id
    : actor.id && (await connectionOf(actor.id))?.status === "active" ? actor.id : d.owner_id ?? actor.id;
  const first = seq.steps[0];
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sequence_enrollments (sequence_id, deal_id, person_id, user_id, next_step, next_run_at, enrolled_by)
    VALUES (${sequenceId}, ${dealId}, ${d.person_id}, ${sender}, 0,
            now() + make_interval(days => ${first.delay_days}::int, hours => ${first.delay_hours}::int), ${actor.id})
    ON CONFLICT (sequence_id, person_id) WHERE status = 'active' DO NOTHING
    RETURNING id`;
  if (!row) throw new UserError("Ese contacto ya está en esta secuencia.");
  await recordEvent(sql, actor, "deal", dealId, "sequence.enrolled", { sequence_id: sequenceId, sequence: seq.name, enrollment_id: row.id });
  return row.id;
}

export async function stopEnrollment(actor: Actor, enrollmentId: string, reason = "Parada a mano") {
  const [e] = await sql<{ deal_id: string | null; name: string }[]>`
    UPDATE sequence_enrollments x SET status = 'stopped', stopped_reason = ${reason}, finished_at = now(), next_run_at = NULL
    FROM sequences s WHERE x.id = ${enrollmentId} AND x.status IN ('active', 'paused') AND s.id = x.sequence_id
    RETURNING x.deal_id, s.name`;
  if (!e) throw new UserError("Esa inscripción ya no está en marcha.");
  if (e.deal_id) await recordEvent(sql, actor, "deal", e.deal_id, "sequence.stopped", { sequence: e.name, reason });
}

/** Reanuda una inscripción en pausa (p. ej. tras completar los datos que faltaban). */
export async function resumeEnrollment(enrollmentId: string) {
  const [e] = await sql`
    UPDATE sequence_enrollments SET status = 'active', error = NULL, attempts = 0, next_run_at = now()
    WHERE id = ${enrollmentId} AND status = 'paused' RETURNING id`;
  if (!e) throw new UserError("Esa inscripción no está en pausa.");
}

// ---------------------------------------------------------------------------
// Composición de un correo de la secuencia

/** Lo que haría falta para rellenar las variables de un correo. */
export type ComposeInput = {
  subject: string; body: string; format: Format; personId: string; dealId?: string | null; senderId?: string | null;
  campaignContactId?: string | null; conn?: Connection | null; settings?: Partial<SequenceSettings>; campaign?: boolean;
  /** Valores ya calculados (la vista previa sin contacto usa los de ejemplo). */
  vars?: MergeVars;
};

export type Composed = { subject: string; html: string | null; text: string; missing: string[]; unknown: string[]; errors: string[] };

/** Rellena asunto y texto (con firma y enlace de baja si toca) para un contacto. */
export async function composeEmail(c: ComposeInput): Promise<Composed> {
  const html = c.format === "html";
  const signature = c.settings?.add_signature === false ? "" : await signatureFor(c.conn ?? c.senderId ?? null);
  const vars = c.vars ?? await mergeContext({
    personId: c.personId, dealId: c.dealId, senderId: c.senderId ?? c.conn?.user_id, campaignContactId: c.campaignContactId, conn: c.conn,
    wantSlots: usesVariable(c.body, "huecos") || usesVariable(c.subject, "huecos"),
  });
  const subj = mergeTemplate(c.subject, vars);
  const body = mergeTemplate(c.body, vars, { html });
  const sig = signature ? mergeTemplate(signature, vars, { html: true }).text : "";
  const unsubscribe = c.campaign || c.settings?.unsubscribe_link;
  const missing = [...new Set([...subj.missing, ...body.missing])];
  const unknown = [...new Set([...subj.unknown, ...body.unknown])];
  const errors = [...new Set([...subj.errors, ...body.errors])];
  const subject = subj.text.replace(/\s+/g, " ").trim();
  if (html) {
    let out = sanitizeEmailHtml(body.text);
    if (sig) out += `<div class="firma" style="margin-top:16px">${sanitizeEmailHtml(sig)}</div>`;
    if (unsubscribe) {
      out += `<p style="margin-top:24px;font-size:12px;color:#888888">Si prefieres no recibir más correos como este, `
        + `<a href="${escapeHtml(unsubscribeUrl(c.personId))}" data-notrack>date de baja aquí</a>.</p>`;
    }
    return { subject, html: out, text: htmlToText(out), missing, unknown, errors };
  }
  let text = body.text.replace(/\n{3,}/g, "\n\n").trim();
  if (sig) text += `\n\n${htmlToText(sig)}`;
  if (unsubscribe) text += unsubscribeFooter(c.personId);
  return { subject, html: null, text, missing, unknown, errors };
}

/** Variante que toca: la activa con menos envíos en este paso (reparto a partes iguales). */
async function pickVariant(step: SequenceStep): Promise<{ label: string; subject: string; body: string }> {
  const options = [{ label: "A", subject: step.subject, body: step.body }, ...step.variants.filter((v) => v.is_active)];
  if (options.length === 1) return options[0];
  const counts = await sql<{ variant: string; n: number }[]>`
    SELECT coalesce(variant, 'A') AS variant, count(*)::int AS n FROM emails WHERE sequence_step_id = ${step.id} GROUP BY 1`;
  const sent = (l: string) => counts.find((c) => c.variant === l)?.n ?? 0;
  return options.reduce((best, o) => (sent(o.label) < sent(best.label) ? o : best), options[0]);
}

/** Asunto del correo anterior de la inscripción (para responder en el mismo hilo). */
async function previousSubject(enrollmentId: string): Promise<string | null> {
  const [m] = await sql<{ subject: string }[]>`
    SELECT subject FROM emails WHERE enrollment_id = ${enrollmentId} AND direction = 'out' AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`;
  return m ? m.subject.replace(/^(re|rv|fw|fwd):\s*/i, "") : null;
}

// ---------------------------------------------------------------------------
// Correos manuales: el borrador ya preparado para revisarlo y enviarlo

export type ManualEmail = {
  activity_id: string; enrollment_id: string; sequence_id: string; sequence_name: string; step: number; person_id: string;
  person_name: string; deal_id: string | null; deal_title: string | null; to: string | null; subject: string; html: string;
  note: string | null; due_at: Date; owner_name: string | null;
};

export async function listManualEmails(userId: string | null, all = false): Promise<ManualEmail[]> {
  return sql<ManualEmail[]>`
    SELECT a.id AS activity_id, e.id AS enrollment_id, s.id AS sequence_id, s.name AS sequence_name, e.next_step + 1 AS step,
           p.id AS person_id, p.full_name AS person_name, d.id AS deal_id, d.title AS deal_title, a.draft_to AS to,
           coalesce(a.draft_subject, '') AS subject, coalesce(a.draft_html, '') AS html, a.note, a.due_at, u.name AS owner_name
    FROM sequence_enrollments e
    JOIN activities a ON a.id = e.waiting_activity_id AND NOT a.done
    JOIN sequences s ON s.id = e.sequence_id
    JOIN persons p ON p.id = e.person_id
    LEFT JOIN deals d ON d.id = e.deal_id
    LEFT JOIN users u ON u.id = a.owner_id
    WHERE e.status = 'active' AND (${all} OR a.owner_id = ${userId})
    ORDER BY a.due_at, a.created_at`;
}

/** Programa el paso siguiente (o da la inscripción por terminada). */
async function advance(enrollmentId: string, sequenceId: string, doneIndex: number, campaignContactId: string | null) {
  const steps = await sql<{ delay_days: number; delay_hours: number }[]>`
    SELECT delay_days, delay_hours FROM sequence_steps WHERE sequence_id = ${sequenceId} ORDER BY position`;
  const next = steps[doneIndex + 1];
  if (next) {
    await sql`UPDATE sequence_enrollments SET next_step = ${doneIndex + 1}, error = NULL, attempts = 0, waiting_activity_id = NULL,
                     next_run_at = now() + make_interval(days => ${next.delay_days}::int, hours => ${next.delay_hours}::int) WHERE id = ${enrollmentId}`;
  } else {
    await sql`UPDATE sequence_enrollments SET status = 'completed', next_step = ${steps.length}, next_run_at = NULL, finished_at = now(),
                     error = NULL, attempts = 0, waiting_activity_id = NULL WHERE id = ${enrollmentId}`;
    if (campaignContactId) await sql`UPDATE campaign_contacts SET status = 'completed', updated_at = now() WHERE id = ${campaignContactId} AND status = 'enrolled'`;
  }
}

const manualSchema = z.object({
  subject: z.string().trim().min(1, "Falta el asunto").max(300),
  body: z.string().max(100000),
});

/** Envía el correo manual (con los cambios que hayas hecho) y sigue la secuencia. */
export async function sendManualEmail(actor: Actor, activityId: string, data: unknown) {
  const v = parse(manualSchema, data);
  const [w] = await sql<{ id: string; sequence_id: string; next_step: number; person_id: string; deal_id: string | null; user_id: string | null;
                          mailbox_id: string | null; campaign_contact_id: string | null; draft_to: string | null; full_name: string | null;
                          organization_id: string | null; track: boolean }[]>`
    SELECT e.id, e.sequence_id, e.next_step, e.person_id, e.deal_id, e.user_id, e.mailbox_id, e.campaign_contact_id, a.draft_to,
           p.full_name, (SELECT organization_id FROM deals WHERE id = e.deal_id) AS organization_id, s.track
    FROM sequence_enrollments e JOIN activities a ON a.id = e.waiting_activity_id JOIN persons p ON p.id = e.person_id
    JOIN sequences s ON s.id = e.sequence_id
    WHERE e.waiting_activity_id = ${activityId} AND e.status = 'active' AND NOT a.done`;
  if (!w) throw new UserError("Ese correo ya se envió o la secuencia se paró.");
  if (!w.draft_to) throw new UserError("El contacto no tiene email.");
  const html = sanitizeEmailHtml(v.body);
  if (!htmlToText(html).trim()) throw new UserError("Falta el texto del correo.");
  if (/\{\{[^{}]+\}\}/.test(html) || /\{\{[^{}]+\}\}/.test(v.subject)) throw new UserError("Quedan variables sin rellenar: completa el texto antes de enviarlo.");
  const conn = w.mailbox_id ? await connectionById(w.mailbox_id) : await connectionOf(actor.id ?? w.user_id ?? "");
  if (!conn || conn.status !== "active") throw new UserError("Conecta tu correo en Ajustes → Correo para poder enviarlo.");
  const [step] = await sql<{ id: string }[]>`SELECT id FROM sequence_steps WHERE sequence_id = ${w.sequence_id} ORDER BY position OFFSET ${w.next_step} LIMIT 1`;
  const sent = await sendEmail(conn, actor, {
    to: { email: w.draft_to, name: w.full_name }, subject: v.subject, body: htmlToText(html), html,
    dealId: w.deal_id, personId: w.person_id, organizationId: w.organization_id, track: w.track ? undefined : false,
  });
  await sql`UPDATE emails SET enrollment_id = ${w.id}, sequence_step_id = ${step?.id ?? null}, variant = 'A' WHERE id = ${sent.emailId}`;
  await sql`UPDATE activities SET done = true, done_at = now() WHERE id = ${activityId}`;
  await advance(w.id, w.sequence_id, w.next_step, w.campaign_contact_id);
}

/** Salta el correo manual (no se envía) y sigue con el paso siguiente. */
export async function skipManualEmail(activityId: string) {
  const [w] = await sql<{ id: string; sequence_id: string; next_step: number; campaign_contact_id: string | null }[]>`
    SELECT id, sequence_id, next_step, campaign_contact_id FROM sequence_enrollments WHERE waiting_activity_id = ${activityId} AND status = 'active'`;
  if (!w) throw new UserError("Ese correo ya no está pendiente.");
  await sql`UPDATE activities SET done = true, done_at = now() WHERE id = ${activityId}`;
  await advance(w.id, w.sequence_id, w.next_step, w.campaign_contact_id);
}

// ---------------------------------------------------------------------------
// Motor (lo llama la revisión periódica)

const SYSTEM: Actor = { type: "system", id: null };

/** Para las inscripciones cuyo contacto ya respondió, agendó o cuyo deal se cerró. */
async function stopFinished(): Promise<number> {
  const stop = async (reason: string, where: ReturnType<typeof sql>) => {
    const rows = await sql<{ deal_id: string | null; name: string }[]>`
      UPDATE sequence_enrollments e SET status = 'stopped', stopped_reason = ${reason}, finished_at = now(), next_run_at = NULL
      FROM sequences s
      WHERE s.id = e.sequence_id AND e.status IN ('active', 'paused') AND ${where}
      RETURNING e.deal_id, s.name`;
    for (const r of rows) if (r.deal_id) await recordEvent(sql, SYSTEM, "deal", r.deal_id, "sequence.stopped", { sequence: r.name, reason });
    return rows.length;
  };
  let n = 0;
  n += await stop("Respondió", sql`s.stop_on_reply AND EXISTS (
    SELECT 1 FROM emails m WHERE m.person_id = e.person_id AND m.direction = 'in' AND m.sent_at > e.created_at
      AND m.reply_class IS DISTINCT FROM 'ooo' AND m.reply_class IS DISTINCT FROM 'bounce')`);
  n += await stop("Agendó una reunión", sql`s.stop_on_meeting AND EXISTS (
    SELECT 1 FROM activities a JOIN activity_types t ON t.key = a.type AND t.is_session
    WHERE (a.deal_id = e.deal_id OR a.person_id = e.person_id) AND a.created_at > e.created_at AND a.enrollment_id IS NULL
      AND (a.due_at IS NULL OR a.due_at >= e.created_at))`);
  n += await stop("El deal se cerró", sql`EXISTS (
    SELECT 1 FROM deals d WHERE d.id = e.deal_id AND (d.status <> 'open' OR d.deleted_at IS NOT NULL))`);
  n += await stop("Se dio de baja", sql`EXISTS (SELECT 1 FROM persons p WHERE p.id = e.person_id AND p.unsubscribed_at IS NOT NULL)`);
  return n;
}

/** Correos manuales que se completaron o borraron sin enviarlos desde el CRM: la secuencia sigue. */
async function releaseWaiting() {
  const rows = await sql<{ id: string; sequence_id: string; next_step: number; campaign_contact_id: string | null }[]>`
    SELECT e.id, e.sequence_id, e.next_step, e.campaign_contact_id FROM sequence_enrollments e
    LEFT JOIN activities a ON a.id = e.waiting_activity_id
    WHERE e.status = 'active' AND e.next_run_at IS NULL AND e.waiting_activity_id IS NOT NULL
      AND (a.id IS NULL OR a.done)`;
  for (const r of rows) await advance(r.id, r.sequence_id, r.next_step, r.campaign_contact_id);
  // Si se borró la actividad, waiting_activity_id queda a NULL (ON DELETE SET NULL): también sigue.
  const orphans = await sql<{ id: string; sequence_id: string; next_step: number; campaign_contact_id: string | null }[]>`
    SELECT id, sequence_id, next_step, campaign_contact_id FROM sequence_enrollments
    WHERE status = 'active' AND next_run_at IS NULL AND waiting_activity_id IS NULL`;
  for (const r of orphans) await advance(r.id, r.sequence_id, r.next_step, r.campaign_contact_id);
}

/** Vencimiento de las tareas de una secuencia: al final del día de hoy (hora local). */
function endOfToday() {
  const tz = process.env.TZ || "Europe/Madrid";
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date()).split("-").map(Number);
  return zonedToUtc(y, m, d, 23, 59, tz).toISOString();
}

type CampaignCtx = Pick<Campaign, "send_days" | "send_from" | "send_to" | "status"> & {
  campaign_id: string; personal_line: string | null; organization: string | null; organization_id: string | null;
};

async function campaignContext(contactId: string): Promise<CampaignCtx | null> {
  const [c] = await sql<CampaignCtx[]>`
    SELECT c.id AS campaign_id, c.status, c.send_days, c.send_from, c.send_to, cc.personal_line, o.name AS organization, o.id AS organization_id
    FROM campaign_contacts cc JOIN campaigns c ON c.id = cc.campaign_id
    LEFT JOIN LATERAL (SELECT organization_id FROM person_organizations WHERE person_id = cc.person_id AND status = 'current' LIMIT 1) po ON true
    LEFT JOIN organizations o ON o.id = po.organization_id
    WHERE cc.id = ${contactId}`;
  return c ?? null;
}

/** ¿Puede salir ya este correo de campaña? Si no, cuándo reintentar (o null si hay que parar). */
async function campaignGate(c: CampaignCtx, mailboxId: string | null): Promise<{ ok: true } | { ok: false; retryAt: Date | null; reason: string }> {
  if (c.status === "finished") return { ok: false, retryAt: null, reason: "Campaña terminada" };
  if (c.status !== "active") return { ok: false, retryAt: new Date(Date.now() + 3600000), reason: "Campaña en pausa" };
  const window = nextSendWindow(c);
  if (window.getTime() > Date.now() + 60000) return { ok: false, retryAt: window, reason: "Fuera del horario de envío" };
  if (!mailboxId) return { ok: false, retryAt: null, reason: "Sin buzón de outbound" };
  const conn = await connectionById(mailboxId);
  if (!conn) return { ok: false, retryAt: null, reason: "El buzón de outbound ya no está conectado" };
  if (conn.paused) return { ok: false, retryAt: new Date(Date.now() + 3600000), reason: "Buzón en pausa" };
  if (await sentToday(mailboxId) >= warmupLimit(conn)) {
    // Cupo del día agotado: mañana, dentro del horario.
    return { ok: false, retryAt: nextSendWindow(c, new Date(Date.now() + 86400000 - (Date.now() % 86400000))), reason: "Límite diario del buzón" };
  }
  return { ok: true };
}

const missingText = (keys: string[]) => keys.map((k) => `{{${k}}}`).join(", ");

export async function processSequences(limit = 50): Promise<{ sent: number; tasks: number; manual: number; paused: number; stopped: number; failed: number }> {
  const out = { sent: 0, tasks: 0, manual: 0, paused: 0, stopped: await stopFinished(), failed: 0 };
  await releaseWaiting();
  const due = await sql<({ id: string; sequence_id: string; deal_id: string | null; person_id: string; user_id: string | null;
                          enrolled_by: string | null; next_step: number; mailbox_id: string | null; campaign_contact_id: string | null;
                          sequence_name: string; due_at: Date } & SequenceSettings)[]>`
    WITH picked AS (
      SELECT e.id, e.next_run_at AS due_at FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id AND s.is_active
      WHERE e.status = 'active' AND e.next_run_at <= now()
      ORDER BY e.next_run_at, e.created_at LIMIT ${limit} FOR UPDATE OF e SKIP LOCKED)
    UPDATE sequence_enrollments x SET next_run_at = now() + interval '10 minutes'   -- reclamada: nadie más la procesa a la vez
    FROM picked, sequences s
    WHERE x.id = picked.id AND s.id = x.sequence_id
    RETURNING picked.due_at, x.id, x.sequence_id, x.deal_id, x.person_id, x.user_id, x.enrolled_by, x.next_step, x.mailbox_id, x.campaign_contact_id,
              s.name AS sequence_name, s.send_days, s.send_from, s.send_to, s.track, s.add_signature, s.unsubscribe_link`;
  // En el orden en que vencían (RETURNING no lo garantiza): reparto A/B y envíos predecibles.
  due.sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
  for (const e of due) {
    // Campañas de outbound: horario, buzón en pausa y límite diario (con calentamiento).
    const camp = e.campaign_contact_id ? await campaignContext(e.campaign_contact_id) : null;
    if (e.campaign_contact_id) {
      const gate = camp ? await campaignGate(camp, e.mailbox_id) : { ok: false as const, retryAt: null, reason: "La campaña ya no existe" };
      if (!gate.ok) {
        if (gate.retryAt) await sql`UPDATE sequence_enrollments SET next_run_at = ${gate.retryAt} WHERE id = ${e.id}`;
        else await sql`UPDATE sequence_enrollments SET status = 'stopped', stopped_reason = ${gate.reason}, finished_at = now(), next_run_at = NULL WHERE id = ${e.id}`;
        continue;
      }
    } else {
      // Horario de envío de la secuencia.
      const window = nextSendWindow(e);
      if (window.getTime() > Date.now() + 60000) {
        await sql`UPDATE sequence_enrollments SET next_run_at = ${window} WHERE id = ${e.id}`;
        continue;
      }
    }
    const steps = await loadSteps(e.sequence_id);
    const step = steps[e.next_step];
    const actor: Actor = { type: "user", id: e.enrolled_by };
    try {
      if (!step) {
        await advance(e.id, e.sequence_id, e.next_step, e.campaign_contact_id);
        continue;
      }
      const [p] = await sql<{ full_name: string; email: string | null; organization_id: string | null }[]>`
        SELECT p.full_name, (SELECT email FROM person_emails WHERE person_id = p.id AND bounced_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
               (SELECT organization_id FROM deals WHERE id = ${e.deal_id}) AS organization_id
        FROM persons p WHERE p.id = ${e.person_id}`;
      if (step.kind === "email" || step.kind === "manual_email") {
        const conn = e.mailbox_id ? await connectionById(e.mailbox_id) : e.user_id ? await connectionOf(e.user_id) : null;
        if (step.kind === "email" && (!conn || conn.status !== "active")) throw new Error("La cuenta de correo del responsable no está conectada.");
        if (!p?.email) throw new Error("El contacto ya no tiene email.");
        const variant = step.kind === "email" ? await pickVariant(step) : { label: "A", subject: step.subject, body: step.body };
        let subjectT = variant.subject;
        if (step.thread_reply) {
          const prev = await previousSubject(e.id);
          if (prev) subjectT = `Re: ${prev}`;
        }
        const c = await composeEmail({
          subject: subjectT, body: variant.body, format: step.format, personId: e.person_id, dealId: e.deal_id,
          senderId: conn?.user_id ?? e.user_id, campaignContactId: e.campaign_contact_id, conn, settings: e, campaign: Boolean(camp),
        });
        if (step.kind === "manual_email") {
          // Se prepara el borrador; lo que falte se ve (y se corrige) antes de enviarlo.
          const [d] = e.deal_id ? await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM deals WHERE id = ${e.deal_id}` : [];
          const missing = [...c.missing, ...c.unknown];
          const activityId = await createActivity(actor, {
            type: "email", subject: `Revisar y enviar: ${c.subject || "(sin asunto)"}`.slice(0, 300),
            note: `Correo manual de la secuencia «${e.sequence_name}» (paso ${step.position}). Revísalo y envíalo desde Secuencias → Correos por enviar.`
              + (missing.length ? `\nFaltan datos: ${missingText(missing)}.` : ""),
            due_at: endOfToday(), deal_id: e.deal_id ?? undefined, person_id: e.person_id, owner_id: d?.owner_id ?? e.user_id ?? undefined,
          });
          const draft = c.html ?? textToHtml(c.text);
          await sql`UPDATE activities SET enrollment_id = ${e.id}, draft_subject = ${c.subject}, draft_html = ${draft}, draft_to = ${p.email}
                    WHERE id = ${activityId}`;
          await sql`UPDATE sequence_enrollments SET waiting_activity_id = ${activityId}, next_run_at = NULL, error = NULL, attempts = 0 WHERE id = ${e.id}`;
          out.manual++;
          continue;
        }
        const problems = [...c.errors, ...(c.unknown.length ? [`variables desconocidas ${missingText(c.unknown)}`] : []),
                          ...(c.missing.length ? [`faltan datos: ${missingText(c.missing)}`] : [])];
        if (problems.length || (!c.subject && !step.thread_reply)) {
          // No se envía un «Hola ,»: queda en pausa hasta que se complete el contacto y se reanude.
          const msg = `Paso ${step.position} sin enviar: ${problems.join("; ") || "asunto vacío"}.`;
          await sql`UPDATE sequence_enrollments SET status = 'paused', error = ${msg.slice(0, 300)}, next_run_at = NULL WHERE id = ${e.id}`;
          const owner = e.user_id ?? e.enrolled_by;
          if (owner) await notify(sql, { userId: owner, kind: "sequence", title: `Secuencia en pausa: ${p.full_name}`, body: msg, link: `/sequences/${e.sequence_id}` });
          out.paused++;
          continue;
        }
        const sent = await sendEmail(conn!, actor, {
          to: { email: p.email, name: p.full_name }, subject: c.subject || "(sin asunto)", body: c.text, html: c.html,
          dealId: e.deal_id, personId: e.person_id, organizationId: p.organization_id ?? camp?.organization_id ?? null,
          track: e.track ? undefined : false,
        });
        await sql`UPDATE emails SET enrollment_id = ${e.id}, campaign_id = ${camp?.campaign_id ?? null}, sequence_step_id = ${step.id},
                         variant = ${variant.label} WHERE id = ${sent.emailId}`;
        out.sent++;
      } else {
        const [d] = e.deal_id ? await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM deals WHERE id = ${e.deal_id}` : [];
        const vars = await mergeContext({ personId: e.person_id, dealId: e.deal_id, senderId: e.user_id, campaignContactId: e.campaign_contact_id });
        const activityId = await createActivity(actor, {
          type: step.task_type ?? "task", subject: (mergeTemplate(step.subject, vars).text || "Tarea de la secuencia").slice(0, 300),
          note: step.body ? mergeTemplate(step.body, vars).text : undefined, due_at: endOfToday(),
          deal_id: e.deal_id ?? undefined, person_id: e.person_id, owner_id: d?.owner_id ?? e.user_id ?? undefined,
        });
        await sql`UPDATE activities SET enrollment_id = ${e.id} WHERE id = ${activityId}`;
        out.tasks++;
      }
      await advance(e.id, e.sequence_id, e.next_step, e.campaign_contact_id);
    } catch (err) {
      out.failed++;
      // Se reintenta dentro de una hora; al tercer fallo seguido se da por fallida.
      const msg = err instanceof Error ? err.message.slice(0, 300) : "Error";
      await sql`
        UPDATE sequence_enrollments SET error = ${msg}, attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE status END,
          finished_at = CASE WHEN attempts + 1 >= 3 THEN now() END,
          next_run_at = CASE WHEN attempts + 1 >= 3 THEN NULL ELSE now() + interval '1 hour' END
        WHERE id = ${e.id}`;
    }
  }
  return out;
}
