"use server";

import { guard, writer } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import { listFieldDefinitions, readCustomValues } from "@/lib/custom-fields";
import {
  addParticipant, createDeal, getDeal, loseDeal, moveDealToStage, removeParticipant, reopenDeal, updateDeal, winDeal,
} from "@/lib/deals";
import { archiveLead, convertLead, ingestLead, updateLeadFunnel } from "@/lib/leads";

const fields = (form: FormData) => Object.fromEntries(form);

function refreshDeal(id: string, pipelineId?: string) {
  revalidatePath(`/deals/${id}`);
  if (pipelineId) revalidatePath(`/pipelines/${pipelineId}`);
}

export async function createDealAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  let newId = "";
  const res = await attempt(async () => {
    const custom = readCustomValues(await listFieldDefinitions("deal"), form);
    newId = await createDeal(me, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath(`/pipelines/${form.get("pipeline_id")}`);
  redirect(`/deals/${newId}`);
}

export async function updateDealAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(async () => {
    const before = await getDeal(id);
    const custom = readCustomValues(await listFieldDefinitions("deal", true), form, before?.custom);
    await updateDeal(me, id, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath("/pipelines", "layout");
  redirect(`/deals/${id}`);
}

/** Usado por el tablero (arrastrar) y por la barra de fases de la ficha. */
export async function moveDealAction(dealId: string, stageId: string): Promise<{ error?: string }> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  try {
    await moveDealToStage(me, dealId, stageId);
  } catch (err) {
    return { error: toUserMessage(err) };
  }
  revalidatePath("/pipelines", "layout");
  revalidatePath(`/deals/${dealId}`);
  return {};
}

/** Versión para formularios (barra de fases de la ficha). */
export async function moveDealFormAction(dealId: string, stageId: string): Promise<void> {
  await writer();
  await moveDealAction(dealId, stageId);
}

export async function winDealAction(dealId: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => winDeal(me, dealId));
  revalidatePath("/pipelines", "layout");
  refreshDeal(dealId);
  return res;
}

export async function loseDealAction(dealId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => loseDeal(me, dealId, fields(form)));
  revalidatePath("/pipelines", "layout");
  revalidatePath("/activities");
  refreshDeal(dealId);
  return res;
}

export async function reopenDealAction(dealId: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => reopenDeal(me, dealId));
  revalidatePath("/pipelines", "layout");
  refreshDeal(dealId);
  return res;
}

export async function addParticipantAction(dealId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => addParticipant(me, dealId, fields(form)));
  refreshDeal(dealId);
  return res;
}

export async function removeParticipantAction(dealId: string, personId: string): Promise<void> {
  const me = await writer();
  await removeParticipant(me, dealId, personId);
  refreshDeal(dealId);
}

// ---------------------------------------------------------------- Leads

export async function createLeadAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  let leadId = "";
  const res = await attempt(async () => {
    const f = fields(form);
    const tags = String(f.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    const result = await ingestLead(me, { ...f, tags: tags.length ? tags : undefined, intent: "lead",
                                                consent: f.consent === "on" });
    leadId = result.lead_id;
  });
  if (res?.error) return res;
  revalidatePath("/leads");
  redirect(`/leads/${leadId}`);
}

export async function convertLeadAction(leadId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  let dealId = "";
  const res = await attempt(async () => { dealId = await convertLead(me, leadId, fields(form)); });
  if (res?.error) return res;
  revalidatePath("/leads");
  revalidatePath("/pipelines", "layout");
  redirect(`/deals/${dealId}`);
}

export async function archiveLeadAction(leadId: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => archiveLead(me, leadId));
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  return res;
}

export async function updateLeadAction(leadId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => updateLeadFunnel(me, leadId, fields(form)));
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  return res;
}
