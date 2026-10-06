import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";
import { parse } from "./validation";

// ===========================================================================
// Reparto automático: los leads y deals nuevos sin responsable se asignan
// según reglas (origen, etapa, puntuación, importe, país) y, dentro de cada
// regla, por turnos entre las personas elegidas.
// ===========================================================================

export type AssignmentRule = {
  id: string; position: number; entity: "lead" | "deal" | "both"; field: "any" | "source" | "funnel_stage" | "min_score" | "min_value" | "country";
  value: string | null; user_ids: string[]; user_names: string[]; last_index: number; is_active: boolean;
};

export const FIELD_LABELS: Record<AssignmentRule["field"], string> = {
  any: "Todos", source: "El origen contiene", funnel_stage: "La etapa es", min_score: "La puntuación es al menos",
  min_value: "El importe es al menos", country: "El país es",
};

export async function listAssignmentRules(): Promise<AssignmentRule[]> {
  return sql<AssignmentRule[]>`
    SELECT r.id, r.position, r.entity, r.field, r.value, r.user_ids, r.last_index, r.is_active,
           coalesce((SELECT array_agg(u.name ORDER BY array_position(r.user_ids, u.id)) FROM users u WHERE u.id = ANY(r.user_ids)), '{}') AS user_names
    FROM assignment_rules r ORDER BY r.position, r.created_at`;
}

export async function assignmentSettings() {
  const [s] = await sql<{ assignment_enabled: boolean; assignment_since: Date | null }[]>`
    SELECT assignment_enabled, assignment_since FROM app_settings LIMIT 1`;
  return s ?? { assignment_enabled: false, assignment_since: null };
}

export async function setAssignmentEnabled(on: boolean) {
  // Solo se reparte lo que llegue a partir de ahora (no el histórico sin responsable).
  await sql`UPDATE app_settings SET assignment_enabled = ${on}, assignment_since = CASE WHEN ${on} THEN now() ELSE assignment_since END`;
}

const ruleSchema = z.object({
  entity: z.enum(["lead", "deal", "both"]),
  field: z.enum(["any", "source", "funnel_stage", "min_score", "min_value", "country"]),
  value: z.string().trim().max(200).optional(),
  user_ids: z.array(z.string().regex(/^[0-9a-f-]{36}$/i)).min(1, "Elige al menos una persona."),
});

export async function saveAssignmentRule(ruleId: string | null, form: FormData) {
  const v = parse(ruleSchema, {
    entity: form.get("entity"), field: form.get("field"), value: String(form.get("value") ?? ""),
    user_ids: form.getAll("user_ids").map(String),
  });
  if (v.field !== "any" && !v.value) throw new UserError("Indica el valor de la condición.");
  if ((v.field === "min_score" || v.field === "min_value") && !Number.isFinite(Number(v.value))) throw new UserError("El valor tiene que ser un número.");
  if (v.field === "funnel_stage" && !["tofu", "mofu", "bofu"].includes((v.value ?? "").toLowerCase())) throw new UserError("La etapa es TOFU, MOFU o BOFU.");
  const value = v.field === "any" ? null : v.field === "funnel_stage" ? v.value!.toLowerCase() : v.value!;
  if (ruleId) {
    await sql`UPDATE assignment_rules SET entity = ${v.entity}, field = ${v.field}, value = ${value}, user_ids = ${v.user_ids}::uuid[]
              WHERE id = ${ruleId}`;
  } else {
    await sql`INSERT INTO assignment_rules (entity, field, value, user_ids, position)
              VALUES (${v.entity}, ${v.field}, ${value}, ${v.user_ids}::uuid[], (SELECT coalesce(max(position), 0) + 1 FROM assignment_rules))`;
  }
}

export async function deleteAssignmentRule(ruleId: string) {
  await sql`DELETE FROM assignment_rules WHERE id = ${ruleId}`;
}

type Item = { id: string; source: string | null; funnel_stage: string | null; score: number | null; value: string | null; country: string | null };

