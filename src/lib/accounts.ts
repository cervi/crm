import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql, transaction } from "./db";
import { UserError } from "./errors";
import { AI_ACTOR, recordEvent, type Actor } from "./events";
import { createDeal } from "./deals";
import { notify } from "./notifications";
import { handoffSummary } from "./automations";
import { getInsights } from "./deal-agent";
import { publicBase } from "./email-track";
import { ANNUAL } from "./contract-outcome";
import { RED, levelOf, type HealthLevel } from "./health-level";
import { parse, text } from "./validation";

// ===========================================================================
// Cuentas de cliente para Customer Success: contratos, onboarding,
// renovaciones, datos de uso, encuestas y salud de cada cuenta.
// ===========================================================================

export type Contract = {
  id: string; organization_id: string; organization: string; deal_id: string | null; name: string; status: "active" | "ended" | "cancelled";
  start_date: string; renewal_date: string | null; annual_value: string; currency: string; seats: number | null; auto_renew: boolean;
  cs_owner_id: string | null; cs_owner_name: string | null; notes: string | null; days_to_renewal: number | null;
  items: { product_id: string; name: string; quantity: number; unit_price: number; billing: string }[];
};

const contractCols = sql`
  c.id, c.organization_id, o.name AS organization, c.deal_id, c.name, c.status, c.start_date::text, c.renewal_date::text, c.annual_value::text,
  c.currency, c.seats, c.auto_renew, c.cs_owner_id, u.name AS cs_owner_name, c.notes, (c.renewal_date - current_date) AS days_to_renewal,
  coalesce((SELECT json_agg(json_build_object('product_id', i.product_id, 'name', p.name, 'quantity', i.quantity::float8,
                                               'unit_price', i.unit_price::float8, 'billing', p.billing) ORDER BY p.name)
            FROM contract_items i JOIN products p ON p.id = i.product_id WHERE i.contract_id = c.id), '[]') AS items`;
const contractFrom = sql`FROM contracts c JOIN organizations o ON o.id = c.organization_id LEFT JOIN users u ON u.id = c.cs_owner_id`;

export const contractsOf = (orgId: string) =>
  sql<Contract[]>`SELECT ${contractCols} ${contractFrom} WHERE c.organization_id = ${orgId} ORDER BY (c.status = 'active') DESC, c.start_date DESC`;

export async function getContract(id: string): Promise<Contract | null> {
  const [c] = await sql<Contract[]>`SELECT ${contractCols} ${contractFrom} WHERE c.id = ${id}`;
  return c ?? null;
}

const contractSchema = z.object({
  name: text("El nombre", 200),
  start_date: z.iso.date("Fecha de inicio no válida"),
  renewal_date: z.union([z.literal(""), z.iso.date()]).optional(),
  annual_value: z.coerce.number().min(0).max(1e10),
  seats: z.union([z.literal(""), z.coerce.number().int().positive()]).optional(),
  auto_renew: z.string().optional(),
  cs_owner_id: z.string().optional(),
  status: z.enum(["active", "ended", "cancelled"]).default("active"),
  notes: z.string().max(3000).optional(),
});

export async function saveContract(actor: Actor, orgId: string, id: string | null, data: Record<string, unknown>) {
  const v = parse(contractSchema, data);
  const values = {
    name: v.name, start_date: v.start_date, renewal_date: v.renewal_date || null, annual_value: v.annual_value,
    seats: v.seats === "" || v.seats === undefined ? null : v.seats, auto_renew: v.auto_renew === "on",
    cs_owner_id: /^[0-9a-f-]{36}$/i.test(v.cs_owner_id ?? "") ? v.cs_owner_id! : null, status: v.status, notes: v.notes?.trim() || null,
  };
  if (id) await sql`UPDATE contracts SET ${sql({ ...values, updated_at: new Date() } as unknown as Record<string, never>)} WHERE id = ${id} AND organization_id = ${orgId}`;
  else await sql`INSERT INTO contracts ${sql({ ...values, organization_id: orgId } as unknown as Record<string, never>)}`;
  if (values.cs_owner_id) await sql`UPDATE organizations SET cs_owner_id = coalesce(cs_owner_id, ${values.cs_owner_id}) WHERE id = ${orgId}`;
  await recordEvent(sql, actor, "organization", orgId, id ? "contract.updated" : "contract.created", { name: v.name });
}

