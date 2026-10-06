"use server";

import { guard } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/errors";
import { setCsvSeparator } from "@/lib/export";

export async function saveCsvSeparatorAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => setCsvSeparator(String(form.get("separator") ?? "")));
  revalidatePath("/settings/export");
  return res;
}
