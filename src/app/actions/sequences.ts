"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guard, writer } from "@/lib/auth";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import {
  createSequence, deleteSequence, deleteStep, deleteVariant, enroll, moveStep, promoteVariant, resumeEnrollment, saveStep, saveVariant,
  sendManualEmail, setVariantActive, skipManualEmail, stopEnrollment, updateSequence, updateSequenceSending,
} from "@/lib/sequences";

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
