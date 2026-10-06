"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { sql } from "@/lib/db";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { saveInsights, buildPrep } from "@/lib/deal-agent";
import { addStep, deleteStep, generatePlan, setShared, toggleStep } from "@/lib/close-plan";
import { decideDiscount } from "@/lib/products";

export async function saveInsightsAction(dealId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => saveInsights(dealId, Object.fromEntries(form)));
  revalidatePath(back);
  return res;
}

export async function addPlanStepAction(dealId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => addStep(g.actor, dealId, Object.fromEntries(form)));
  revalidatePath(back);
  return res;
}

export async function togglePlanStepAction(dealId: string, stepId: string, back: string): Promise<void> {
  const g = await guard("write");
  if ("error" in g) return;
  await attempt(() => toggleStep(g.actor, dealId, stepId));
  revalidatePath(back);
}

export async function deletePlanStepAction(dealId: string, stepId: string, back: string): Promise<void> {
  const g = await guard("write");
  if ("error" in g) return;
  await deleteStep(dealId, stepId);
  revalidatePath(back);
}

export async function generatePlanAction(dealId: string, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => generatePlan(g.actor, dealId));
  revalidatePath(back);
  return res;
}

export async function sharePlanAction(dealId: string, shared: boolean, back: string): Promise<void> {
  const g = await guard("write");
  if ("error" in g) return;
  await setShared(dealId, shared);
  revalidatePath(back);
}

export async function decideDiscountAction(dealId: string, lineId: string, approve: boolean, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => decideDiscount(g.actor, dealId, lineId, approve));
  revalidatePath(back);
  revalidatePath("/inbox");
  return res;
}

/** Rehace ahora la ficha de preparación de una reunión. */
export async function refreshPrepAction(activityId: string, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(async () => {
    const [f] = await sql<{ activity_id: string; deal_id: string; subject: string; type: string; due_at: Date; owner_id: string | null; title: string;
                            stage: string; organization: string | null; value: string | null }[]>`
      SELECT a.id AS activity_id, a.deal_id, a.subject, a.type, coalesce(a.due_at, now()) AS due_at, a.owner_id, d.title, s.name AS stage,
             o.name AS organization, d.value::text
      FROM activities a JOIN deals d ON d.id = a.deal_id JOIN stages s ON s.id = d.stage_id LEFT JOIN organizations o ON o.id = d.organization_id
      WHERE a.id = ${activityId} AND NOT a.done`;
    if (!f) throw new UserError("Esa reunión ya no está pendiente.");
    await sql`UPDATE activities SET prep = ${await buildPrep(f)}, prep_at = now() WHERE id = ${activityId}`;
  });
  revalidatePath(back);
  return res;
}
