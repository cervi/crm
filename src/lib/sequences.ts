import { isOn, recordBlocked } from "./switches";
import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";
import { createActivity } from "./activities";
import { connectionById, connectionOf, mailboxGate, sendEmail, type Connection } from "./mailbox";
import { classifyByRules, nextSendWindow, unsubscribeFooter, unsubscribeToken, unsubscribeUrl, type Campaign } from "./campaigns";
import { publicBase } from "./email-track";
import { isId, parse } from "./validation";
import { zonedToUtc } from "./slots";
import { mergeTemplate, usesVariable, type MergeVars } from "./merge";
import { escapeHtml, htmlToText, sanitizeEmailHtml, textToHtml } from "./email-html";
import { mergeContext } from "./merge-context";
import { signatureFor } from "./signatures";
import { notify } from "./notifications";
import { contactTz, endOfDay, getSchedule, nextSlot, scheduleTz, type SendSchedule } from "./send-schedule";
import { STEP_KINDS, isEmailKind, type Priority, type StepKind as Kind } from "./step-kinds";

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

export type StepKind = Kind;
export type Format = "text" | "html";

export type Sequence = {
  id: string; name: string; description: string | null; is_active: boolean; stop_on_reply: boolean; stop_on_meeting: boolean;
  steps: number; active: number; completed: number; replied: number; total: number; created_at: Date;
};

export type SequenceSettings = {
  send_days: number[]; send_from: number; send_to: number; track: boolean; add_signature: boolean; unsubscribe_link: boolean;
};

/** Reglas (como los «rulesets» de Apollo) y organización. */
export type SequenceRules = {
  schedule_id: string | null; folder: string | null; archived_at: Date | null; owner_id: string | null; daily_limit: number | null;
  pause_on_ooo: boolean; finish_on_click: boolean; same_account: "none" | "stop" | "delay"; same_account_days: number;
  call_after_opens: number | null; cc: string | null; bcc: string | null;
};

export type StepVariant = { id: string; label: string; subject: string; body: string; is_active: boolean };

export type SequenceStep = {
  id: string; position: number; delay_days: number; delay_hours: number; kind: StepKind; subject: string; body: string;
  task_type: string | null; format: Format; thread_reply: boolean; variants: StepVariant[]; priority: Priority; is_active: boolean;
};

