"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guard, writer } from "@/lib/auth";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import {
  bulkEnrollments, createSequence, deleteSequence, deleteStep, deleteVariant, enroll, enrollMany, moveStep, promoteVariant, resumeEnrollment, saveStep, saveVariant,
  sendManualEmail, setSequenceActive, setStepActive, setVariantActive, skipManualEmail, stopEnrollment, updateSequence, updateSequenceSending,
  updateSequenceSettings, type BulkOp, type EnrollIssue,
} from "@/lib/sequences";
import { archiveSequence, createBlankSequence, createFromTemplate, createWithAi, duplicateSequence } from "@/lib/sequence-templates";
import { completeQueueTask } from "@/lib/sequence-tasks";
import { createExample, removeExample } from "@/lib/sequence-example";
import { deleteSchedule, saveSchedule } from "@/lib/send-schedule";

export async function createSequenceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let id = "";
  const res = await attempt(async () => { id = await createSequence(g.actor, Object.fromEntries(form)); });
  if (res?.error) return res;
  redirect(`/sequences/${id}`);
}

export async function updateSequenceAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => updateSequence(id, Object.fromEntries(form)));
  revalidatePath(`/sequences/${id}`);
  return res;
}

export async function deleteSequenceAction(id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => deleteSequence(id));
  if (res?.error) return res;
  redirect("/sequences");
}

export async function updateSequenceSendingAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => updateSequenceSending(id, form));
  revalidatePath(`/sequences/${id}`);
  return res?.error ? res : { ok: true, message: "Ajustes de envío guardados." };
}

export async function saveStepAction(sequenceId: string, stepId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => saveStep(sequenceId, stepId, Object.fromEntries(form)));
  revalidatePath(`/sequences/${sequenceId}`);
  return res?.error ? res : { ok: true, message: stepId ? "Paso guardado." : "Paso añadido." };
}

export async function saveVariantAction(sequenceId: string, stepId: string, variantId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => saveVariant(sequenceId, stepId, variantId, Object.fromEntries(form)));
  revalidatePath(`/sequences/${sequenceId}`);
  return res?.error ? res : { ok: true, message: variantId ? "Variante guardada." : "Variante añadida: se repartirá a partes iguales con las demás." };
}

export async function variantAction(sequenceId: string, stepId: string, variantId: string, op: "on" | "off" | "delete" | "promote"): Promise<void> {
  await writer();
  try {
    if (op === "delete") await deleteVariant(sequenceId, stepId, variantId);
    else if (op === "promote") await promoteVariant(sequenceId, stepId, variantId);
    else await setVariantActive(sequenceId, stepId, variantId, op === "on");
  } catch (err) { console.error(toUserMessage(err)); }
  revalidatePath(`/sequences/${sequenceId}`);
}

export async function moveStepAction(sequenceId: string, stepId: string, dir: -1 | 1): Promise<void> {
  await writer();
  await moveStep(sequenceId, stepId, dir);
  revalidatePath(`/sequences/${sequenceId}`);
}

export async function resumeEnrollmentAction(enrollmentId: string, back: string): Promise<void> {
  await writer();
  try { await resumeEnrollment(enrollmentId); } catch (err) { console.error(toUserMessage(err)); }
  revalidatePath(back);
}

export async function sendManualEmailAction(activityId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => sendManualEmail(g.actor, activityId, Object.fromEntries(form)));
  revalidatePath("/sequences/tasks");
  return res?.error ? res : { ok: true, message: "Enviado." };
}

export async function skipManualEmailAction(activityId: string): Promise<void> {
  await writer();
  try { await skipManualEmail(activityId); } catch (err) { console.error(toUserMessage(err)); }
  revalidatePath("/sequences/tasks");
}

export async function deleteStepAction(sequenceId: string, stepId: string): Promise<void> {
  await writer();
  await deleteStep(sequenceId, stepId);
  revalidatePath(`/sequences/${sequenceId}`);
}

export async function enrollAction(dealId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => enroll(g.actor, String(form.get("sequence_id") ?? ""), dealId, (form.get("person_id") as string) || null));
  revalidatePath(back);
  return res;
}

export async function stopEnrollmentAction(enrollmentId: string, back: string): Promise<void> {
  const actor = await writer();
  try { await stopEnrollment(actor, enrollmentId); } catch (err) { console.error(toUserMessage(err)); }
  revalidatePath(back);
}

// --- Al estilo Apollo: crear, ajustes, contactos, tareas y horarios

/** Nueva secuencia: en blanco, desde una plantilla o con IA. */
export async function newSequenceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const how = String(form.get("how") ?? "blank");
  const name = String(form.get("name") ?? "");
  const folder = String(form.get("folder") ?? "").trim() || null;
  let id = "";
  try {
    id = how === "ai" ? await createWithAi(g.actor, String(form.get("brief") ?? ""), name, folder)
      : how.startsWith("tpl:") ? await createFromTemplate(g.actor, how.slice(4), name, folder)
      : await createBlankSequence(g.actor, name, folder);
  } catch (err) { return { error: toUserMessage(err) }; }
  redirect(`/sequences/${id}?tab=pasos`);
}

