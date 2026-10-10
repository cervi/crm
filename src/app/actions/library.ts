"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import { addLibraryLink, createDocLink, disableLink, setArchived, updateLibraryItem } from "@/lib/library";
import { publicBase } from "@/lib/email-track";

export async function addLibraryLinkAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => addLibraryLink(g.actor, Object.fromEntries(form)));
  revalidatePath("/biblioteca");
  return res;
}

export async function updateLibraryItemAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => updateLibraryItem(id, Object.fromEntries(form)));
  revalidatePath("/biblioteca");
  return res;
}

export async function archiveLibraryItemAction(id: string, archived: boolean, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => setArchived(id, archived));
  revalidatePath("/biblioteca");
  return res;
}

/** Crea (o reutiliza) el enlace con seguimiento de un documento para un contacto/deal y lo devuelve para copiarlo o meterlo en un correo. */
export async function docLinkAction(v: { libraryId?: string | null; fileId?: string | null; dealId?: string | null; personId?: string | null }): Promise<{ error?: string; url?: string }> {
  const g = await guard("write");
  if ("error" in g) return g;
  if (!publicBase()) return { error: "Falta configurar la dirección pública del CRM (APP_URL) para poder compartir enlaces." };
  try {
    const l = await createDocLink(g.actor, v);
    if (v.dealId) revalidatePath(`/deals/${v.dealId}`);
    return { url: l.url };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}

export async function disableDocLinkAction(id: string, disabled: boolean, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => disableLink(id, disabled));
  revalidatePath(back);
  return res;
}