async function pipelineOf(kind: "onboarding" | "renewal" | "expansion") {
  const [p] = await sql<{ id: string }[]>`SELECT id FROM pipelines WHERE kind = ${kind} AND is_active ORDER BY position LIMIT 1`;
  if (!p) throw new UserError(`No hay ningún pipeline de ${kind === "onboarding" ? "onboarding" : kind === "renewal" ? "renovaciones" : "expansión"} activo.`);
  return p.id;
}

async function csOwnerFor(orgId: string, fallback: string | null) {
  const [o] = await sql<{ cs: string | null; def: string | null }[]>`
    SELECT o.cs_owner_id AS cs, (SELECT default_cs_owner_id FROM app_settings LIMIT 1) AS def FROM organizations o WHERE o.id = ${orgId}`;
  return o?.cs ?? o?.def ?? fallback;
}

/** Copia los contactos de un deal a otro (el principal sigue siéndolo). */
async function copyParticipants(fromDeal: string, toDeal: string) {
  await sql`INSERT INTO deal_participants (deal_id, person_id, role, is_primary)
            SELECT ${toDeal}, person_id, role, is_primary FROM deal_participants WHERE deal_id = ${fromDeal}
            ON CONFLICT DO NOTHING`;
}

/**
 * Deal ganado → cliente: contrato con sus productos, onboarding en su
 * pipeline con el plan de hitos y la ficha del kick-off («lo prometido en la
 * venta»). Devuelve lo creado (para poder deshacerlo).
 */
