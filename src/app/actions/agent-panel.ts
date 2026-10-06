"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { sql } from "@/lib/db";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { AGENT_KEYS, setJobEnabled } from "@/lib/agent-jobs";

export async function setJobEnabledAction(key: string, enabled: boolean): Promise<void> {
  const g = await guard("admin");
  if ("error" in g) return;
  await setJobEnabled(key, enabled);
  revalidatePath("/agents");
}

/** Límites de los agentes: presupuesto de IA (global y por agente), precios y correos por contacto y día. */
export async function saveAgentLimitsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(async () => {
    const num = (k: string, min = 0, max = 1e7) => {
      const raw = String(form.get(k) ?? "").replace(",", ".").trim();
      if (!raw) return null;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < min || v > max) throw new UserError("Revisa los importes: tienen que ser números positivos.");
      return v;
    };
    const budgets: Record<string, number> = {};
    for (const a of AGENT_KEYS) { const v = num(`budget_${a}`); if (v !== null) budgets[a] = v; }
    const perContact = num("per_contact", 1, 10) ?? 1;
    await sql`UPDATE ai_settings SET monthly_budget = ${num("monthly_budget")}, agent_budgets = ${sql.json(budgets)},
                     price_in = ${num("price_in") ?? 3}, price_out = ${num("price_out") ?? 15}`;
    await sql`UPDATE app_settings SET agent_emails_per_contact_day = ${Math.round(perContact)}`;
  });
  revalidatePath("/agents");
  return res ?? { ok: true, message: "Guardado." };
}
