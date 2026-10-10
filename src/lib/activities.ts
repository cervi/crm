import { z } from "zod";
import { sql, transaction } from "./db";
import { recordEvent, type Actor } from "./events";
import { UserError } from "./errors";
import { OUTCOMES } from "./format";
import { activityTypes, assertActivityType } from "./activity-types";
import { zonedToUtc } from "./slots";
import { optId, optText, optional, parse, text } from "./validation";

export type Activity = {
  id: string;
  type: string;
  subject: string;
  note: string | null;
  due_at: Date | null;
  duration_minutes: number | null;
  done: boolean;
  done_at: Date | null;
  outcome: string | null;
  deal_id: string | null;
  deal_title: string | null;
  lead_id: string | null;
  person_id: string | null;
  person_name: string | null;
  organization_id: string | null;
  organization_name: string | null;
  owner_name: string | null;
  meeting_url: string | null;
  summary: string | null;
  is_overdue: boolean;
  /** Ficha de preparación que deja el agente antes de una reunión. */
  prep: string | null;
  prep_at: Date | null;
  call_outcome: string | null;
};

const select = () => sql`
  SELECT a.id, a.type, a.subject, a.note, a.due_at, a.duration_minutes, a.done, a.done_at, a.outcome,
         a.deal_id, d.title AS deal_title, a.lead_id, a.person_id, p.full_name AS person_name,
         a.organization_id, o.name AS organization_name, u.name AS owner_name, a.meeting_url, a.summary, a.prep, a.prep_at, a.call_outcome,
         (NOT a.done AND a.due_at < now()) AS is_overdue
  FROM activities a
  LEFT JOIN deals d ON d.id = a.deal_id
  LEFT JOIN persons p ON p.id = a.person_id
  LEFT JOIN organizations o ON o.id = a.organization_id
  LEFT JOIN users u ON u.id = a.owner_id`;

/** Actividades de una ficha (deal, lead, contacto o empresa): pendientes primero. */
export async function listActivitiesFor(ref: { dealId?: string; leadId?: string; personId?: string; organizationId?: string }) {
  await activityTypes();
  return sql<Activity[]>`
    ${select()}
    WHERE (${ref.dealId ?? null}::uuid IS NULL OR a.deal_id = ${ref.dealId ?? null}::uuid)
      AND (${ref.leadId ?? null}::uuid IS NULL OR a.lead_id = ${ref.leadId ?? null}::uuid)
      AND (${ref.personId ?? null}::uuid IS NULL OR a.person_id = ${ref.personId ?? null}::uuid)
      AND (${ref.organizationId ?? null}::uuid IS NULL OR a.organization_id = ${ref.organizationId ?? null}::uuid
           OR a.deal_id IN (SELECT id FROM deals WHERE organization_id = ${ref.organizationId ?? null}::uuid))
    ORDER BY a.done, a.due_at NULLS LAST, a.created_at DESC
    LIMIT 200`;
}

/** Bandeja de actividades: pendientes (vencidas, hoy, próximas) o hechas. */
export async function listActivities({ view = "pending", ownerId }: { view?: "pending" | "done"; ownerId?: string | null }) {
  await activityTypes();
  return sql<Activity[]>`
    ${select()}
    WHERE a.done = ${view === "done"}
      AND (${ownerId ?? null}::uuid IS NULL OR a.owner_id = ${ownerId ?? null}::uuid)
    ORDER BY ${view === "done" ? sql`a.done_at DESC` : sql`a.due_at NULLS LAST`}
    LIMIT 300`;
}

/** Actividades con fecha entre dos instantes (vista de semana), hechas o no. */
export async function listActivitiesBetween(from: Date, to: Date, ownerId?: string | null) {
  await activityTypes();
  return sql<Activity[]>`
    ${select()}
    WHERE a.due_at >= ${from} AND a.due_at < ${to}
      AND (${ownerId ?? null}::uuid IS NULL OR a.owner_id = ${ownerId ?? null}::uuid)
    ORDER BY a.due_at
    LIMIT 500`;
}