export async function startOnboarding(actor: Actor, dealId: string, planText?: string): Promise<{ deal_id: string; contract_id: string; contract_created: boolean }> {
  const [d] = await sql<{ id: string; title: string; organization_id: string | null; organization: string | null; owner_id: string | null; value: string | null;
                          currency: string; won_at: Date | null; status: string }[]>`
    SELECT d.id, d.title, d.organization_id, o.name AS organization, d.owner_id, d.value::text, d.currency, d.won_at, d.status
    FROM deals d LEFT JOIN organizations o ON o.id = d.organization_id WHERE d.id = ${dealId}`;
  if (!d) throw new UserError("El deal ya no existe.");
  if (!d.organization_id) throw new UserError("El deal no tiene empresa: añádela para poder crear el cliente.");
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM deals WHERE contract_id IN (SELECT id FROM contracts WHERE deal_id = ${dealId}) AND deal_type = 'onboarding' AND deleted_at IS NULL`;
  if (existing) throw new UserError("Este cliente ya tiene su onboarding en marcha.");
  const cs = await csOwnerFor(d.organization_id, d.owner_id);
  const start = new Date(d.won_at ?? Date.now());
  const startDate = start.toISOString().slice(0, 10);
  const renewal = new Date(start); renewal.setFullYear(renewal.getFullYear() + 1);

  return transaction(async (tx) => {
    let [contract] = await tx<{ id: string }[]>`SELECT id FROM contracts WHERE deal_id = ${dealId}`;
    const created = !contract;
    if (!contract) {
      const lines = await tx<{ product_id: string; quantity: string; unit_price: string; discount_pct: string; annual: string; recurring: boolean }[]>`
        SELECT dp.product_id, dp.quantity::text, dp.unit_price::text, dp.discount_pct::text,
               (dp.quantity * dp.unit_price * (1 - dp.discount_pct / 100) * ${tx.unsafe(ANNUAL)})::text AS annual, p.billing <> 'one_off' AS recurring
        FROM deal_products dp JOIN products p ON p.id = dp.product_id WHERE dp.deal_id = ${dealId}`;
      const annual = lines.length ? lines.reduce((n, l) => n + Number(l.annual), 0) : Number(d.value ?? 0);
      const seats = Math.max(0, ...lines.filter((l) => l.recurring).map((l) => Number(l.quantity)));
      [contract] = await tx<{ id: string }[]>`
        INSERT INTO contracts (organization_id, deal_id, name, start_date, renewal_date, annual_value, currency, seats, cs_owner_id)
        VALUES (${d.organization_id}, ${dealId}, ${d.title.slice(0, 200)}, ${startDate}, ${renewal.toISOString().slice(0, 10)}, ${Math.round(annual * 100) / 100},
                ${d.currency}, ${seats > 1 ? Math.round(seats) : null}, ${cs})
        RETURNING id`;
      for (const l of lines) {
        await tx`INSERT INTO contract_items (contract_id, product_id, quantity, unit_price, discount_pct)
                 VALUES (${contract.id}, ${l.product_id}, ${l.quantity}, ${l.unit_price}, ${l.discount_pct})`;
      }
      await tx`UPDATE deals SET contract_id = ${contract.id} WHERE id = ${dealId}`;
    }
    if (cs) await tx`UPDATE organizations SET cs_owner_id = coalesce(cs_owner_id, ${cs}) WHERE id = ${d.organization_id}`;
    const onboardingId = await createDeal(actor, {
      title: `Onboarding — ${d.organization ?? d.title}`.slice(0, 300), organization_id: d.organization_id, pipeline_id: await pipelineOf("onboarding"),
      owner_id: cs ?? undefined, expected_close_date: new Date(start.getTime() + 45 * 86400000).toISOString().slice(0, 10), source: "Cliente nuevo",
    }, {}, { db: tx });
    await tx`UPDATE deals SET deal_type = 'onboarding', origin = 'cs', contract_id = ${contract.id} WHERE id = ${onboardingId}`;
    await tx`INSERT INTO deal_participants (deal_id, person_id, role, is_primary)
             SELECT ${onboardingId}, person_id, role, is_primary FROM deal_participants WHERE deal_id = ${dealId} ON CONFLICT DO NOTHING`;
    // Plan de hitos (el de Ajustes de la regla; CS lo cambia cuando quiera).
    const steps = (planText ?? "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 20);
    if (steps.length) {
      await tx`INSERT INTO close_plans (deal_id, token) VALUES (${onboardingId}, ${randomBytes(18).toString("base64url")}) ON CONFLICT DO NOTHING`;
      for (const [i, title] of steps.entries()) {
        const due = new Date(start.getTime() + Math.round((45 * (i + 1)) / steps.length) * 86400000).toISOString().slice(0, 10);
        await tx`INSERT INTO close_plan_steps (deal_id, position, title, side, due_date) VALUES (${onboardingId}, ${i + 1}, ${title.slice(0, 300)}, 'both', ${due})`;
      }
    }
    await recordEvent(tx, actor, "deal", dealId, "deal.onboarding_started", { onboarding_deal_id: onboardingId, contract_id: contract.id });
    if (cs) {
      await notify(tx, { userId: cs, kind: "onboarding", title: `Cliente nuevo: ${d.organization} — arranca su onboarding`, link: `/deals/${onboardingId}` });
    }
    return { deal_id: onboardingId, contract_id: contract.id, contract_created: created };
  }).then(async (r) => {
    // Ficha del kick-off: lo prometido en la venta (lo que sabemos, notas y traspaso).
    const [summary, insights] = await Promise.all([handoffSummary(dealId).catch(() => null), getInsights(dealId)]);
    const promised = [
      "Lo prometido en la venta (para el kick-off):",
      insights?.needs.length ? `- Necesidades: ${insights.needs.join("; ")}` : null,
      insights?.timeline ? `- Plazos: ${insights.timeline}` : null,
      insights?.decision_makers.length ? `- Personas clave: ${insights.decision_makers.map((x) => [x.nombre, x.cargo].filter(Boolean).join(", ")).join("; ")}` : null,
      insights?.objections.length ? `- Dudas que tuvieron: ${insights.objections.join("; ")}` : null,
      summary ? `\n${summary.text}` : null,
    ].filter(Boolean).join("\n");
    await sql`INSERT INTO notes (content, deal_id, author_id) VALUES (${promised.slice(0, 10000)}, ${r.deal_id}, ${AI_ACTOR.id})`;
    return r;
  });
}

/** Deal de renovación de un contrato (en el pipeline de renovaciones). */
export async function createRenewal(actor: Actor, contractId: string): Promise<{ deal_id: string }> {
  const c = await getContract(contractId);
  if (!c) throw new UserError("El contrato ya no existe.");
  const [open] = await sql<{ id: string }[]>`
    SELECT id FROM deals WHERE contract_id = ${contractId} AND deal_type = 'renewal' AND status = 'open' AND deleted_at IS NULL`;
  if (open) throw new UserError("Ya hay una renovación abierta para este contrato.");
  const year = c.renewal_date ? c.renewal_date.slice(0, 4) : String(new Date().getFullYear() + 1);
  const dealId = await createDeal(actor, {
    title: `Renovación — ${c.organization} (${year})`, organization_id: c.organization_id, pipeline_id: await pipelineOf("renewal"),
    value: Number(c.annual_value), expected_close_date: c.renewal_date ?? undefined, owner_id: c.cs_owner_id ?? undefined, source: "Renovación",
  });
  await sql`UPDATE deals SET deal_type = 'renewal', origin = 'cs', contract_id = ${contractId} WHERE id = ${dealId}`;
  if (c.deal_id) await copyParticipants(c.deal_id, dealId);
  return { deal_id: dealId };
}

/** Oportunidad de expansión (upsell o cross-sell) de un cliente. */
export async function createExpansion(actor: Actor, v: { organization_id: string; type: "upsell" | "cross_sell"; title: string; value: number | null;
  product_id?: string | null; quantity?: number | null; note?: string | null }): Promise<{ deal_id: string }> {
  const [c] = await sql<{ id: string; cs_owner_id: string | null; deal_id: string | null }[]>`
    SELECT id, cs_owner_id, deal_id FROM contracts WHERE organization_id = ${v.organization_id} AND status = 'active' ORDER BY renewal_date NULLS LAST LIMIT 1`;
  const owner = await csOwnerFor(v.organization_id, c?.cs_owner_id ?? null);
  const dealId = await createDeal(actor, {
    title: v.title.slice(0, 300), organization_id: v.organization_id, pipeline_id: await pipelineOf("expansion"),
    value: v.value ?? undefined, owner_id: owner ?? undefined, source: v.type === "upsell" ? "Upsell" : "Cross-sell",
  });
  await sql`UPDATE deals SET deal_type = ${v.type}, origin = 'cs', contract_id = ${c?.id ?? null} WHERE id = ${dealId}`;
  if (v.product_id) {
    const [p] = await sql<{ unit_price: string | null }[]>`SELECT unit_price::text FROM products WHERE id = ${v.product_id}`;
    if (p) await sql`INSERT INTO deal_products (deal_id, product_id, quantity, unit_price) VALUES (${dealId}, ${v.product_id}, ${v.quantity ?? 1}, ${Number(p.unit_price ?? 0)})`;
  }
  if (c?.deal_id) await copyParticipants(c.deal_id, dealId);
  if (v.note) await sql`INSERT INTO notes (content, deal_id) VALUES (${v.note.slice(0, 5000)}, ${dealId})`;
  return { deal_id: dealId };
}

// ---------------------------------------------------------------------------
// Datos de uso del producto

export async function recordUsage(input: { organization_id?: string; domain?: string; metric: string; value: number; at?: string | null; source?: string }) {
  const metric = input.metric.trim().toLowerCase().replace(/\s+/g, "_").slice(0, 60);
  if (!/^[a-z0-9_áéíóúñ.-]+$/.test(metric)) throw new UserError("metric: letras, números y guiones bajos (p. ej. usuarios_activos).");
  if (!Number.isFinite(input.value)) throw new UserError("value tiene que ser un número.");
  const [o] = input.organization_id && /^[0-9a-f-]{36}$/i.test(input.organization_id)
    ? await sql<{ id: string }[]>`SELECT id FROM organizations WHERE id = ${input.organization_id} AND deleted_at IS NULL`
    : input.domain ? await sql<{ id: string }[]>`SELECT id FROM organizations WHERE lower(domain) = ${input.domain.trim().toLowerCase().replace(/^www\./, "")} AND deleted_at IS NULL LIMIT 1`
    : [];
  if (!o) throw new UserError("No encuentro esa empresa (usa organization_id o su dominio).");
  const at = input.at && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at) : new Date();
  await sql`INSERT INTO account_usage (organization_id, metric, value, at, source) VALUES (${o.id}, ${metric}, ${input.value}, ${at}, ${input.source ?? "api"})`;
  return { organization_id: o.id, metric };
}

export type UsageSeries = { metric: string; points: { at: Date; value: number }[]; last: number; change30: number | null };

export async function usageOf(orgId: string): Promise<UsageSeries[]> {
  const rows = await sql<{ metric: string; at: Date; value: number }[]>`
    SELECT metric, at, value::float8 AS value FROM account_usage WHERE organization_id = ${orgId} AND at > now() - interval '180 days' ORDER BY metric, at`;
  const by = new Map<string, { at: Date; value: number }[]>();
  for (const r of rows) by.set(r.metric, [...(by.get(r.metric) ?? []), { at: r.at, value: r.value }]);
  return [...by.entries()].map(([metric, points]) => {
    const last = points.at(-1)!.value;
    const ago = points.filter((p) => Date.now() - new Date(p.at).getTime() >= 28 * 86400000).at(-1);
    return { metric, points, last, change30: ago && ago.value ? (last - ago.value) / ago.value : null };
  });
}

// ---------------------------------------------------------------------------
// Encuestas

export async function createSurvey(kind: "onboarding" | "qbr" | "nps", orgId: string | null, dealId: string | null, personId: string | null) {
  const token = randomBytes(15).toString("base64url");
  await sql`INSERT INTO surveys (token, kind, organization_id, deal_id, person_id) VALUES (${token}, ${kind}, ${orgId}, ${dealId}, ${personId})`;
  return `${publicBase() ?? ""}/s/${token}`;
}

export async function surveyByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{16,30}$/.test(token)) return null;
  const [s] = await sql<{ id: string; kind: string; organization: string | null; score: number | null; answered_at: Date | null; deal_id: string | null; cs_owner: string | null }[]>`
    SELECT s.id, s.kind, o.name AS organization, s.score, s.answered_at, s.deal_id, o.cs_owner_id AS cs_owner
    FROM surveys s LEFT JOIN organizations o ON o.id = s.organization_id WHERE s.token = ${token}`;
  return s ?? null;
}

export async function answerSurvey(token: string, score: number, comment: string) {
  if (!Number.isInteger(score) || score < 0 || score > 10) throw new UserError("Elige un número del 0 al 10.");
  const s = await surveyByToken(token);
  if (!s) throw new UserError("Esta encuesta no existe.");
  if (s.answered_at) throw new UserError("Ya respondiste esta encuesta. ¡Gracias!");
  await sql`UPDATE surveys SET score = ${score}, comment = ${comment.trim().slice(0, 2000) || null}, answered_at = now() WHERE id = ${s.id}`;
  if (s.deal_id) await recordEvent(sql, { type: "integration", id: null }, "deal", s.deal_id, "survey.answered", { score, comment: comment.trim().slice(0, 300) || null });
  if (s.cs_owner) {
    await notify(sql, { userId: s.cs_owner, kind: "survey", title: `${s.organization ?? "Un cliente"} ha puntuado con un ${score}`, body: comment.trim().slice(0, 300) || null,
                        link: s.deal_id ? `/deals/${s.deal_id}` : null });
  }
}

// ---------------------------------------------------------------------------
// Salud de las cuentas

export type AccountSignal = { key: string; label: string; tone: "risk" | "good"; points: number; detail?: string };
export type AccountRow = {
  id: string; name: string; cs_owner_id: string | null; cs_owner_name: string | null; arr: number; renewal_date: string | null; days_to_renewal: number | null;
  seats: number | null; contracts: number; health: number | null; health_signals: AccountSignal[]; nps: number | null; onboarding_deal_id: string | null;
  onboarding_stage: string | null; onboarding_done: boolean; open_expansion: number; renewal_deal_id: string | null;
};

const HUMAN_TOUCH = sql`(SELECT max(x.at) FROM (
  SELECT max(a.done_at) AS at FROM activities a WHERE a.done AND (a.organization_id = o.id OR a.deal_id IN (SELECT id FROM deals WHERE organization_id = o.id))
  UNION ALL SELECT max(e.sent_at) FROM emails e WHERE e.organization_id = o.id OR e.deal_id IN (SELECT id FROM deals WHERE organization_id = o.id)) x)`;

type AccountFacts = {
  id: string; name: string; cs_owner_id: string | null; renewal_days: number | null; seats: number | null; seats_used: number | null;
  usage_now: number | null; usage_before: number | null; usage_metric: string | null; tickets: number | null; nps: number | null; last_touch: Date | null;
  onboarding_overdue: number; onboarding_open: boolean; renewal_open: boolean; champion_left: string | null; open_expansion: number; deals_health: number | null;
};

export function scoreAccount(f: AccountFacts): { score: number; signals: AccountSignal[] } {
  const s: AccountSignal[] = [];
  const risk = (key: string, label: string, points: number, detail?: string) => s.push({ key, label, tone: "risk", points: -points, detail });
  const good = (key: string, label: string, points: number, detail?: string) => s.push({ key, label, tone: "good", points, detail });
  if (f.usage_now !== null && f.usage_before) {
    const change = (f.usage_now - f.usage_before) / f.usage_before;
    if (change <= -0.2) risk("usage_drop", `El uso (${f.usage_metric}) baja un ${Math.round(-change * 100)} % en 30 días`, 15, "Propón una revisión con el cliente.");
    else if (change >= 0.2) good("usage_up", `El uso (${f.usage_metric}) sube un ${Math.round(change * 100)} % en 30 días`, 10);
  }
  if (f.seats && f.seats_used !== null) {
    const ratio = f.seats_used / f.seats;
    if (ratio >= 0.9) good("seats_full", `Usa ${Math.round(f.seats_used)} de ${f.seats} licencias`, 5, "Oportunidad de ampliar licencias.");
    else if (ratio < 0.4) risk("seats_idle", `Solo usa ${Math.round(f.seats_used)} de ${f.seats} licencias`, 10, "Riesgo de que no renueve todo: ayuda a activar al equipo.");
  }
  if (f.tickets !== null && f.tickets >= 5) risk("tickets", `${f.tickets} tickets de soporte abiertos`, 10);
  if (f.nps !== null) {
    if (f.nps <= 6) risk("nps_low", `Última encuesta: ${f.nps} de 10`, 15);
    else if (f.nps >= 9) good("nps_high", `Última encuesta: ${f.nps} de 10`, 10);
  }
  const quiet = f.last_touch ? Math.floor((Date.now() - new Date(f.last_touch).getTime()) / 86400000) : null;
  if (quiet === null || quiet > 60) risk("quiet", quiet === null ? "Sin ningún contacto registrado" : `Sin contacto desde hace ${quiet} días`, 10);
  if (f.onboarding_overdue > 0) risk("onboarding_late", `Onboarding con ${f.onboarding_overdue} hito${f.onboarding_overdue === 1 ? "" : "s"} retrasado${f.onboarding_overdue === 1 ? "" : "s"}`, 10);
  if (f.renewal_days !== null && f.renewal_days <= 60 && !f.renewal_open) risk("renewal_soon", `Renueva en ${f.renewal_days} días y no hay renovación en marcha`, 10);
  if (f.champion_left) risk("champion_left", `${f.champion_left} ya no está en la empresa`, 15, "Busca un nuevo interlocutor.");
  if (f.open_expansion > 0) good("expansion", `${f.open_expansion} oportunidad${f.open_expansion === 1 ? "" : "es"} de expansión abierta${f.open_expansion === 1 ? "" : "s"}`, 5);
  if (f.deals_health !== null && f.deals_health < RED) risk("deal_red", "Su onboarding o renovación está en rojo", 10);
  const score = Math.max(0, Math.min(100, 60 + s.reduce((n, x) => n + x.points, 0)));
  s.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score, signals: s };
}

async function accountFacts(orgId?: string): Promise<AccountFacts[]> {
  return sql<AccountFacts[]>`
    SELECT o.id, o.name, o.cs_owner_id,
      (SELECT min(c.renewal_date - current_date) FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active') AS renewal_days,
      (SELECT sum(c.seats)::int FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active') AS seats,
      (SELECT u.value::float8 FROM account_usage u WHERE u.organization_id = o.id AND u.metric IN ('licencias_en_uso', 'seats_used', 'usuarios') ORDER BY u.at DESC LIMIT 1) AS seats_used,
      um.metric AS usage_metric,
      (SELECT u.value::float8 FROM account_usage u WHERE u.organization_id = o.id AND u.metric = um.metric ORDER BY u.at DESC LIMIT 1) AS usage_now,
      (SELECT u.value::float8 FROM account_usage u WHERE u.organization_id = o.id AND u.metric = um.metric AND u.at <= now() - interval '28 days' ORDER BY u.at DESC LIMIT 1) AS usage_before,
      (SELECT u.value::int FROM account_usage u WHERE u.organization_id = o.id AND u.metric IN ('tickets_abiertos', 'open_tickets') ORDER BY u.at DESC LIMIT 1) AS tickets,
      (SELECT s.score FROM surveys s WHERE s.organization_id = o.id AND s.answered_at IS NOT NULL ORDER BY s.answered_at DESC LIMIT 1) AS nps,
      ${HUMAN_TOUCH} AS last_touch,
      (SELECT count(*)::int FROM close_plan_steps cp JOIN deals d ON d.id = cp.deal_id AND d.deal_type = 'onboarding' AND d.status = 'open'
         WHERE d.organization_id = o.id AND NOT cp.done AND cp.due_date < current_date) AS onboarding_overdue,
      EXISTS (SELECT 1 FROM deals d WHERE d.organization_id = o.id AND d.deal_type = 'onboarding' AND d.status = 'open' AND d.deleted_at IS NULL) AS onboarding_open,
      EXISTS (SELECT 1 FROM deals d WHERE d.organization_id = o.id AND d.deal_type = 'renewal' AND d.status = 'open' AND d.deleted_at IS NULL) AS renewal_open,
      (SELECT p.full_name FROM person_organizations po JOIN persons p ON p.id = po.person_id
         WHERE po.organization_id = o.id AND po.status = 'former' AND po.ended_at > current_date - 90
           AND EXISTS (SELECT 1 FROM deal_participants dp JOIN deals d ON d.id = dp.deal_id WHERE dp.person_id = p.id AND d.organization_id = o.id)
         LIMIT 1) AS champion_left,
      (SELECT count(*)::int FROM deals d WHERE d.organization_id = o.id AND d.deal_type IN ('upsell', 'cross_sell') AND d.status = 'open' AND d.deleted_at IS NULL) AS open_expansion,
      (SELECT min(h.score) FROM deal_health h JOIN deals d ON d.id = h.deal_id AND d.status = 'open' AND d.deal_type IN ('onboarding', 'renewal')
         WHERE d.organization_id = o.id) AS deals_health
    FROM organizations o
    LEFT JOIN LATERAL (SELECT u.metric FROM account_usage u WHERE u.organization_id = o.id
                         AND u.metric NOT IN ('tickets_abiertos', 'open_tickets') ORDER BY (u.metric = 'usuarios_activos') DESC, u.at DESC LIMIT 1) um ON true
    WHERE o.deleted_at IS NULL AND EXISTS (SELECT 1 FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active')
      AND (${orgId ?? null}::uuid IS NULL OR o.id = ${orgId ?? null}::uuid)
    LIMIT 5000`;
}

export async function recomputeAccountHealth(orgId?: string): Promise<number> {
  const facts = await accountFacts(orgId);
  let changed = 0;
  for (const f of facts) {
    const h = scoreAccount(f);
    const [prev] = await sql<{ score: number; red_since: Date | null }[]>`SELECT score, red_since FROM account_health WHERE organization_id = ${f.id}`;
    const red = h.score < RED;
    const redSince = red ? prev?.red_since ?? new Date() : prev?.red_since && h.score < RED + 5 ? prev.red_since : null;
    await sql`INSERT INTO account_health (organization_id, score, signals, computed_at, red_since) VALUES (${f.id}, ${h.score}, ${sql.json(h.signals as never)}, now(), ${redSince})
              ON CONFLICT (organization_id) DO UPDATE SET score = EXCLUDED.score, signals = EXCLUDED.signals, computed_at = now(), red_since = EXCLUDED.red_since`;
    if (prev?.score !== h.score) changed++;
    if (red && prev && !prev.red_since && f.cs_owner_id) {
      const why = h.signals.filter((x) => x.tone === "risk").slice(0, 3).map((x) => x.label).join(" · ");
      await notify(sql, { userId: f.cs_owner_id, kind: "account_health", title: `La cuenta ${f.name} está en riesgo (salud ${h.score})`, body: why, link: `/organizations/${f.id}` });
      await recordEvent(sql, AI_ACTOR, "organization", f.id, "account.health_red", { score: h.score });
    }
  }
  if (!orgId) await sql`DELETE FROM account_health h WHERE NOT EXISTS (SELECT 1 FROM contracts c WHERE c.organization_id = h.organization_id AND c.status = 'active')`;
  return changed;
}

export async function listAccounts(f: { owner?: string | null; filter?: string | null } = {}): Promise<AccountRow[]> {
  const rows = await sql<AccountRow[]>`
    SELECT o.id, o.name, o.cs_owner_id, u.name AS cs_owner_name,
      (SELECT coalesce(sum(c.annual_value), 0)::float8 FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active') AS arr,
      (SELECT min(c.renewal_date)::text FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active') AS renewal_date,
      (SELECT min(c.renewal_date - current_date) FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active') AS days_to_renewal,
      (SELECT sum(c.seats)::int FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active') AS seats,
      (SELECT count(*)::int FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active') AS contracts,
      h.score AS health, coalesce(h.signals, '[]') AS health_signals,
      (SELECT s.score FROM surveys s WHERE s.organization_id = o.id AND s.answered_at IS NOT NULL ORDER BY s.answered_at DESC LIMIT 1) AS nps,
      ob.id AS onboarding_deal_id, ob.stage AS onboarding_stage, coalesce(ob.status = 'won', false) AS onboarding_done,
      (SELECT count(*)::int FROM deals d WHERE d.organization_id = o.id AND d.deal_type IN ('upsell', 'cross_sell') AND d.status = 'open' AND d.deleted_at IS NULL) AS open_expansion,
      (SELECT d.id FROM deals d WHERE d.organization_id = o.id AND d.deal_type = 'renewal' AND d.status = 'open' AND d.deleted_at IS NULL LIMIT 1) AS renewal_deal_id
    FROM organizations o
    LEFT JOIN users u ON u.id = o.cs_owner_id
    LEFT JOIN account_health h ON h.organization_id = o.id
    LEFT JOIN LATERAL (SELECT d.id, d.status, s.name AS stage FROM deals d JOIN stages s ON s.id = d.stage_id
                       WHERE d.organization_id = o.id AND d.deal_type = 'onboarding' AND d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 1) ob ON true
    WHERE o.deleted_at IS NULL AND EXISTS (SELECT 1 FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active')
      AND (${f.owner ?? null}::uuid IS NULL OR o.cs_owner_id = ${f.owner ?? null}::uuid)
    ORDER BY h.score ASC NULLS LAST, o.name
    LIMIT 1000`;
  const filter = f.filter;
  return rows.filter((r) => !filter
    || (filter === "risk" && r.health !== null && levelOf(r.health) === "bad")
    || (filter === "renewing" && r.days_to_renewal !== null && r.days_to_renewal <= 120)
    || (filter === "onboarding" && r.onboarding_deal_id && !r.onboarding_done));
}

export async function getAccountHealth(orgId: string): Promise<{ score: number; level: HealthLevel; signals: AccountSignal[]; computed_at: Date } | null> {
  const [h] = await sql<{ score: number; signals: AccountSignal[]; computed_at: Date }[]>`
    SELECT score, signals, computed_at FROM account_health WHERE organization_id = ${orgId}`;
  return h ? { ...h, level: levelOf(h.score) } : null;
}

/** Resumen para la QBR de un cliente (uso, salud, satisfacción, renovación y oportunidades). */
export async function qbrSummary(orgId: string): Promise<string> {
  const [acc] = await listAccounts({}).then((rows) => rows.filter((r) => r.id === orgId));
  const usage = await usageOf(orgId);
  const lines = [
    `Cliente desde: ${(await contractsOf(orgId)).at(-1)?.start_date ?? "—"} · Importe anual: ${acc ? Math.round(acc.arr).toLocaleString("es-ES") : "—"} €`,
    acc?.renewal_date ? `Renovación: ${acc.renewal_date} (en ${acc.days_to_renewal} días)` : null,
    acc?.health !== null && acc?.health !== undefined ? `Salud de la cuenta: ${acc.health}/100${acc.health_signals.length ? ` — ${acc.health_signals.slice(0, 3).map((x) => x.label).join("; ")}` : ""}` : null,
    acc?.nps !== null && acc?.nps !== undefined ? `Última encuesta: ${acc.nps}/10` : null,
    ...usage.map((u) => `Uso · ${u.metric}: ${u.last}${u.change30 !== null ? ` (${u.change30 >= 0 ? "+" : ""}${Math.round(u.change30 * 100)} % en 30 días)` : ""}`),
    acc?.open_expansion ? `Oportunidades de expansión abiertas: ${acc.open_expansion}` : null,
    "",
    "Agenda propuesta: resultados desde la última revisión, objetivos del próximo trimestre, dudas y peticiones, y siguientes pasos.",
  ];
  return lines.filter((x) => x !== null).join("\n");
}

