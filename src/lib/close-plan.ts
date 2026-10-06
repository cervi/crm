import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";
import { activityLabel } from "./format";
import { publicBase } from "./email-track";
import { parse, text } from "./validation";

// ===========================================================================
// Plan de cierre (mutual action plan): los pasos que faltan hasta la firma,
// con fecha y responsable (nosotros, el cliente o ambos). Se puede compartir
// con el cliente con un enlace de solo lectura.
// ===========================================================================

export type PlanStep = {
  id: string; position: number; title: string; side: "us" | "client" | "both"; owner_name: string | null; due_date: string | null;
  done: boolean; done_at: Date | null; overdue: boolean;
};
export type ClosePlan = { token: string; shared: boolean; steps: PlanStep[] };
export const SIDE_LABEL: Record<PlanStep["side"], string> = { us: "Nosotros", client: "Cliente", both: "Ambos" };

const stepCols = sql`id, position, title, side, owner_name, due_date::text, done, done_at, (NOT done AND due_date < current_date) AS overdue`;

export async function getClosePlan(dealId: string): Promise<ClosePlan | null> {
  const [p] = await sql<{ token: string; shared: boolean }[]>`SELECT token, shared FROM close_plans WHERE deal_id = ${dealId}`;
  const steps = await sql<PlanStep[]>`SELECT ${stepCols} FROM close_plan_steps WHERE deal_id = ${dealId} ORDER BY position, created_at`;
  if (!p && steps.length === 0) return null;
  return { token: p?.token ?? "", shared: p?.shared ?? false, steps };
}

export const closePlanUrl = (token: string) => `${publicBase() ?? ""}/cp/${token}`;

async function ensurePlan(dealId: string) {
  await sql`INSERT INTO close_plans (deal_id, token) VALUES (${dealId}, ${randomBytes(18).toString("base64url")}) ON CONFLICT (deal_id) DO NOTHING`;
}

const stepSchema = z.object({
  title: text("El paso", 300),
  side: z.enum(["us", "client", "both"]).default("us"),
  owner_name: z.string().trim().max(120).optional(),
  due_date: z.union([z.literal(""), z.iso.date()]).optional(),
});

export async function addStep(actor: Actor, dealId: string, data: unknown) {
  const v = parse(stepSchema, data);
  await ensurePlan(dealId);
  await sql`INSERT INTO close_plan_steps (deal_id, position, title, side, owner_name, due_date)
            VALUES (${dealId}, (SELECT coalesce(max(position), 0) + 1 FROM close_plan_steps WHERE deal_id = ${dealId}),
                    ${v.title}, ${v.side}, ${v.owner_name || null}, ${v.due_date || null})`;
}

export async function toggleStep(actor: Actor, dealId: string, stepId: string) {
  const [s] = await sql<{ title: string; done: boolean }[]>`
    UPDATE close_plan_steps SET done = NOT done, done_at = CASE WHEN done THEN NULL ELSE now() END
    WHERE id = ${stepId} AND deal_id = ${dealId} RETURNING title, done`;
  if (!s) throw new UserError("Ese paso ya no existe.");
  if (s.done) await recordEvent(sql, actor, "deal", dealId, "deal.plan_step_done", { title: s.title });
}

export async function deleteStep(dealId: string, stepId: string) {
  await sql`DELETE FROM close_plan_steps WHERE id = ${stepId} AND deal_id = ${dealId}`;
}

export async function setShared(dealId: string, shared: boolean) {
  await ensurePlan(dealId);
  await sql`UPDATE close_plans SET shared = ${shared} WHERE deal_id = ${dealId}`;
}

/**
 * Plan de cierre de partida: las sesiones que piden las fases que faltan y
 * los pasos habituales hasta la firma, repartidos hasta la fecha de cierre.
 */
export async function generatePlan(actor: Actor, dealId: string): Promise<number> {
  const [d] = await sql<{ pipeline_id: string; position: number; expected_close_date: string | null; title: string; status: string }[]>`
    SELECT d.pipeline_id, s.position, d.expected_close_date::text, d.title, d.status FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ${dealId}`;
  if (!d || d.status !== "open") throw new UserError("El plan de cierre es para deals abiertos.");
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM close_plan_steps WHERE deal_id = ${dealId}`;
  if (n > 0) throw new UserError("Este deal ya tiene plan de cierre: añade o quita pasos.");
  const stages = await sql<{ name: string; required_activity_type: string | null }[]>`
    SELECT name, required_activity_type FROM stages WHERE pipeline_id = ${d.pipeline_id} AND is_active AND position > ${d.position} ORDER BY position`;
  const steps: { title: string; side: PlanStep["side"] }[] = [
    ...stages.filter((s) => s.required_activity_type).map((s) => ({ title: `${activityLabel(s.required_activity_type)} (${s.name})`, side: "both" as const })),
    { title: "Propuesta revisada y validada por el cliente", side: "client" },
    { title: "Validación técnica y de seguridad", side: "client" },
    { title: "Revisión legal del contrato", side: "both" },
    { title: "Alta como proveedor en compras", side: "client" },
    { title: "Firma del contrato", side: "client" },
    { title: "Reunión de arranque (kick-off)", side: "both" },
  ];
  // Fechas: repartidas hasta el cierre previsto (o 30 días si no lo hay); el kick-off, una semana después.
  const end = d.expected_close_date ? new Date(`${d.expected_close_date}T12:00:00`) : new Date(Date.now() + 30 * 86400000);
  const span = Math.max(steps.length, Math.round((end.getTime() - Date.now()) / 86400000));
  await ensurePlan(dealId);
  for (const [i, s] of steps.entries()) {
    const last = i === steps.length - 1;
    const due = new Date(Date.now() + (last ? span + 7 : Math.round((span * (i + 1)) / (steps.length - 1))) * 86400000).toISOString().slice(0, 10);
    await sql`INSERT INTO close_plan_steps (deal_id, position, title, side, due_date) VALUES (${dealId}, ${i + 1}, ${s.title}, ${s.side}, ${due})`;
  }
  await recordEvent(sql, actor, "deal", dealId, "deal.plan_created", { steps: steps.length });
  return steps.length;
}

export async function planByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return null;
  const [p] = await sql<{ deal_id: string; title: string; organization: string | null; owner: string | null; expected_close_date: string | null }[]>`
    SELECT c.deal_id, d.title, o.name AS organization, u.name AS owner, d.expected_close_date::text
    FROM close_plans c JOIN deals d ON d.id = c.deal_id AND d.deleted_at IS NULL
    LEFT JOIN organizations o ON o.id = d.organization_id LEFT JOIN users u ON u.id = d.owner_id
    WHERE c.token = ${token} AND c.shared`;
  if (!p) return null;
  const steps = await sql<PlanStep[]>`SELECT ${stepCols} FROM close_plan_steps WHERE deal_id = ${p.deal_id} ORDER BY position, created_at`;
  return { ...p, steps };
}
