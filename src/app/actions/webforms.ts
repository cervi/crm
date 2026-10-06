"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guard } from "@/lib/auth";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import { deleteForm, saveForm, submitForm } from "@/lib/webforms";

export type SubmitState = { error?: string; done?: { message: string; redirect: string | null } } | undefined;

/** Envío del formulario público (sin sesión). */
export async function submitFormAction(slug: string, _: SubmitState, form: FormData): Promise<SubmitState> {
  try {
    return { done: await submitForm(slug, Object.fromEntries(form)) };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}

export async function saveFormAction(formId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  let id = formId ?? "";
  const res = await attempt(async () => { id = await saveForm(g.actor, formId, Object.fromEntries(form)); });
  if (res?.error) return res;
  revalidatePath("/settings/forms");
  if (!formId) redirect(`/settings/forms/${id}`);
  revalidatePath(`/settings/forms/${id}`);
  return res;
}

export async function deleteFormAction(formId: string, _: ActionState): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => deleteForm(formId));
  if (res?.error) return res;
  redirect("/settings/forms");
}
