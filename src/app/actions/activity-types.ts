"use server";

import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/errors";
import { createActivityType, deleteActivityType, moveActivityType, updateActivityType } from "@/lib/activity-types";

const refresh = () => revalidatePath("/", "layout");

export async function createActivityTypeAction(_: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => createActivityType(Object.fromEntries(form)));
  refresh();
  return res;
}

export async function updateActivityTypeAction(key: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => updateActivityType(key, Object.fromEntries(form)));
  refresh();
  return res;
}

export async function moveActivityTypeAction(key: string, direction: "up" | "down"): Promise<void> {
  await moveActivityType(key, direction);
  refresh();
}

export async function deleteActivityTypeAction(key: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(() => deleteActivityType(key));
  refresh();
  return res;
}
