"use server";

import { revalidatePath } from "next/cache";
import { guard, writer } from "@/lib/auth";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import {
  createInstruction, deleteInstruction, describePlan, interpretInstruction, setInstructionAutonomy, testInstruction, updateInstruction,
  type Autonomy, type DryRun, type Plan,
} from "@/lib/stage-agents";
import { isId } from "@/lib/validation";

// Instrucciones a la IA por fase del funnel.

type ScopeIn = { pipelineId: string | null; stageId: string | null };
const scopeOf = (s: ScopeIn) => ({ pipelineId: s.pipelineId && isId(s.pipelineId) ? s.pipelineId : null, stageId: s.stageId && isId(s.stageId) ? s.stageId : null });
const refresh = (pipelineId: string | null) => {
  if (pipelineId) { revalidatePath(`/pipelines/${pipelineId}`); revalidatePath(`/pipelines/${pipelineId}/agentes`); }
  revalidatePath("/agents");
};

/** Paso 1: cómo lo entiende la IA (no guarda nada). */
export async function interpretInstructionAction(scope: ScopeIn, text: string): Promise<{ error?: string; plan?: Plan }> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    return { plan: await describePlan(await interpretInstruction(text, scopeOf(scope))) };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}

/** Paso 2: activarla con la autonomía elegida. */
export async function createInstructionAction(scope: ScopeIn, text: string, autonomy: Autonomy): Promise<{ error?: string; id?: string }> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    const id = await createInstruction(g.actor, scopeOf(scope), text, autonomy);
    refresh(scopeOf(scope).pipelineId);
    return { id };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}

export async function setInstructionAutonomyAction(id: string, autonomy: Autonomy, pipelineId: string | null): Promise<void> {
  await writer();
  try { await setInstructionAutonomy(id, autonomy); } catch (err) { console.error(toUserMessage(err)); }
  refresh(pipelineId);
}

export async function deleteInstructionAction(id: string, pipelineId: string | null): Promise<void> {
  await writer();
  await deleteInstruction(id);
  refresh(pipelineId);
}

export async function updateInstructionAction(id: string, pipelineId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => updateInstruction(g.actor, id, String(form.get("text") ?? "")));
  refresh(pipelineId);
  return res?.error ? res : { ok: true, message: "Instrucción actualizada." };
}

/** Probar con un deal: qué haría ahora (sin hacer nada). */
export async function testInstructionAction(id: string, dealId: string): Promise<{ error?: string; results?: DryRun[] }> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    return { results: await testInstruction(id, dealId) };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}
