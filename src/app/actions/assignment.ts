"use server";

import { revalidatePath } from "next/cache";
import { adminOnly, guard } from "@/lib/auth";
import { deleteAssignmentRule, saveAssignmentRule, setAssignmentEnabled } from "@/lib/assignment";
import { attempt, type ActionState } from "@/lib/errors";

export async function saveAssignmentRuleAction(ruleId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => saveAssignmentRule(ruleId, form));
  revalidatePath("/settings/assignment");
  return res;
}

export async function deleteAssignmentRuleAction(ruleId: string): Promise<void> {
  await adminOnly();
  await deleteAssignmentRule(ruleId);
  revalidatePath("/settings/assignment");
}

export async function setAssignmentEnabledAction(on: boolean): Promise<void> {
  await adminOnly();
  await setAssignmentEnabled(on);
  revalidatePath("/settings/assignment");
}
