"use server";

import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/errors";
import { UI_ACTOR } from "@/lib/events";
import { addDocument, removeDocument } from "@/lib/documents";

export async function addDocumentAction(dealId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => addDocument(UI_ACTOR, dealId, Object.fromEntries(form)));
  revalidatePath(back);
  return res;
}

export async function removeDocumentAction(documentId: string, back: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(() => removeDocument(UI_ACTOR, documentId));
  revalidatePath(back);
  return res;
}
