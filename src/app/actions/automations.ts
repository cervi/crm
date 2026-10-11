"use server";

import { saveAutopilot } from "@/lib/autopilot";

import { adminOnly, guard } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { attempt, type ActionState } from "@/lib/errors";
import {
  createCustomRule, deleteCustomRule, updateCustomRule,
  BULK_APPROVABLE, dismissAction, executeAction, runAutomations, setPaused, setPermission, setRuleAutonomy, undoAction, updateRuleParams,
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

/** Pone todas las reglas de un agente en el mismo nivel (las que no lo admiten se quedan como están). */
export async function setAgentAutonomyAction(agent: string, autonomy: Autonomy): Promise<void> {
  await adminOnly();
  const rules = await sql<{ id: string; allowed_autonomy: Autonomy[] }[]>`
    SELECT id, allowed_autonomy FROM automation_rules WHERE agent = ${agent} AND instruction_id IS NULL`;
  for (const r of rules) {
    const level = r.allowed_autonomy.includes(autonomy) ? autonomy : autonomy === "auto" && r.allowed_autonomy.includes("ask") ? "ask" : null;
    if (level) await setRuleAutonomy(r.id, level);
  }
  refresh();
}

export async function saveAutopilotAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => saveAutopilot(Object.fromEntries(form)));
  revalidatePath("/settings/autopilot");
  return res;
}

/** Aprobar desde la bandeja y pasar a la siguiente propuesta. */
export async function approveAndNextAction(id: string, next: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await approveAction(id, _, form);
  if (res && "error" in res && res.error) return res;
  redirect(next.startsWith("/inbox") ? next : "/inbox");
}

export async function dismissAndNextAction(id: string, next: string, _: ActionState): Promise<ActionState> {
  const res = await dismissActionAction(id, _);
  if (res && "error" in res && res.error) return res;
  redirect(next.startsWith("/inbox") ? next : "/inbox");
}

/** Varias a la vez: descartar cualquiera; aprobar solo las que no son correos. */
export async function bulkInboxAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const op = String(form.get("op") ?? "");
  const ids = form.getAll("id").map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 500);
  if (!ids.length) return { error: "Marca al menos una propuesta." };
  let done = 0, skipped = 0, failed = 0;
  if (op === "dismiss") {
    for (const id of ids) { try { await dismissAction(id, g.actor); done++; } catch { failed++; } }
  } else if (op === "approve") {
    const rows = await sql<{ id: string; action_type: string }[]>`SELECT id, action_type FROM automation_actions WHERE id = ANY(${ids}::uuid[]) AND status = 'pending'`;
    for (const r of rows) {
      if (!BULK_APPROVABLE.has(r.action_type)) { skipped++; continue; }
      try { await executeAction(r.id, { actor: g.actor }); done++; } catch { failed++; }
    }
  } else return { error: "Acción no válida." };
  refresh();
  const what = op === "dismiss" ? "descartada" : "aprobada";
  const parts = [`${done} ${what}${done === 1 ? "" : "s"}`];
  if (skipped) parts.push(`${skipped} correo${skipped === 1 ? "" : "s"} sin tocar: revísalos uno a uno antes de enviarlos`);
  if (failed) parts.push(`${failed} ya no estaba${failed === 1 ? "" : "n"} pendiente${failed === 1 ? "" : "s"}`);
  return { ok: true, message: `${parts.join(" · ")}.` };
}