export async function duplicateSequenceAction(id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let copy = "";
  try { copy = await duplicateSequence(g.actor, id); } catch (err) { return { error: toUserMessage(err) }; }
  redirect(`/sequences/${copy}?tab=ajustes`);
}

export async function archiveSequenceAction(id: string, archived: boolean, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => archiveSequence(id, archived));
  revalidatePath("/sequences");
  revalidatePath(`/sequences/${id}`);
  return res?.error ? res : { ok: true, message: archived ? "Archivada: ya no envía nada." : "Recuperada del archivo (está en pausa: actívala cuando quieras)." };
}

export async function setSequenceActiveAction(id: string, active: boolean, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => setSequenceActive(id, active));
  revalidatePath(`/sequences/${id}`);
  revalidatePath("/sequences");
  return res;
}

export async function updateSequenceSettingsAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => updateSequenceSettings(id, form));
  revalidatePath(`/sequences/${id}`);
  return res?.error ? res : { ok: true, message: "Ajustes guardados." };
}

export async function stepActiveAction(sequenceId: string, stepId: string, active: boolean): Promise<void> {
  await writer();
  await setStepActive(sequenceId, stepId, active);
  revalidatePath(`/sequences/${sequenceId}`);
}

/** Acciones en bloque sobre los contactos de la secuencia. */
export async function bulkEnrollmentsAction(sequenceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const op = String(form.get("op") ?? "") as BulkOp;
  if (!["pause", "resume", "finish", "remove", "mailbox", "step", "retry"].includes(op)) return { error: "Elige qué hacer." };
  try {
    const n = await bulkEnrollments(g.actor, sequenceId, form.getAll("ids").map(String), op, {
      resumeAt: String(form.get("resume_at") ?? "") || null, reason: String(form.get("reason") ?? "") || null,
      mailboxId: String(form.get("mailbox_id") ?? "") || null, step: form.get("step") === null || form.get("step") === "" ? null : Number(form.get("step")),
    });
    revalidatePath(`/sequences/${sequenceId}`);
    const what: Record<BulkOp, string> = { pause: "pausados", resume: "reanudados", finish: "terminados", remove: "quitados de la secuencia",
      mailbox: "cambiados de buzón", step: "movidos de paso", retry: "reintentados" };
    return { ok: true, message: n === 0 ? "Ninguno de los seleccionados estaba en un estado que lo permita." : `${n} contacto${n === 1 ? "" : "s"} ${what[op]}.` };
  } catch (err) { return { error: toUserMessage(err) }; }
}

/** Añadir contactos revisados (con los avisos que se aceptan) y el reparto de buzones. */
export async function enrollManyAction(sequenceId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let r: Awaited<ReturnType<typeof enrollMany>>;
  try {
    r = await enrollMany(g.actor, sequenceId, form.getAll("ids").map(String), {
      mailboxIds: form.getAll("mailbox_ids").map(String), include: form.getAll("include").map(String) as EnrollIssue[],
    });
  } catch (err) { return { error: toUserMessage(err) }; }
  revalidatePath(`/sequences/${sequenceId}`);
  const skipped = Object.values(r.skipped).reduce((n, x) => n + (x ?? 0), 0);
  redirect(`/sequences/${sequenceId}?tab=contactos&anadidos=${r.added}&saltados=${skipped}`);
}

export async function completeTaskAction(activityId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const skip = form.get("skip") === "1";
  try {
    await completeQueueTask(g.actor, activityId, { outcome: String(form.get("outcome") ?? "") || null, note: String(form.get("note") ?? ""), skip });
  } catch (err) { return { error: toUserMessage(err) }; }
  revalidatePath("/sequences/tasks");
  if (back) redirect(back);
  return { ok: true, message: skip ? "Saltada." : "Hecha." };
}

export async function saveScheduleAction(id: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => saveSchedule(id, form));
  revalidatePath("/sequences/horarios");
  return res?.error ? res : { ok: true, message: id ? "Horario guardado." : "Horario creado." };
}

export async function deleteScheduleAction(id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => deleteSchedule(id));
  revalidatePath("/sequences/horarios");
  return res;
}

/** Modo «una tras otra»: envía el correo manual y pasa a la siguiente tarea. */
export async function sendManualAndNextAction(activityId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  try { await sendManualEmail(g.actor, activityId, Object.fromEntries(form)); } catch (err) { return { error: toUserMessage(err) }; }
  revalidatePath("/sequences/tasks");
  redirect(back);
}

/** Crea (o abre, si ya existe) la secuencia de ejemplo con contactos ficticios. */
export async function createExampleAction(_: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let id = "";
  try { id = await createExample(g.actor); } catch (err) { return { error: toUserMessage(err) }; }
  revalidatePath("/sequences");
  redirect(`/sequences/${id}`);
}

/** Borra el ejemplo entero (secuencia, contactos, empresas, correos y tareas de muestra). */
export async function removeExampleAction(id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  try { await removeExample(id); } catch (err) { return { error: toUserMessage(err) }; }
  revalidatePath("/sequences");
  redirect("/sequences?hecho=ejemplo-borrado");
}