function matches(r: AssignmentRule, kind: "lead" | "deal", x: Item): boolean {
  if (!r.is_active || (r.entity !== "both" && r.entity !== kind)) return false;
  const v = (r.value ?? "").toLowerCase();
  switch (r.field) {
    case "any": return true;
    case "source": return (x.source ?? "").toLowerCase().includes(v);
    case "funnel_stage": return x.funnel_stage === v;
    case "min_score": return x.score !== null && x.score >= Number(v);
    case "min_value": return Number(x.value ?? 0) >= Number(v);
    case "country": return (x.country ?? "").toLowerCase() === v;
  }
}

const SYSTEM: Actor = { type: "system", id: null };

/** Reparte lo nuevo sin responsable. Devuelve cuántos leads y deals se asignaron. */
export async function applyAssignment(): Promise<{ leads: number; deals: number }> {
  const out = { leads: 0, deals: 0 };
  const s = await assignmentSettings();
  if (!s.assignment_enabled || !s.assignment_since) return out;
  const rules = await listAssignmentRules();
  if (!rules.some((r) => r.is_active)) return out;
  const active = new Set((await sql<{ id: string }[]>`SELECT id FROM users WHERE kind = 'human' AND is_active`).map((u) => u.id));

  const pick = async (r: AssignmentRule): Promise<string | null> => {
    // Por turnos, saltando a quien ya no esté activo.
    for (let i = 1; i <= r.user_ids.length; i++) {
      const idx = (r.last_index + i) % r.user_ids.length;
      if (active.has(r.user_ids[idx])) {
        await sql`UPDATE assignment_rules SET last_index = ${idx} WHERE id = ${r.id}`;
        r.last_index = idx;
        return r.user_ids[idx];
      }
    }
    return null;
  };

  const leads = await sql<Item[]>`
    SELECT l.id, l.source, l.funnel_stage, l.score, NULL::text AS value, o.country
    FROM leads l LEFT JOIN organizations o ON o.id = l.organization_id
    WHERE l.owner_id IS NULL AND l.status = 'open' AND l.deleted_at IS NULL AND l.created_at >= ${s.assignment_since}
    ORDER BY l.created_at LIMIT 200`;
  for (const l of leads) {
    const r = rules.find((x) => matches(x, "lead", l));
    const user = r && (await pick(r));
    if (!user) continue;
    const res = await sql`UPDATE leads SET owner_id = ${user} WHERE id = ${l.id} AND owner_id IS NULL`;
    if (res.count) {
      out.leads++;
      await recordEvent(sql, SYSTEM, "lead", l.id, "lead.assigned", { owner_id: user, rule_id: r!.id });
    }
  }

  const deals = await sql<Item[]>`
    SELECT d.id, d.source, l.funnel_stage, l.score, d.value::text, o.country
    FROM deals d LEFT JOIN organizations o ON o.id = d.organization_id LEFT JOIN leads l ON l.id = d.lead_id
    WHERE d.owner_id IS NULL AND d.status = 'open' AND d.deleted_at IS NULL AND d.created_at >= ${s.assignment_since}
    ORDER BY d.created_at LIMIT 200`;
  for (const d of deals) {
    const r = rules.find((x) => matches(x, "deal", d));
    const user = r && (await pick(r));
    if (!user) continue;
    const [u] = await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${user}`;
    const res = await sql`UPDATE deals SET owner_id = ${user} WHERE id = ${d.id} AND owner_id IS NULL`;
    if (res.count) {
      out.deals++;
      await sql`UPDATE activities SET owner_id = ${user} WHERE deal_id = ${d.id} AND owner_id IS NULL AND NOT done`;
      await recordEvent(sql, SYSTEM, "deal", d.id, "deal.owner_changed", { from_owner_id: null, to_owner_id: user, from_name: null, to_name: u?.name, auto: true });
    }
  }
  return out;
}
