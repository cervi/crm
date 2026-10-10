"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guard } from "@/lib/auth";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import {
  cancelRequest, deleteDraft, duplicateRequest, getRequest, remind, saveFields, saveSettings, saveSigners, sendRequest,
  type FieldInput, type Signer, type SignerInput,
} from "@/lib/esign";

type Res<T = unknown> = { error?: string } & T;

export async function saveSignSetupAction(id: string, settings: Record<string, unknown>, signers: SignerInput[]): Promise<Res<{ signers?: Signer[] }>> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    await saveSettings(id, settings);
    await saveSigners(id, signers);
    const r = await getRequest(id);
    return { signers: r?.signers ?? [] };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}

export async function saveSignFieldsAction(id: string, fields: FieldInput[]): Promise<Res> {
  const g = await guard("write");
  if ("error" in g) return g;
  try { await saveFields(id, fields); return {}; } catch (err) { return { error: toUserMessage(err) }; }
}

export async function sendSignAction(id: string): Promise<Res> {
  const g = await guard("write");
  if ("error" in g) return g;
  try { await sendRequest(g.actor, id); } catch (err) { return { error: toUserMessage(err) }; }
  revalidatePath(`/firmas/${id}`);
  revalidatePath("/firmas");
  return {};
}

export async function remindSignAction(id: string, signerId: string | null, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let n = 0;
  const res = await attempt(async () => { n = await remind(g.actor, id, signerId); });
  revalidatePath(`/firmas/${id}`);
  return res?.ok ? { ok: true, message: n === 1 ? "Recordatorio enviado." : `${n} recordatorios enviados.` } : res;
}

export async function cancelSignAction(id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => cancelRequest(g.actor, id));
  revalidatePath(`/firmas/${id}`);
  revalidatePath("/firmas");
  return res;
}

export async function duplicateSignAction(id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let newId = "";
  const res = await attempt(async () => { newId = await duplicateRequest(g.actor, id); });
  if (res?.error) return res;
  redirect(`/firmas/${newId}`);
}

export async function deleteSignAction(id: string, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => deleteDraft(id));
  if (res?.error) return res;
  revalidatePath("/firmas");
  redirect(back);
}
