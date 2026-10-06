"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { merge } from "@/lib/duplicates";
import { attempt, type ActionState } from "@/lib/errors";

export async function mergeAction(kind: "person" | "organization", _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const primary = String(form.get("primary") ?? "");
  const all = form.getAll("ids").map(String);
  const res = await attempt(() => merge(g.actor, kind, primary, all.filter((x) => x !== primary)));
  revalidatePath("/duplicates");
  return res;
}
