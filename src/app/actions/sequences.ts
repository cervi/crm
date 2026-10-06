"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guard, writer } from "@/lib/auth";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import {
  createSequence, deleteSequence, deleteStep, enroll, saveStep, stopEnrollment, updateSequence,
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

export async function saveStepAction(sequenceId: string, stepId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => saveStep(sequenceId, stepId, Object.fromEntries(form)));
  revalidatePath(`/sequences/${sequenceId}`);
  return res;
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
