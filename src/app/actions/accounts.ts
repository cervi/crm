"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { sql } from "@/lib/db";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { answerSurvey, createExpansion, createRenewal, saveContract, startOnboarding } from "@/lib/accounts";

export async function saveContractAction(orgId: string, contractId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => saveContract(g.actor, orgId, contractId, Object.fromEntries(form)));
  revalidatePath(`/organizations/${orgId}`);
  return res;
}

export async function setCsOwnerAction(orgId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const v = String(form.get("cs_owner_id") ?? "");
  const res = await attempt(async () => {
    await sql`UPDATE organizations SET cs_owner_id = ${/^[0-9a-f-]{36}$/i.test(v) ? v : null} WHERE id = ${orgId}`;
  });
  revalidatePath(`/organizations/${orgId}`);
  return res;
}

export async function createExpansionAction(orgId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(async () => {
    const title = String(form.get("title") ?? "").trim();
    if (!title) throw new UserError("Ponle un título a la oportunidad.");
    const value = Number(form.get("value"));
    const product = String(form.get("product_id") ?? "");
    await createExpansion(g.actor, {
      organization_id: orgId, type: form.get("type") === "cross_sell" ? "cross_sell" : "upsell", title,
      value: Number.isFinite(value) && value > 0 ? value : null, product_id: /^[0-9a-f-]{36}$/i.test(product) ? product : null,
    });
  });
  revalidatePath(`/organizations/${orgId}`);
  return res;
}

export async function startOnboardingAction(dealId: string, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(async () => {
    const [r] = await sql<{ plan: string | null }[]>`SELECT params->>'plan' AS plan FROM automation_rules WHERE key = 'won_onboarding'`;
    await startOnboarding(g.actor, dealId, r?.plan ?? "");
  });
  revalidatePath(back);
  return res;
}

export async function createRenewalAction(orgId: string, contractId: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => createRenewal(g.actor, contractId));
  revalidatePath(`/organizations/${orgId}`);
  return res;
}

/** Respuesta pública a una encuesta (sin sesión: el token es la llave). */
export async function answerSurveyAction(token: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => answerSurvey(token, Number(form.get("score")), String(form.get("comment") ?? "")));
  return res ?? { ok: true };
}
