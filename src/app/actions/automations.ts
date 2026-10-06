"use server";

import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/errors";
import { UI_ACTOR } from "@/lib/events";
import {
  createCustomRule, deleteCustomRule, updateCustomRule,
  dismissAction, executeAction, runAutomations, setPaused, setPermission, setRuleAutonomy, undoAction, updateRuleParams,
  type AgentKind, type Autonomy, type ExecutableAction,
} from "@/lib/automations";

const refresh = () => revalidatePath("/", "layout");

export async function approveAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => executeAction(id, { actor: UI_ACTOR, edits: Object.fromEntries(form) }));
  refresh();
  return res;
}

export async function dismissActionAction(id: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(() => dismissAction(id));
  refresh();
  return res;
}

export async function undoActionAction(id: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(() => undoAction(id));
  refresh();
  return res;
}

export async function runNowAction(_: ActionState): Promise<ActionState> {
  let message = "";
  const res = await attempt(async () => {
    const r = await runAutomations();
    if (r.status === "busy") message = "Ya se estaba revisando; prueba en unos segundos.";
  });
  refresh();
  return message ? { error: message } : res;
}

export async function setPausedAction(paused: boolean): Promise<void> {
  await setPaused(paused);
  refresh();
}

export async function setRuleAutonomyAction(ruleId: string, autonomy: Autonomy): Promise<void> {
  await setRuleAutonomy(ruleId, autonomy);
  refresh();
}

export async function setPermissionAction(actor: AgentKind, action: ExecutableAction, autonomy: Autonomy): Promise<void> {
  await setPermission(actor, action, autonomy);
  refresh();
}

export async function updateRuleParamsAction(ruleId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => updateRuleParams(ruleId, Object.fromEntries(form)));
  refresh();
  return res;
}

export async function createCustomRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => createCustomRule(Object.fromEntries(form)));
  refresh();
  return res;
}

export async function updateCustomRuleAction(ruleId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => updateCustomRule(ruleId, Object.fromEntries(form)));
  refresh();
  return res;
}

export async function deleteCustomRuleAction(ruleId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(() => deleteCustomRule(ruleId));
  refresh();
  return res;
}
