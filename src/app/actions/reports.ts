"use server";

import { revalidatePath } from "next/cache";
import { adminOnly, guard } from "@/lib/auth";
import { attempt, type ActionState } from "@/lib/errors";
import { deleteGoal, saveGoal } from "@/lib/reports";
import { saveWidgetAction } from "./dashboards";
import { isId } from "@/lib/validation";

export async function saveGoalAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => saveGoal(Object.fromEntries(form)));
  revalidatePath("/reports");
  return res;
}

export async function deleteGoalAction(id: string): Promise<void> {
  await adminOnly();
  await deleteGoal(id);
  revalidatePath("/reports");
}

/** Guarda la respuesta a una pregunta como widget de un dashboard. */
export async function saveAnswerAction(state: ActionState, form: FormData): Promise<ActionState> {
  const dashboardId = String(form.get("dashboard_id") ?? "");
  if (!isId(dashboardId)) return { error: "Elige un dashboard." };
  // Si va bien, lleva al dashboard con el widget nuevo.
  return saveWidgetAction(dashboardId, null, state, form);
}
