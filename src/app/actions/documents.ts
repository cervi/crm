"use server";

import { guard } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/errors";
import { addDocument, removeDocument } from "@/lib/documents";

export async function addDocumentAction(dealId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => addDocument(me, dealId, Object.fromEntries(form)));
  revalidatePath(back);
  return res;
}

export async function removeDocumentAction(documentId: string, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => removeDocument(me, documentId));
  revalidatePath(back);
  return res;
}
