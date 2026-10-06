"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { attempt, type ActionState } from "@/lib/errors";
import { deleteView, saveView, type ViewEntity } from "@/lib/views";
import { isId } from "@/lib/validation";

export async function saveViewAction(entity: ViewEntity, query: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const me = await currentUser();
  if (!me) return { error: "Tu sesión ha caducado: vuelve a entrar." };
  const res = await attempt(() => saveView(me, entity, String(form.get("name") ?? ""), query, form.get("shared") === "on"));
  revalidatePath(back);
  return res;
}

export async function deleteViewAction(viewId: string, back: string): Promise<void> {
  const me = await currentUser();
  if (!me || !isId(viewId)) return;
  await deleteView(me, viewId);
  revalidatePath(back);
}