export type Enrollment = {
  id: string; sequence_id: string; sequence_name: string; deal_id: string | null; deal_title: string | null;
  person_id: string; person_name: string; status: "active" | "paused" | "completed" | "stopped" | "failed" | "removed"; next_step: number;
  steps: number; next_run_at: Date | null; stopped_reason: string | null; error: string | null; created_at: Date;
  user_name: string | null; waiting_activity_id: string | null; resume_at: Date | null; paused_reason: string | null;
  email: string | null; organization_name: string | null; mailbox_email: string | null; mailbox_id: string | null; finished_at: Date | null;
  sent: number; opened: number; replied: boolean;
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
    SELECT id, position, delay_days, delay_hours, kind, subject, body, task_type, format, thread_reply, priority, is_active
    FROM sequence_steps WHERE sequence_id = ${sequenceId} ORDER BY position`;
  if (!steps.length) return [];
  const variants = await sql<(StepVariant & { step_id: string })[]>`
    SELECT id, step_id, label, subject, body, is_active FROM sequence_step_variants
    WHERE step_id IN ${sql(steps.map((s) => s.id))} ORDER BY label`;
  return steps.map((s) => ({ ...s, variants: variants.filter((v) => v.step_id === s.id).map(({ step_id: _, ...v }) => v) }));
}

export async function getSequence(id: string) {
  const [s] = await sql<(Omit<Sequence, "steps" | "active" | "completed" | "replied" | "total"> & SequenceSettings & SequenceRules)[]>`
    SELECT id, name, description, is_active, stop_on_reply, stop_on_meeting, created_at,
           send_days, send_from, send_to, track, add_signature, unsubscribe_link,
           schedule_id, folder, archived_at, owner_id, daily_limit, pause_on_ooo, finish_on_click, same_account, same_account_days,
           call_after_opens, cc, bcc
    FROM sequences WHERE id = ${id}`;
  if (!s) return null;
  return { ...s, steps: await loadSteps(id) };
}

const selectEnrollments = (where: ReturnType<typeof sql>) => sql<Enrollment[]>`
  SELECT e.id, e.sequence_id, s.name AS sequence_name, e.deal_id, d.title AS deal_title, e.person_id, p.full_name AS person_name,
         e.status, e.next_step, (SELECT count(*)::int FROM sequence_steps st WHERE st.sequence_id = e.sequence_id) AS steps,
         e.next_run_at, e.stopped_reason, e.error, e.created_at, u.name AS user_name, e.waiting_activity_id, e.resume_at, e.paused_reason,
         e.finished_at, e.mailbox_id,
         (SELECT email FROM person_emails pe WHERE pe.person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
         (SELECT o.name FROM person_organizations po JOIN organizations o ON o.id = po.organization_id
          WHERE po.person_id = p.id AND po.status = 'current' ORDER BY po.created_at DESC LIMIT 1) AS organization_name,
         coalesce(mb.email, (SELECT email FROM mailbox_connections WHERE user_id = e.user_id AND purpose = 'main' LIMIT 1)) AS mailbox_email,
         (SELECT count(*)::int FROM emails m WHERE m.enrollment_id = e.id AND m.direction = 'out' AND m.status = 'sent') AS sent,
         (SELECT count(*)::int FROM emails m WHERE m.enrollment_id = e.id AND m.direction = 'out' AND m.open_count > 0) AS opened,
         EXISTS (SELECT 1 FROM emails r WHERE r.person_id = e.person_id AND r.direction = 'in' AND r.sent_at > e.created_at
                   AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce') AS replied
  FROM sequence_enrollments e
  JOIN sequences s ON s.id = e.sequence_id
  JOIN persons p ON p.id = e.person_id
  LEFT JOIN deals d ON d.id = e.deal_id
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN mailbox_connections mb ON mb.id = e.mailbox_id
  ${where}
  ORDER BY (e.status = 'paused') DESC, (e.status = 'active') DESC, e.created_at DESC
  LIMIT 500`;

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
    INSERT INTO sequences (name, description, created_by, owner_id, schedule_id)
    VALUES (${v.name}, ${v.description || null}, ${actor.id}, ${actor.id}, (SELECT id FROM send_schedules WHERE is_default LIMIT 1)) RETURNING id`;
  return row.id;
}

export async function setSequenceActive(id: string, active: boolean) {
  if (active) {
    const [ex] = await sql<{ ex: boolean }[]>`SELECT example IS NOT NULL AS ex FROM sequences WHERE id = ${id}`;
    if (ex?.ex) throw new UserError("Es una secuencia de ejemplo y no envía nada. Para usarla de verdad, duplícala: la copia sale sin los contactos de muestra.");
  }
  const res = await sql`UPDATE sequences SET is_active = ${active} WHERE id = ${id} AND archived_at IS NULL`;
  if (res.count === 0) throw new UserError("La secuencia no existe o está archivada.");
}

const emailList = z.string().trim().max(500).optional().transform((v) => {
  const list = (v ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  for (const e of list) if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new UserError(`${e} no es un correo válido.`);
  return list.join(", ") || null;
});

const rulesSchema = z.object({
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120),
  description: z.string().trim().max(1000).optional(),
  folder: z.string().trim().max(60).optional(),
  owner_id: z.string().optional(),
  schedule_id: z.string().optional(),
  stop_on_reply: checkbox, stop_on_meeting: checkbox, pause_on_ooo: checkbox, finish_on_click: checkbox,
  same_account: z.enum(["none", "stop", "delay"]).optional().default("none"),
  same_account_days: z.coerce.number().int().min(1).max(90).optional().default(7),
  call_after_opens: z.string().optional(),
  daily_limit: z.string().optional(),
  track: checkbox, add_signature: checkbox, unsubscribe_link: checkbox,
  cc: emailList, bcc: emailList,
});

/** Ajustes de la secuencia: datos, horario, reglas y envío (como «Settings» en Apollo). */
export async function updateSequenceSettings(id: string, form: FormData) {
  const v = parse(rulesSchema, Object.fromEntries(form));
  const num = (x: string | undefined, min: number, max: number, what: string) => {
    if (!x?.trim()) return null;
    const n = Number(x);
    if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${what}: un número entre ${min} y ${max}, o vacío.`);
    return n;
  };
  const res = await sql`
    UPDATE sequences SET name = ${v.name}, description = ${v.description || null}, folder = ${v.folder || null},
           owner_id = ${isId(v.owner_id ?? "") ? v.owner_id! : null}, schedule_id = ${isId(v.schedule_id ?? "") ? v.schedule_id! : null},
           stop_on_reply = ${v.stop_on_reply}, stop_on_meeting = ${v.stop_on_meeting}, pause_on_ooo = ${v.pause_on_ooo}, finish_on_click = ${v.finish_on_click},
           same_account = ${v.same_account}, same_account_days = ${v.same_account_days},
           call_after_opens = ${num(v.call_after_opens, 1, 50, "Aperturas para crear la llamada")},
           daily_limit = ${num(v.daily_limit, 1, 5000, "Límite diario de la secuencia")},
           track = ${v.track}, add_signature = ${v.add_signature}, unsubscribe_link = ${v.unsubscribe_link}, cc = ${v.cc}, bcc = ${v.bcc}
    WHERE id = ${id}`;
  if (res.count === 0) throw new UserError("La secuencia no existe.");
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
  kind: z.enum(Object.keys(STEP_KINDS) as [Kind, ...Kind[]], { message: "Tipo de paso no válido" }),
  priority: z.enum(["high", "medium", "low"]).optional().default("medium"),
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
  const isEmail = isEmailKind(v.kind);
  // Las tareas (llamada, LinkedIn…) llevan un título; si no se escribe, el de su tipo.
  if (!isEmail && !v.subject) v.subject = STEP_KINDS[v.kind].title || stepTitleFallback(v.kind);
  const body = isEmail ? cleanBody(v.format, v.body) : v.body;
  const threadReply = isEmail && v.thread_reply;
  if (isEmail && !htmlToText(v.format === "html" ? body : escapeHtml(body)).trim()) throw new UserError("Falta el texto del correo.");
  if (!v.subject && !threadReply) throw new UserError(isEmail ? "Falta el asunto." : "Falta el título de la tarea.");
  if (isEmail) { assertTemplate("Asunto", v.subject); assertTemplate("Texto", body); }
  else { assertTemplate("Título", v.subject); if (body) assertTemplate("Instrucciones", body); }
  const taskType = isEmail ? null : v.kind === "task" ? v.task_type || "task" : STEP_KINDS[v.kind].activity;
  const format = isEmail ? v.format : "text";
  if (stepId) {
    const res = await sql`UPDATE sequence_steps SET kind = ${v.kind}, delay_days = ${v.delay_days}, delay_hours = ${v.delay_hours},
                          subject = ${v.subject}, body = ${body}, task_type = ${taskType}, format = ${format}, thread_reply = ${threadReply},
                          priority = ${v.priority}
                          WHERE id = ${stepId} AND sequence_id = ${sequenceId}`;
    if (res.count === 0) throw new UserError("El paso no existe.");
    return stepId;
  }
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sequence_steps (sequence_id, position, delay_days, delay_hours, kind, subject, body, task_type, format, thread_reply, priority)
    VALUES (${sequenceId}, (SELECT coalesce(max(position), 0) + 1 FROM sequence_steps WHERE sequence_id = ${sequenceId}),
            ${v.delay_days}, ${v.delay_hours}, ${v.kind}, ${v.subject}, ${body}, ${taskType}, ${format}, ${threadReply}, ${v.priority})
    RETURNING id`;
  return row.id;
}

const stepTitleFallback = (k: Kind) => `${STEP_KINDS[k].short} con {{nombre_completo}}`;

/** Activa o desactiva un paso: los desactivados se saltan (como en Apollo). */
export async function setStepActive(sequenceId: string, stepId: string, active: boolean) {
  await sql`UPDATE sequence_steps SET is_active = ${active} WHERE id = ${stepId} AND sequence_id = ${sequenceId}`;
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
  if (!isEmailKind(st.kind)) throw new UserError("Solo los pasos de correo pueden tener variantes.");
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

/** Inscribe a un contacto sin deal (desde su ficha): sale desde el buzón de su responsable o el tuyo. */
export async function enrollPerson(actor: Actor, sequenceId: string, personId: string): Promise<string> {
  if (!isId(sequenceId)) throw new UserError("Elige una secuencia.");
  if (!isId(personId)) throw new UserError("Contacto no válido.");
  // Si tiene un deal abierto, mejor con él: así la secuencia se para si el deal se cierra.
  const [d] = await sql<{ id: string }[]>`
    SELECT d.id FROM deal_participants dp JOIN deals d ON d.id = dp.deal_id AND d.status = 'open' AND d.deleted_at IS NULL
    WHERE dp.person_id = ${personId} ORDER BY dp.is_primary DESC, d.updated_at DESC LIMIT 1`;
  if (d) return enroll(actor, sequenceId, d.id, personId);
  const seq = await getSequence(sequenceId);
  if (!seq) throw new UserError("La secuencia no existe.");
  if (!seq.is_active) throw new UserError("La secuencia está desactivada.");
  if (seq.steps.length === 0) throw new UserError("La secuencia no tiene pasos.");
  const [p] = await sql<{ owner_id: string | null; email: string | null; unsubscribed: boolean }[]>`
    SELECT p.owner_id, p.unsubscribed_at IS NOT NULL AS unsubscribed,
           (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email
    FROM persons p WHERE p.id = ${personId} AND p.deleted_at IS NULL`;
  if (!p) throw new UserError("El contacto no existe.");
  if (!p.email && seq.steps.some((s) => s.kind !== "task")) throw new UserError("El contacto no tiene email.");
  if (p.unsubscribed) throw new UserError("El contacto se dio de baja de las comunicaciones.");
  const [busy] = await sql`SELECT 1 FROM sequence_enrollments WHERE sequence_id = ${sequenceId} AND person_id = ${personId} AND status IN ('active', 'paused')`;
  if (busy) throw new UserError("Ese contacto ya está en esta secuencia.");
  const sender = (p.owner_id && (await connectionOf(p.owner_id))?.status === "active") ? p.owner_id : actor.id ?? p.owner_id;
  const first = seq.steps[0];
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO sequence_enrollments (sequence_id, deal_id, person_id, user_id, next_step, next_run_at, enrolled_by)
    VALUES (${sequenceId}, NULL, ${personId}, ${sender}, 0,
            now() + make_interval(days => ${first.delay_days}::int, hours => ${first.delay_hours}::int), ${actor.id})
    ON CONFLICT (sequence_id, person_id) WHERE status = 'active' DO NOTHING RETURNING id`;
  if (!row) throw new UserError("Ese contacto ya está en esta secuencia.");
  await recordEvent(sql, actor, "person", personId, "sequence.enrolled", { sequence_id: sequenceId, sequence: seq.name, enrollment_id: row.id });
  return row.id;
}

/** Inscripciones de un contacto (todas, con o sin deal). */
export const listPersonEnrollments = (personId: string) => selectEnrollments(sql`WHERE e.person_id = ${personId}`);

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
    UPDATE sequence_enrollments SET status = 'active', error = NULL, attempts = 0, paused_reason = NULL, resume_at = NULL,
           next_run_at = CASE WHEN waiting_activity_id IS NULL THEN now() ELSE NULL END
    WHERE id = ${enrollmentId} AND status = 'paused' RETURNING id`;
  if (!e) throw new UserError("Esa inscripción no está en pausa.");
}

// ---------------------------------------------------------------------------
// Gestión de contactos de una secuencia (como la pestaña «Contacts» de Apollo)

export type BulkOp = "pause" | "resume" | "finish" | "remove" | "mailbox" | "step" | "retry";

/** Tarea o correo manual pendiente de una inscripción: se quita si ya no hace falta. */
const dropWaiting = (ids: string[]) => sql`
  DELETE FROM activities a USING sequence_enrollments e
  WHERE e.id IN ${sql(ids)} AND a.id = e.waiting_activity_id AND NOT a.done`;

export async function bulkEnrollments(actor: Actor, sequenceId: string, ids: string[], op: BulkOp,
                                      opts: { resumeAt?: string | null; reason?: string | null; mailboxId?: string | null; step?: number | null } = {}): Promise<number> {
  const list = ids.filter(isId);
  if (!list.length) throw new UserError("Selecciona al menos un contacto.");
  const mine = sql`sequence_id = ${sequenceId} AND id IN ${sql(list)}`;
  let n = 0;
  switch (op) {
    case "pause": {
      const at = opts.resumeAt ? new Date(opts.resumeAt) : null;
      if (at && (Number.isNaN(at.getTime()) || at < new Date())) throw new UserError("La fecha de reanudación tiene que ser futura.");
      n = (await sql`UPDATE sequence_enrollments SET status = 'paused', paused_reason = 'Pausado a mano', resume_at = ${at}, next_run_at = NULL
                     WHERE ${mine} AND status = 'active'`).count;
      break;
    }
    case "resume":
      n = (await sql`UPDATE sequence_enrollments SET status = 'active', error = NULL, attempts = 0, paused_reason = NULL, resume_at = NULL,
                            next_run_at = CASE WHEN waiting_activity_id IS NULL THEN now() ELSE NULL END
                     WHERE ${mine} AND status = 'paused'`).count;
      break;
    case "retry":
      n = (await sql`UPDATE sequence_enrollments SET status = 'active', error = NULL, attempts = 0, finished_at = NULL, next_run_at = now()
                     WHERE ${mine} AND status = 'failed'`).count;
      break;
    case "finish": {
      const reason = (opts.reason ?? "").trim() || "Terminado a mano";
      await dropWaiting(list);
      n = (await sql`UPDATE sequence_enrollments SET status = 'stopped', stopped_reason = ${reason.slice(0, 120)}, finished_at = now(), next_run_at = NULL
                     WHERE ${mine} AND status IN ('active', 'paused')`).count;
      break;
    }
    case "remove":
      await dropWaiting(list);
      n = (await sql`UPDATE sequence_enrollments SET status = 'removed', stopped_reason = 'Quitado de la secuencia', finished_at = coalesce(finished_at, now()),
                            next_run_at = NULL WHERE ${mine} AND status <> 'removed'`).count;
      break;
    case "mailbox": {
      const conn = opts.mailboxId ? await connectionById(opts.mailboxId) : null;
      if (!conn) throw new UserError("Elige un buzón conectado.");
      n = (await sql`UPDATE sequence_enrollments SET user_id = ${conn.user_id}, mailbox_id = ${conn.purpose === "outbound" ? conn.id : null}
                     WHERE ${mine} AND status IN ('active', 'paused')`).count;
      break;
    }
    case "step": {
      const [{ total }] = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM sequence_steps WHERE sequence_id = ${sequenceId}`;
      const k = Number(opts.step);
      if (!Number.isInteger(k) || k < 0 || k >= total) throw new UserError("Elige un paso de la secuencia.");
      await dropWaiting(list);
      n = (await sql`UPDATE sequence_enrollments SET next_step = ${k}, waiting_activity_id = NULL, error = NULL, attempts = 0,
                            next_run_at = CASE WHEN status = 'active' THEN now() ELSE NULL END
                     WHERE ${mine} AND status IN ('active', 'paused')`).count;
      break;
    }
  }
  return n;
}

export type EnrollIssue = "no_email" | "bounced" | "unsubscribed" | "in_this" | "in_other" | "recent" | "missing_data";
export const ENROLL_ISSUES: Record<EnrollIssue, { label: string; blocking: boolean }> = {
  no_email: { label: "Sin email", blocking: true },
  bounced: { label: "Su email rebotó", blocking: true },
  unsubscribed: { label: "Se dio de baja", blocking: true },
  in_this: { label: "Ya está en esta secuencia", blocking: true },
  in_other: { label: "Está activo en otra secuencia", blocking: false },
  recent: { label: "Le escribiste hace menos de 7 días", blocking: false },
  missing_data: { label: "Le faltan datos que usan los correos", blocking: false },
};

export type EnrollCheck = { person_id: string; name: string; email: string | null; organization: string | null; issue: EnrollIssue | null; detail: string | null };

/** Comprobaciones de seguridad antes de añadir contactos (como los avisos de Apollo). */
export async function checkEnrollment(sequenceId: string, personIds: string[]): Promise<EnrollCheck[]> {
  const ids = [...new Set(personIds.filter(isId))].slice(0, 2000);
  if (!ids.length) return [];
  const loaded = await loadSteps(sequenceId);
  const needsEmail = loaded.some((st) => isEmailKind(st.kind) && st.is_active);
  // Variables sin valor por defecto que usan los correos: si al contacto le faltan, su correo se quedará en pausa.
  const text = loaded.filter((st) => isEmailKind(st.kind) && st.is_active).flatMap((st) => [st.subject, st.body, ...st.variants.map((v) => `${v.subject} ${v.body}`)]).join(" ");
  const uses = (k: string) => new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`).test(text);
  const rows = await sql<{ person_id: string; name: string; email: string | null; any_email: boolean; organization: string | null; unsubscribed: boolean;
                           in_this: boolean; other: string | null; recent: boolean; job_title: string | null; first_name: string | null }[]>`
    SELECT p.id AS person_id, p.full_name AS name,
           (SELECT email FROM person_emails WHERE person_id = p.id AND bounced_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           EXISTS (SELECT 1 FROM person_emails WHERE person_id = p.id) AS any_email,
           (SELECT o.name FROM person_organizations po JOIN organizations o ON o.id = po.organization_id
            WHERE po.person_id = p.id AND po.status = 'current' ORDER BY po.created_at DESC LIMIT 1) AS organization,
           p.unsubscribed_at IS NOT NULL AS unsubscribed, p.first_name,
           (SELECT job_title FROM person_organizations WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1) AS job_title,
           EXISTS (SELECT 1 FROM sequence_enrollments e WHERE e.person_id = p.id AND e.sequence_id = ${sequenceId} AND e.status IN ('active', 'paused')) AS in_this,
           (SELECT s.name FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id
            WHERE e.person_id = p.id AND e.sequence_id <> ${sequenceId} AND e.status IN ('active', 'paused') LIMIT 1) AS other,
           EXISTS (SELECT 1 FROM emails m WHERE m.person_id = p.id AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at > now() - interval '7 days') AS recent
    FROM persons p WHERE p.id IN ${sql(ids)} AND p.deleted_at IS NULL
    ORDER BY p.full_name`;
  return rows.map((r) => {
    const missing = [uses("empresa") && !r.organization ? "empresa" : null, uses("cargo") && !r.job_title ? "cargo" : null].filter(Boolean) as string[];
    const issue: EnrollIssue | null = r.in_this ? "in_this" : r.unsubscribed ? "unsubscribed"
      : needsEmail && !r.email ? (r.any_email ? "bounced" : "no_email")
      : r.other ? "in_other" : r.recent ? "recent" : missing.length ? "missing_data" : null;
    return { person_id: r.person_id, name: r.name, email: r.email, organization: r.organization, issue,
             detail: issue === "in_other" ? `En «${r.other}»` : issue === "missing_data" ? `Falta: ${missing.join(", ")} (su correo se quedará en pausa)` : null };
  });
}

/**
 * Añade contactos a una secuencia. Los que tienen un aviso que no bloquea (en
 * otra secuencia, contactado hace poco) solo entran si se marca. El buzón se
 * reparte entre los elegidos según su capacidad libre (como la rotación de Apollo).
 */
export async function enrollMany(actor: Actor, sequenceId: string, personIds: string[],
                                 opts: { mailboxIds?: string[]; include?: EnrollIssue[] } = {}): Promise<{ added: number; skipped: Partial<Record<EnrollIssue, number>> }> {
  const seq = await getSequence(sequenceId);
  if (!seq) throw new UserError("La secuencia no existe.");
  if (seq.archived_at) throw new UserError("La secuencia está archivada.");
  const [ex] = await sql<{ ex: boolean }[]>`SELECT example IS NOT NULL AS ex FROM sequences WHERE id = ${sequenceId}`;
  if (ex?.ex) throw new UserError("A la secuencia de ejemplo no se pueden añadir contactos. Duplícala para usarla con los tuyos.");
  if (!seq.steps.length) throw new UserError("La secuencia no tiene pasos.");
  const checks = await checkEnrollment(sequenceId, personIds);
  const include = new Set(opts.include ?? []);
  const skipped: Partial<Record<EnrollIssue, number>> = {};
  const ok = checks.filter((c) => {
    // «Le faltan datos» es solo un aviso: entra, y su correo se pausa hasta completarlo.
    if (!c.issue || c.issue === "missing_data" || (!ENROLL_ISSUES[c.issue].blocking && include.has(c.issue))) return true;
    skipped[c.issue] = (skipped[c.issue] ?? 0) + 1;
    return false;
  });
  // Buzones elegidos y su capacidad libre hoy.
  const conns = (await Promise.all((opts.mailboxIds ?? []).filter(isId).map((id) => connectionById(id)))).filter((c): c is Connection => Boolean(c && c.status === "active"));
  const capacity = new Map<string, number>();
  for (const c of conns) {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM emails WHERE mailbox_id = ${c.id} AND direction = 'out' AND enrollment_id IS NOT NULL AND sent_at > now() - interval '24 hours'`;
    capacity.set(c.id, (c.purpose === "outbound" ? Math.min(c.daily_limit, 10 + 5 * Math.max(0, Math.floor((Date.now() - new Date(`${c.warmup_start}T00:00:00`).getTime()) / 86400000))) : c.daily_limit) - n);
  }
  const first = seq.steps[0];
  let added = 0;
  for (const c of ok) {
    let conn: Connection | null = null;
    if (conns.length) {
      conn = conns.reduce((best, x) => ((capacity.get(x.id) ?? 0) > (capacity.get(best.id) ?? 0) ? x : best), conns[0]);
      capacity.set(conn.id, (capacity.get(conn.id) ?? 0) - 1);
    }
    const [d] = await sql<{ id: string; owner_id: string | null }[]>`
      SELECT d.id, d.owner_id FROM deal_participants dp JOIN deals d ON d.id = dp.deal_id AND d.status = 'open' AND d.deleted_at IS NULL
      WHERE dp.person_id = ${c.person_id} ORDER BY dp.is_primary DESC, d.updated_at DESC LIMIT 1`;
    let userId = conn?.user_id ?? null;
    if (!userId) {
      const [p] = await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM persons WHERE id = ${c.person_id}`;
      const candidate = d?.owner_id ?? p?.owner_id ?? null;
      userId = candidate && (await connectionOf(candidate))?.status === "active" ? candidate : actor.id ?? candidate;
    }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO sequence_enrollments (sequence_id, deal_id, person_id, user_id, mailbox_id, next_step, next_run_at, enrolled_by)
      VALUES (${sequenceId}, ${d?.id ?? null}, ${c.person_id}, ${userId}, ${conn?.purpose === "outbound" ? conn.id : null}, 0,
              now() + make_interval(days => ${first.delay_days}::int, hours => ${first.delay_hours}::int), ${actor.id})
      ON CONFLICT (sequence_id, person_id) WHERE status = 'active' DO NOTHING RETURNING id`;
    if (!row) { skipped.in_this = (skipped.in_this ?? 0) + 1; continue; }
    added++;
    await recordEvent(sql, actor, d ? "deal" : "person", d?.id ?? c.person_id, "sequence.enrolled", { sequence_id: sequenceId, sequence: seq.name, enrollment_id: row.id });
  }
  return { added, skipped };
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
                          organization_id: string | null; track: boolean; cc: string | null; bcc: string | null; unsubscribe_link: boolean }[]>`
    SELECT e.id, e.sequence_id, e.next_step, e.person_id, e.deal_id, e.user_id, e.mailbox_id, e.campaign_contact_id, a.draft_to,
           p.full_name, (SELECT organization_id FROM deals WHERE id = e.deal_id) AS organization_id, s.track, s.cc, s.bcc, s.unsubscribe_link
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
  const [step] = await sql<{ id: string; thread_reply: boolean }[]>`
    SELECT id, thread_reply FROM sequence_steps WHERE sequence_id = ${w.sequence_id} ORDER BY position OFFSET ${w.next_step} LIMIT 1`;
  const prev = step?.thread_reply ? await previousEmail(w.id) : null;
  const sent = await sendEmail(conn, actor, {
    to: { email: w.draft_to, name: w.full_name }, subject: v.subject, body: htmlToText(html), html,
    dealId: w.deal_id, personId: w.person_id, organizationId: w.organization_id, track: w.track ? undefined : false,
    cc: splitList(w.cc), bcc: splitList(w.bcc), replyToEmailId: prev?.id ?? null,
    listUnsubscribe: w.campaign_contact_id || w.unsubscribe_link ? oneClickUnsubscribeUrl(w.person_id) : null,
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
// Motor (lo llama la revisión periódica y, para los envíos, cada minuto)

const SYSTEM: Actor = { type: "system", id: null };

/** Correo anterior de la inscripción (para responder en el mismo hilo). */
async function previousEmail(enrollmentId: string): Promise<{ id: string; subject: string } | null> {
  const [m] = await sql<{ id: string; subject: string }[]>`
    SELECT id, subject FROM emails WHERE enrollment_id = ${enrollmentId} AND direction = 'out' AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`;
  return m ?? null;
}

/** Horario de una secuencia: el elegido o, en las antiguas, sus días y horas de siempre. */
async function scheduleOf(e: { schedule_id: string | null } & Pick<SequenceSettings, "send_days" | "send_from" | "send_to">): Promise<SendSchedule> {
  if (e.schedule_id) return getSchedule(e.schedule_id);
  const pad = (h: number) => (h >= 24 ? "23:59" : `${String(h).padStart(2, "0")}:00`);
  const blocks = Object.fromEntries(e.send_days.map((d) => [String(d), [[pad(e.send_from), pad(e.send_to)]] as [string, string][]]));
  return { id: "", name: "Horario de la secuencia", timezone: process.env.TZ || "Europe/Madrid", use_contact_tz: false, blocks,
           skip_holidays: false, holidays: [], is_default: false };
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/** Fecha de vuelta en una respuesta «fuera de la oficina» (15/10, 15 de octubre, October 15…), o null. */
export function returnDate(text: string, now = new Date()): Date | null {
  const t = text.toLowerCase();
  const found: Date[] = [];
  const add = (d: number, m: number, y?: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    let year = y ? (y < 100 ? 2000 + y : y) : now.getFullYear();
    let date = new Date(Date.UTC(year, m - 1, d, 8));
    if (!y && date < new Date(now.getTime() - 86400000)) { year++; date = new Date(Date.UTC(year, m - 1, d, 8)); }
    if (date > new Date(now.getTime() - 86400000) && date < new Date(now.getTime() + 120 * 86400000)) found.push(date);
  };
  for (const m of t.matchAll(/\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?\b/g)) add(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined);
  for (const m of t.matchAll(/\b(\d{1,2})\s+(?:de\s+)?([a-záéíóú]+)(?:\s+(?:de\s+)?(\d{4}))?/g)) if (MONTHS[m[2]]) add(Number(m[1]), MONTHS[m[2]], m[3] ? Number(m[3]) : undefined);
  for (const m of t.matchAll(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/g)) if (MONTHS[m[1]]) add(Number(m[2]), MONTHS[m[1]], m[3] ? Number(m[3]) : undefined);
  found.sort((a, b) => a.getTime() - b.getTime());
  return found[0] ?? null;
}

/**
 * Respuestas «fuera de la oficina»: no cuentan como respuesta. La inscripción
 * se pausa y se reanuda sola el día que vuelve (o en una semana si no lo dice).
 */
async function handleOutOfOffice(): Promise<number> {
  const rows = await sql<{ id: string; person_id: string; subject: string | null; body: string | null; sent_at: Date }[]>`
    SELECT DISTINCT ON (m.id) m.id, m.person_id, m.subject, m.body, m.sent_at
    FROM emails m JOIN sequence_enrollments e ON e.person_id = m.person_id AND e.status IN ('active', 'paused') AND m.sent_at > e.created_at
    WHERE m.direction = 'in' AND m.reply_class IS NULL
    LIMIT 100`;
  let n = 0;
  for (const r of rows) {
    const text = `${r.subject ?? ""}\n${r.body ?? ""}`;
    if (classifyByRules(text).clase !== "fuera_oficina") continue;
    const back = returnDate(text) ?? new Date(Date.now() + 7 * 86400000);
    const resume = new Date(Math.max(back.getTime() + 86400000, Date.now() + 3600000));
    await sql`UPDATE emails SET reply_class = 'ooo' WHERE id = ${r.id}`;
    const res = await sql`
      UPDATE sequence_enrollments e SET status = 'paused', paused_reason = 'Fuera de la oficina', resume_at = ${resume}, next_run_at = NULL
      FROM sequences s WHERE s.id = e.sequence_id AND s.pause_on_ooo AND e.person_id = ${r.person_id} AND e.status = 'active'`;
    n += res.count;
  }
  return n;
}

/** Pausas con fecha de reanudación que ya ha llegado. */
async function autoResume() {
  await sql`UPDATE sequence_enrollments SET status = 'active', paused_reason = NULL, resume_at = NULL, error = NULL, attempts = 0,
                   next_run_at = CASE WHEN waiting_activity_id IS NULL THEN now() ELSE NULL END
            WHERE status = 'paused' AND resume_at IS NOT NULL AND resume_at <= now()`;
}

/** Para las inscripciones cuyo contacto ya respondió, agendó, hizo clic, contestó la llamada o cuyo deal se cerró. */
async function stopFinished(): Promise<number> {
  const stop = async (reason: string, where: ReturnType<typeof sql>) => {
    const rows = await sql<{ deal_id: string | null; name: string; campaign_contact_id: string | null }[]>`
      UPDATE sequence_enrollments e SET status = 'stopped', stopped_reason = ${reason}, finished_at = now(), next_run_at = NULL
      FROM sequences s
      WHERE s.id = e.sequence_id AND e.status IN ('active', 'paused') AND ${where}
      RETURNING e.deal_id, s.name, e.campaign_contact_id`;
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
  n += await stop("Hizo clic en un enlace", sql`s.finish_on_click AND EXISTS (
    SELECT 1 FROM emails m WHERE m.enrollment_id = e.id AND m.direction = 'out' AND m.click_count > 0)`);
  n += await stop("Contestó la llamada", sql`EXISTS (
    SELECT 1 FROM activities a WHERE a.enrollment_id = e.id AND a.done AND a.call_outcome = 'answered')`);
  // Ha respondido otra persona de su misma empresa que estaba en esta secuencia.
  const colleague = sql`EXISTS (
    SELECT 1 FROM person_organizations me
    JOIN person_organizations other ON other.organization_id = me.organization_id AND other.status = 'current' AND other.person_id <> me.person_id
    JOIN sequence_enrollments oe ON oe.sequence_id = e.sequence_id AND oe.person_id = other.person_id
    JOIN emails r ON r.person_id = other.person_id AND r.direction = 'in' AND r.sent_at > oe.created_at AND r.sent_at > e.created_at
      AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce'
    WHERE me.person_id = e.person_id AND me.status = 'current')`;
  n += await stop("Respondió alguien de su empresa", sql`s.same_account = 'stop' AND ${colleague}`);
  // «Retrasar»: el siguiente paso espera N días desde esa respuesta.
  await sql`
    UPDATE sequence_enrollments e SET next_run_at = x.at + make_interval(days => s.same_account_days)
    FROM sequences s, (
      SELECT e2.id, max(r.sent_at) AS at
      FROM sequence_enrollments e2
      JOIN sequences s2 ON s2.id = e2.sequence_id AND s2.same_account = 'delay'
      JOIN person_organizations me ON me.person_id = e2.person_id AND me.status = 'current'
      JOIN person_organizations other ON other.organization_id = me.organization_id AND other.status = 'current' AND other.person_id <> me.person_id
      JOIN sequence_enrollments oe ON oe.sequence_id = e2.sequence_id AND oe.person_id = other.person_id
      JOIN emails r ON r.person_id = other.person_id AND r.direction = 'in' AND r.sent_at > oe.created_at AND r.sent_at > e2.created_at
        AND r.reply_class IS DISTINCT FROM 'ooo' AND r.reply_class IS DISTINCT FROM 'bounce'
      WHERE e2.status = 'active'
      GROUP BY e2.id) x
    WHERE x.id = e.id AND s.id = e.sequence_id AND e.next_run_at IS NOT NULL
      AND e.next_run_at < x.at + make_interval(days => s.same_account_days)`;
  n += await stop("El deal se cerró", sql`EXISTS (
    SELECT 1 FROM deals d WHERE d.id = e.deal_id AND (d.status <> 'open' OR d.deleted_at IS NOT NULL))`);
  n += await stop("Se dio de baja", sql`EXISTS (SELECT 1 FROM persons p WHERE p.id = e.person_id AND p.unsubscribed_at IS NOT NULL)`);
  return n;
}

/** Tras N aperturas, una tarea de llamada (una sola vez por inscripción). */
async function callAfterOpens(): Promise<number> {
  const rows = await sql<{ id: string; person_id: string; deal_id: string | null; user_id: string | null; name: string; full_name: string; opens: number }[]>`
    SELECT e.id, e.person_id, e.deal_id, e.user_id, s.name, p.full_name, x.opens
    FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id JOIN persons p ON p.id = e.person_id,
         LATERAL (SELECT coalesce(sum(open_count), 0)::int AS opens FROM emails m WHERE m.enrollment_id = e.id AND m.direction = 'out') x
    WHERE e.status = 'active' AND NOT e.call_task_created AND s.call_after_opens IS NOT NULL AND x.opens >= s.call_after_opens
    LIMIT 50`;
  for (const r of rows) {
    const [d] = r.deal_id ? await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM deals WHERE id = ${r.deal_id}` : [];
    const id = await createActivity(SYSTEM, {
      type: "call", subject: `Llamar a ${r.full_name}: ha abierto tus correos ${r.opens} veces`.slice(0, 300),
      note: `De la secuencia «${r.name}». Está caliente: buen momento para llamar.`, due_at: new Date().toISOString(),
      deal_id: r.deal_id ?? undefined, person_id: r.person_id, owner_id: d?.owner_id ?? r.user_id ?? undefined,
    });
    await sql`UPDATE activities SET priority = 'high', step_kind = 'call', enrollment_id = ${r.id} WHERE id = ${id}`;
    await sql`UPDATE sequence_enrollments SET call_task_created = true WHERE id = ${r.id}`;
  }
  return rows.length;
}

/** La tarea en la que esperaba una inscripción se ha hecho: sigue al momento (o termina si contestó la llamada). */
export async function continueAfter(actor: Actor, activityId: string) {
  const [w] = await sql<{ id: string; sequence_id: string; next_step: number; campaign_contact_id: string | null; deal_id: string | null;
                          answered: boolean; name: string }[]>`
    SELECT e.id, e.sequence_id, e.next_step, e.campaign_contact_id, e.deal_id, a.call_outcome = 'answered' AS answered, s.name
    FROM sequence_enrollments e JOIN activities a ON a.id = e.waiting_activity_id JOIN sequences s ON s.id = e.sequence_id
    WHERE e.waiting_activity_id = ${activityId} AND e.status = 'active' AND a.done`;
  if (!w) return;
  if (w.answered) {
    await sql`UPDATE sequence_enrollments SET status = 'stopped', stopped_reason = 'Contestó la llamada', finished_at = now(), next_run_at = NULL,
                     waiting_activity_id = NULL WHERE id = ${w.id}`;
    if (w.deal_id) await recordEvent(sql, actor, "deal", w.deal_id, "sequence.stopped", { sequence: w.name, reason: "Contestó la llamada" });
    return;
  }
  await advance(w.id, w.sequence_id, w.next_step, w.campaign_contact_id);
}

/** Tareas y correos manuales hechos (o borrados) fuera de la secuencia: la secuencia sigue. */
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

/** ¿Puede salir ya este correo de campaña (estado y horario de la campaña)? Si no, cuándo reintentar (o null si hay que parar). */
function campaignGate(c: CampaignCtx, mailboxId: string | null): { ok: true } | { ok: false; retryAt: Date | null; reason: string } {
  if (c.status === "finished") return { ok: false, retryAt: null, reason: "Campaña terminada" };
  if (c.status !== "active") return { ok: false, retryAt: new Date(Date.now() + 3600000), reason: "Campaña en pausa" };
  const window = nextSendWindow(c);
  if (window.getTime() > Date.now() + 60000) return { ok: false, retryAt: window, reason: "Fuera del horario de envío" };
  if (!mailboxId) return { ok: false, retryAt: null, reason: "Sin buzón de outbound" };
  return { ok: true };
}

const missingText = (keys: string[]) => keys.map((k) => `{{${k}}}`).join(", ");
const splitList = (v: string | null) => (v ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));

/** Enlace de baja con un clic (cabecera List-Unsubscribe): acepta POST sin sesión. */
export const oneClickUnsubscribeUrl = (personId: string) => {
  const base = publicBase();
  return base ? `${base}/api/public/unsubscribe/${unsubscribeToken(personId)}` : null;
};

type Due = {
  id: string; sequence_id: string; deal_id: string | null; person_id: string; user_id: string | null; enrolled_by: string | null; next_step: number;
  mailbox_id: string | null; campaign_contact_id: string | null; sequence_name: string; due_at: Date; timezone: string | null;
  schedule_id: string | null; daily_limit: number | null; cc: string | null; bcc: string | null;
} & SequenceSettings;

export async function processSequences(limit = 50): Promise<{ sent: number; tasks: number; manual: number; paused: number; stopped: number; failed: number; waiting: number }> {
  // Interruptor «Motor de secuencias»: apagado, nada avanza.
  if (!(await isOn("sequences"))) return { sent: 0, tasks: 0, manual: 0, paused: 0, stopped: 0, failed: 0, waiting: 0 };
  const canSend = await isOn("email_out");
  const out = { sent: 0, tasks: 0, manual: 0, paused: await handleOutOfOffice(), stopped: 0, failed: 0, waiting: 0 };
  await autoResume();
  out.stopped = await stopFinished();
  out.tasks += await callAfterOpens();
  await releaseWaiting();
  const due = await sql<Due[]>`
    WITH picked AS (
      SELECT e.id, e.next_run_at AS due_at FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id AND s.is_active AND s.archived_at IS NULL AND s.example IS NULL
      WHERE e.status = 'active' AND e.next_run_at <= now()
      ORDER BY e.next_run_at, e.created_at LIMIT ${limit} FOR UPDATE OF e SKIP LOCKED)
    UPDATE sequence_enrollments x SET next_run_at = now() + interval '10 minutes'   -- reclamada: nadie más la procesa a la vez
    FROM picked, sequences s
    WHERE x.id = picked.id AND s.id = x.sequence_id
    RETURNING picked.due_at, x.id, x.sequence_id, x.deal_id, x.person_id, x.user_id, x.enrolled_by, x.next_step, x.mailbox_id, x.campaign_contact_id,
              x.timezone, s.name AS sequence_name, s.send_days, s.send_from, s.send_to, s.track, s.add_signature, s.unsubscribe_link,
              s.schedule_id, s.daily_limit, s.cc, s.bcc`;
  // En el orden en que vencían (RETURNING no lo garantiza): reparto A/B y envíos predecibles.
  due.sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime());
  const pausedBy = new Map<string, { userId: string; sequenceId: string; name: string; people: string[]; missing: Set<string> }>();
  const later = async (id: string, at: Date) => { await sql`UPDATE sequence_enrollments SET next_run_at = ${at} WHERE id = ${id}`; out.waiting++; };
  for (const e of due) {
    const steps = await loadSteps(e.sequence_id);
    const step = steps[e.next_step];
    const actor: Actor = { type: "user", id: e.enrolled_by };
    try {
      if (!step || !step.is_active) {
        // Sin pasos pendientes o paso desactivado: se salta.
        await advance(e.id, e.sequence_id, e.next_step, e.campaign_contact_id);
        continue;
      }
      // Zona horaria del contacto (por el país de su empresa), calculada una vez.
      let tz = e.timezone;
      if (!tz) {
        tz = await contactTz(e.person_id);
        if (tz) await sql`UPDATE sequence_enrollments SET timezone = ${tz} WHERE id = ${e.id}`;
      }
      const schedule = await scheduleOf(e);
      const [p] = await sql<{ full_name: string; email: string | null; organization_id: string | null }[]>`
        SELECT p.full_name, (SELECT email FROM person_emails WHERE person_id = p.id AND bounced_at IS NULL ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
               coalesce((SELECT organization_id FROM deals WHERE id = ${e.deal_id}),
                        (SELECT organization_id FROM person_organizations WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1)) AS organization_id
        FROM persons p WHERE p.id = ${e.person_id}`;
      const camp = e.campaign_contact_id ? await campaignContext(e.campaign_contact_id) : null;
      const owner = e.deal_id ? (await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM deals WHERE id = ${e.deal_id}`)[0]?.owner_id ?? null : null;

      if (step.kind === "email") {
        // Correos automáticos: campaña (estado y horario), horario de envío, límite de la secuencia y ritmo del buzón.
        if (e.campaign_contact_id) {
          const gate = camp ? campaignGate(camp, e.mailbox_id) : { ok: false as const, retryAt: null, reason: "La campaña ya no existe" };
          if (!gate.ok) {
            if (gate.retryAt) await later(e.id, gate.retryAt);
            else await sql`UPDATE sequence_enrollments SET status = 'stopped', stopped_reason = ${gate.reason}, finished_at = now(), next_run_at = NULL WHERE id = ${e.id}`;
            continue;
          }
        } else {
          const slot = nextSlot(schedule, tz);
          if (slot.getTime() > Date.now() + 60000) { await later(e.id, slot); continue; }
        }
        if (e.daily_limit) {
          const [{ n }] = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM emails m JOIN sequence_steps st ON st.id = m.sequence_step_id
            WHERE st.sequence_id = ${e.sequence_id} AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at > now() - interval '24 hours'`;
          if (n >= e.daily_limit) { await later(e.id, new Date(Date.now() + 2 * 3600000)); continue; }
        }
        const conn = e.mailbox_id ? await connectionById(e.mailbox_id) : e.user_id ? await connectionOf(e.user_id) : null;
        if (!conn || conn.status !== "active") throw new Error("La cuenta de correo desde la que sale no está conectada.");
        const gate = await mailboxGate(conn);
        if (!gate.ok) { await later(e.id, gate.retryAt); continue; }
        if (!p?.email) throw new Error("El contacto ya no tiene email.");
        const variant = await pickVariant(step);
        let subjectT = variant.subject;
        const prev = step.thread_reply ? await previousEmail(e.id) : null;
        if (prev) subjectT = `Re: ${prev.subject.replace(/^(re|rv|fw|fwd):\s*/i, "")}`;
        const c = await composeEmail({
          subject: subjectT, body: variant.body, format: step.format, personId: e.person_id, dealId: e.deal_id,
          senderId: conn.user_id ?? e.user_id, campaignContactId: e.campaign_contact_id, conn, settings: e, campaign: Boolean(camp),
        });
        const problems = [...c.errors, ...(c.unknown.length ? [`variables desconocidas ${missingText(c.unknown)}`] : []),
                          ...(c.missing.length ? [`faltan datos: ${missingText(c.missing)}`] : [])];
        if (problems.length || (!c.subject && !step.thread_reply)) {
          // No se envía un «Hola ,»: queda en pausa hasta que se complete el contacto y se reanude.
          const msg = `Paso ${step.position} sin enviar: ${problems.join("; ") || "asunto vacío"}.`;
          await sql`UPDATE sequence_enrollments SET status = 'paused', paused_reason = 'Faltan datos', error = ${msg.slice(0, 300)}, next_run_at = NULL WHERE id = ${e.id}`;
          const who = e.user_id ?? e.enrolled_by;
          // Un solo aviso por persona y secuencia en cada pasada (no uno por contacto).
          if (who) {
            const k = `${who}|${e.sequence_id}`;
            const g = pausedBy.get(k) ?? { userId: who, sequenceId: e.sequence_id, name: e.sequence_name, people: [] as string[], missing: new Set<string>() };
            g.people.push(p.full_name);
            for (const m of c.missing) g.missing.add(m);
            pausedBy.set(k, g);
          }
          out.paused++;
          continue;
        }
        const withUnsub = Boolean(camp) || e.unsubscribe_link;
        // «Enviar correos» apagado: el correo espera una hora (no falla ni salta el paso).
        if (!canSend) {
          await recordBlocked("email_out", "correo", p.email, c.subject, `secuencia «${e.sequence_name}»`);
          await later(e.id, new Date(Date.now() + 3_600_000));
          continue;
        }
        const sent = await sendEmail(conn, actor, {
          to: { email: p.email, name: p.full_name }, subject: c.subject || "(sin asunto)", body: c.text, html: c.html,
          dealId: e.deal_id, personId: e.person_id, organizationId: p.organization_id ?? camp?.organization_id ?? null,
          track: e.track ? undefined : false, cc: splitList(e.cc), bcc: splitList(e.bcc), replyToEmailId: prev?.id ?? null,
          listUnsubscribe: withUnsub ? oneClickUnsubscribeUrl(e.person_id) : null,
        });
        await sql`UPDATE emails SET enrollment_id = ${e.id}, campaign_id = ${camp?.campaign_id ?? null}, sequence_step_id = ${step.id},
                         variant = ${variant.label} WHERE id = ${sent.emailId}`;
        out.sent++;
        await advance(e.id, e.sequence_id, e.next_step, e.campaign_contact_id);
        continue;
      }

      if (step.kind === "manual_email") {
        if (!p?.email) throw new Error("El contacto ya no tiene email.");
        const conn = e.mailbox_id ? await connectionById(e.mailbox_id) : e.user_id ? await connectionOf(e.user_id) : null;
        let subjectT = step.subject;
        const prev = step.thread_reply ? await previousEmail(e.id) : null;
        if (prev) subjectT = `Re: ${prev.subject.replace(/^(re|rv|fw|fwd):\s*/i, "")}`;
        const c = await composeEmail({
          subject: subjectT, body: step.body, format: step.format, personId: e.person_id, dealId: e.deal_id,
          senderId: conn?.user_id ?? e.user_id, campaignContactId: e.campaign_contact_id, conn, settings: e, campaign: Boolean(camp),
        });
        // Se prepara el borrador; lo que falte se ve (y se corrige) antes de enviarlo.
        const missing = [...c.missing, ...c.unknown];
        const activityId = await createActivity(actor, {
          type: "email", subject: `Revisar y enviar: ${c.subject || "(sin asunto)"}`.slice(0, 300),
          note: `Correo manual de la secuencia «${e.sequence_name}» (paso ${step.position}). Revísalo y envíalo desde Tareas de secuencias.`
            + (missing.length ? `\nFaltan datos: ${missingText(missing)}.` : ""),
          due_at: endOfDay(scheduleTz(schedule, tz)).toISOString(), deal_id: e.deal_id ?? undefined, person_id: e.person_id,
          owner_id: owner ?? e.user_id ?? undefined,
        });
        const draft = c.html ?? textToHtml(c.text);
        await sql`UPDATE activities SET enrollment_id = ${e.id}, draft_subject = ${c.subject}, draft_html = ${draft}, draft_to = ${p.email},
                         priority = ${step.priority}, step_kind = 'manual_email' WHERE id = ${activityId}`;
        await sql`UPDATE sequence_enrollments SET waiting_activity_id = ${activityId}, next_run_at = NULL, error = NULL, attempts = 0 WHERE id = ${e.id}`;
        out.manual++;
        continue;
      }

      // Llamada, LinkedIn o tarea: se crea en cuanto toca (aunque sea fuera del horario de envío) y la secuencia espera a que se haga.
      const vars = await mergeContext({ personId: e.person_id, dealId: e.deal_id, senderId: e.user_id, campaignContactId: e.campaign_contact_id });
      const kind = STEP_KINDS[step.kind];
      const title = mergeTemplate(step.subject || kind.title, vars).text || kind.label;
      const extra = step.kind.startsWith("linkedin") && vars.linkedin ? `\n\nLinkedIn: ${vars.linkedin}`
        : step.kind === "call" && vars.telefono ? `\n\nTeléfono: ${vars.telefono}` : "";
      const activityId = await createActivity(actor, {
        type: step.task_type ?? kind.activity, subject: title.slice(0, 300),
        note: `${step.body ? mergeTemplate(step.body, vars).text : ""}${extra}`.trim() || undefined,
        due_at: endOfDay(scheduleTz(schedule, tz)).toISOString(),
        deal_id: e.deal_id ?? undefined, person_id: e.person_id, owner_id: owner ?? e.user_id ?? undefined,
      });
      await sql`UPDATE activities SET enrollment_id = ${e.id}, priority = ${step.priority}, step_kind = ${step.kind} WHERE id = ${activityId}`;
      await sql`UPDATE sequence_enrollments SET waiting_activity_id = ${activityId}, next_run_at = NULL, error = NULL, attempts = 0 WHERE id = ${e.id}`;
      out.tasks++;
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
  for (const g of pausedBy.values()) {
    const n = g.people.length;
    await notify(sql, {
      userId: g.userId, kind: "sequence",
      title: n === 1 ? `${g.people[0]} en pausa en «${g.name}»` : `${n} contactos en pausa en «${g.name}»`,
      body: `${g.missing.size ? `Les falta: ${missingText([...g.missing])}. ` : ""}Complétalo (o pon un valor por defecto a la variable) y reanúdalos.`,
      link: `/sequences/${g.sequenceId}?tab=contactos&estado=paused`,
    }).catch(() => null);
  }
  return out;
}
