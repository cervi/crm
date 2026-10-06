"use server";

import { revalidatePath } from "next/cache";
import { adminOnly, guard } from "@/lib/auth";
import { createAgentKey, revokeAgentKey } from "@/lib/agents";
import { toUserMessage } from "@/lib/errors";

export type KeyState = { error?: string; key?: string } | undefined;

export async function createAgentKeyAction(_: KeyState, form: FormData): Promise<KeyState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  try {
    const key = await createAgentKey(g.actor.id!, String(form.get("name") ?? ""), form.get("can_write") === "on");
    revalidatePath("/settings/agents");
    return { key };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}

export async function revokeAgentKeyAction(id: string): Promise<void> {
  await adminOnly();
  await revokeAgentKey(id);
  revalidatePath("/settings/agents");
}
