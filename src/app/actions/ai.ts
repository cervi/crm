"use server";

import { guard } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { attempt, toUserMessage, UserError, type ActionState } from "@/lib/errors";
import { listProviderModels, saveAiSettings, testAi, type AiProvider } from "@/lib/ai";
import { refreshDealBrief } from "@/lib/briefs";
import { refreshDigestFocus, saveDigestSettings, sendDigestNow } from "@/lib/digest";
import { isId } from "@/lib/validation";

const refresh = () => revalidatePath("/", "layout");

export async function saveAiSettingsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin", { duringImport: true });
  if ("error" in g) return g;
  const res = await attempt(() => saveAiSettings(Object.fromEntries(form)));
  refresh();
  return res;
}

export async function testAiAction(_: ActionState): Promise<ActionState> {
  const g = await guard("admin", { duringImport: true });
  if ("error" in g) return g;
  const res = await attempt(() => testAi());
  refresh();
  return res;
}

export async function regenerateBriefAction(dealId: string, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(async () => {
    if (!(await refreshDealBrief(dealId))) throw new UserError("La IA no está configurada o no ha respondido (ver Ajustes → Modelo de IA).");
  });
  revalidatePath(back);
  return res;
}

export async function saveDigestSettingsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin", { duringImport: true });
  if ("error" in g) return g;
  const res = await attempt(() => saveDigestSettings(Object.fromEntries(form)));
  refresh();
  return res;
}

export async function refreshFocusAction(ownerId: string | null, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => refreshDigestFocus(isId(ownerId) ? ownerId : null));
  revalidatePath("/");
  return res;
}

export async function sendDigestNowAction(userId: string, _: ActionState): Promise<ActionState> {
  const g = await guard({ self: userId });
  if ("error" in g) return g;
  const res = await attempt(() => sendDigestNow(userId));
  revalidatePath("/");
  return res;
}

/** Lista de modelos del proveedor (para elegir en Ajustes → IA). */
export async function listAiModelsAction(provider: string, key: string, baseUrl: string): Promise<{ models?: { id: string; name: string; created: string | null }[]; error?: string }> {
  const g = await guard("admin");
  if ("error" in g) return g;
  try {
    return { models: await listProviderModels(provider as AiProvider, key || null, baseUrl || null) };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}
