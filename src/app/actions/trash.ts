"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guard } from "@/lib/auth";
import { attempt, type ActionState } from "@/lib/errors";
import { isTrashKind, moveToTrash, restore, type TrashKind } from "@/lib/trash";

const LIST: Record<TrashKind, string> = { deal: "/pipelines", lead: "/leads", person: "/persons", organization: "/organizations" };

export async function trashAction(kind: TrashKind, id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  if (!isTrashKind(kind)) return { error: "No válido." };
  const res = await attempt(() => moveToTrash(g.actor, kind, id));
  if (res?.error) return res;
  revalidatePath("/", "layout");
  redirect(LIST[kind]);
}

export async function restoreAction(kind: TrashKind, id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  if (!isTrashKind(kind)) return { error: "No válido." };
  const res = await attempt(() => restore(g.actor, kind, id));
  revalidatePath("/trash");
  return res;
}