const outcomes = OUTCOMES.map((o) => o.value) as [string, ...string[]];

const activitySchema = z.object({
  type: z.string({ message: "Tipo de actividad no válido" }).trim().min(1, "Tipo de actividad no válido"),
  subject: text("El asunto", 300),
  note: optText(5000),
  due_at: optional(z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Fecha no válida")),
  duration_minutes: optional(z.coerce.number().int().min(1).max(24 * 60)),
  deal_id: optId,
  lead_id: optId,
  person_id: optId,
  organization_id: optId,
  owner_id: optId,
  meeting_url: optText(500),
});

export async function createActivity(actor: Actor, data: unknown): Promise<string> {
  const v = parse(activitySchema, data);
  await assertActivityType(v.type);
  if (!v.deal_id && !v.lead_id && !v.person_id && !v.organization_id) {
    throw new UserError("La actividad debe estar asociada a algo.");
  }
  return transaction(async (tx) => {
    // Si es de un deal, se hereda la empresa y el responsable si no se indican.
    const [deal] = v.deal_id
      ? await tx<{ organization_id: string | null; owner_id: string | null }[]>`
          SELECT organization_id, owner_id FROM deals WHERE id = ${v.deal_id}`
      : [];
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO activities ${tx({
        type: v.type,
        subject: v.subject,
        note: v.note ?? null,
        due_at: v.due_at ? new Date(v.due_at) : null,
        duration_minutes: v.duration_minutes ?? null,
        deal_id: v.deal_id ?? null,
        lead_id: v.lead_id ?? null,
        person_id: v.person_id ?? null,
        organization_id: v.organization_id ?? deal?.organization_id ?? null,
        owner_id: v.owner_id ?? deal?.owner_id ?? null,
        created_by_id: actor.id,
        meeting_url: v.meeting_url ?? null,
      })} RETURNING id`;
    await recordEvent(tx, actor, "activity", row.id, "activity.created", {
      type: v.type, subject: v.subject, deal_id: v.deal_id ?? null, due_at: v.due_at ?? null,
    });
    if (v.deal_id) {
      await recordEvent(tx, actor, "deal", v.deal_id, "activity.created", { activity_id: row.id, type: v.type, subject: v.subject });
    }
    return row.id;
  });
}

/** Marca una actividad como hecha, con su resultado (p. ej. «No se presentó»). */
export async function completeActivity(actor: Actor, activityId: string, data: unknown) {
  const v = parse(z.object({ outcome: optional(z.enum(outcomes)), note: optText(5000), transcript: optText(200000) }), data);
  await transaction(async (tx) => {
    const [a] = await tx<{ deal_id: string | null; subject: string; type: string; note: string | null }[]>`
      UPDATE activities SET done = true, outcome = ${v.outcome ?? null},
             note = CASE WHEN ${v.note ?? null}::text IS NULL THEN note
                         ELSE concat_ws(E'\n\n', note, ${v.note ?? null}::text) END,
             transcript = coalesce(${v.transcript ?? null}::text, transcript)
      WHERE id = ${activityId} AND NOT done
      RETURNING deal_id, subject, type, note`;
    if (!a) return;
    const payload = { activity_id: activityId, subject: a.subject, type: a.type, outcome: v.outcome ?? null };
    await recordEvent(tx, actor, "activity", activityId, "activity.completed", payload);
    // Una ausencia ("no_show") queda en el historial del deal: el seguimiento
    // automático la usará para intentar reagendar.
    if (a.deal_id) await recordEvent(tx, actor, "deal", a.deal_id, "activity.completed", payload);
  });
}

export async function reopenActivity(activityId: string) {
  await sql`UPDATE activities SET done = false, outcome = NULL WHERE id = ${activityId}`;
}

// ---------------------------------------------------------------------------
// Bandeja de actividades en tabla (como Pipedrive): periodo + tipo + responsable.
// ---------------------------------------------------------------------------

export const ACTIVITY_PERIODS = [
  { key: "todo", label: "Para hacer", hint: "Todas las pendientes" },
  { key: "overdue", label: "Vencidas", hint: "Pendientes con la fecha ya pasada" },
  { key: "today", label: "Hoy", hint: "Pendientes con fecha de hoy" },
  { key: "tomorrow", label: "Mañana", hint: "Pendientes con fecha de mañana" },
  { key: "week", label: "Esta semana", hint: "Pendientes de lunes a domingo de esta semana" },
  { key: "next_week", label: "Próxima semana", hint: "Pendientes de la semana que viene" },
  { key: "done", label: "Hechas", hint: "Las últimas actividades completadas" },
] as const;
export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number]["key"];

/** Límites (en UTC) de hoy, mañana, esta semana y la próxima, en la zona de la app. */
export function activityRanges(now = new Date(), tz = process.env.TZ || "Europe/Madrid") {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number);
  const at = (offsetDays: number) => {
    const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + offsetDays));
    return zonedToUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 0, 0, tz);
  };
  const dow = (new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay() + 6) % 7; // 0 = lunes
  return {
    today: at(0), tomorrow: at(1), dayAfter: at(2),
    weekStart: at(-dow), nextWeek: at(7 - dow), weekAfter: at(14 - dow),
  };
}

export async function listActivityBoard({ period, ownerId, type }: { period: ActivityPeriod; ownerId?: string | null; type?: string | null }) {
  await activityTypes();
  const r = activityRanges();
  const owner = ownerId ?? null;
  const range = {
    todo: sql`NOT a.done`,
    overdue: sql`NOT a.done AND a.due_at < now()`,
    today: sql`NOT a.done AND a.due_at >= ${r.today} AND a.due_at < ${r.tomorrow}`,
    tomorrow: sql`NOT a.done AND a.due_at >= ${r.tomorrow} AND a.due_at < ${r.dayAfter}`,
    week: sql`NOT a.done AND a.due_at >= ${r.weekStart} AND a.due_at < ${r.nextWeek}`,
    next_week: sql`NOT a.done AND a.due_at >= ${r.nextWeek} AND a.due_at < ${r.weekAfter}`,
    done: sql`a.done`,
  }[period];
  const [items, counts, types] = await Promise.all([
    sql<Activity[]>`
      ${select()}
      WHERE ${range}
        AND (${owner}::uuid IS NULL OR a.owner_id = ${owner}::uuid)
        AND (${type ?? null}::text IS NULL OR a.type = ${type ?? null})
      ORDER BY ${period === "done" ? sql`a.done_at DESC NULLS LAST` : sql`a.due_at NULLS LAST, a.created_at`}
      LIMIT 500`,
    sql<{ todo: number; overdue: number; today: number; tomorrow: number; week: number; next_week: number }[]>`
      SELECT count(*) FILTER (WHERE true)::int AS todo,
             count(*) FILTER (WHERE a.due_at < now())::int AS overdue,
             count(*) FILTER (WHERE a.due_at >= ${r.today} AND a.due_at < ${r.tomorrow})::int AS today,
             count(*) FILTER (WHERE a.due_at >= ${r.tomorrow} AND a.due_at < ${r.dayAfter})::int AS tomorrow,
             count(*) FILTER (WHERE a.due_at >= ${r.weekStart} AND a.due_at < ${r.nextWeek})::int AS week,
             count(*) FILTER (WHERE a.due_at >= ${r.nextWeek} AND a.due_at < ${r.weekAfter})::int AS next_week
      FROM activities a
      WHERE NOT a.done AND (${owner}::uuid IS NULL OR a.owner_id = ${owner}::uuid)
        AND (${type ?? null}::text IS NULL OR a.type = ${type ?? null})`,
    sql<{ type: string; n: number }[]>`
      SELECT a.type, count(*)::int AS n FROM activities a
      WHERE ${range} AND (${owner}::uuid IS NULL OR a.owner_id = ${owner}::uuid)
      GROUP BY a.type ORDER BY n DESC`,
  ]);
  return { items, counts: counts[0], types };
}
