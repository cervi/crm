"use server";

import { adminOnly, guard } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/errors";
import {
  createCustomRule, deleteCustomRule, updateCustomRule,
  dismissAction, executeAction, runAutomations, setPaused, setPermission, setRuleAutonomy, undoAction, updateRuleParams,
  type AgentKind, type Autonomy, type ExecutableAction,
} from "@/lib/automations";

const refresh = () => revalidatePath("/", "layout");

export async function approveAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => executeAction(id, { actor: me, edits: Object.fromEntries(form) }));
  refresh();
  return res;
}

export async function dismissActionAction(id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => dismissAction(id, g.actor));
  refresh();
  return res;
}

export async function undoActionAction(id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => undoAction(id, g.actor));
  refresh();
  return res;
}

export async function runNowAction(_: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let message = "";
  const res = await attempt(async () => {
    const r = await runAutomations();
    if (r.status === "busy") message = "Ya se estaba revisando; prueba en unos segundos.";
  });
  refresh();
  return message ? { error: message } : res;
}

export async function setPausedAction(paused: boolean): Promise<void> {
  await adminOnly();
  await setPaused(paused);
  refresh();
}

export async function setRuleAutonomyAction(ruleId: string, autonomy: Autonomy): Promise<void> {
  await adminOnly();
  await setRuleAutonomy(ruleId, autonomy);
  refresh();
}

export async function setPermissionAction(actor: AgentKind, action: ExecutableAction, autonomy: Autonomy): Promise<void> {
  await adminOnly();
  await setPermission(actor, action, autonomy);
  refresh();
}

export async function updateRuleParamsAction(ruleId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => updateRuleParams(ruleId, Object.fromEntries(form)));
  refresh();
  return res;
}

export async function createCustomRuleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => createCustomRule(Object.fromEntries(form)));
  refresh();
  return res;
}

export async function updateCustomRuleAction(ruleId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => updateCustomRule(ruleId, Object.fromEntries(form)));
  refresh();
  return res;
}

export async function deleteCustomRuleAction(ruleId: string, _: ActionState): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => deleteCustomRule(ruleId));
  refresh();
  return res;
}
