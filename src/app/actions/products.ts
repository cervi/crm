"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import { addLine, removeLine, saveProduct } from "@/lib/products";
import { createProposal, decide, markSent, updateProposal } from "@/lib/proposals";

export async function saveProductAction(productId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => saveProduct(productId, Object.fromEntries(form)));
  revalidatePath("/settings/products");
  return res;
}

export async function addLineAction(dealId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => addLine(g.actor, dealId, Object.fromEntries(form)));
  revalidatePath(back);
  return res;
}

export async function removeLineAction(dealId: string, lineId: string, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => removeLine(g.actor, dealId, lineId));
  revalidatePath(back);
  return res;
}

export async function createProposalAction(dealId: string, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => createProposal(g.actor, dealId));
  revalidatePath(back);
  return res;
}

export async function updateProposalAction(proposalId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => updateProposal(proposalId, Object.fromEntries(form)));
  revalidatePath(back);
  return res;
}

export async function markSentAction(proposalId: string, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => markSent(proposalId));
  revalidatePath(back);
  return res;
}

export type DecideState = { error?: string; done?: "accepted" | "declined" } | undefined;

/** Respuesta del cliente desde la página pública de la propuesta (sin sesión). */
export async function decideProposalAction(token: string, _: DecideState, form: FormData): Promise<DecideState> {
  const accept = form.get("decision") !== "decline";
  try {
    await decide(token, accept, String(form.get("name") ?? ""), String(form.get("note") ?? ""));
    return { done: accept ? "accepted" : "declined" };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}
