import { sql } from "./db";
import { createActivity } from "./activities";
import { UserError } from "./errors";
import type { Actor } from "./events";

// ===========================================================================
// «Siguiente paso»: un deal abierto sin ninguna actividad pendiente se queda
// olvidado. Al completar la última, se propone programar la siguiente con un
// clic (llamar mañana, seguimiento en unos días…).
// ===========================================================================

const TZ = () => process.env.TZ || "Europe/Madrid";

export const NEXT_PRESETS = {
  call_tomorrow: { label: "Llamar mañana", type: "call", subject: "Llamada de seguimiento", days: 1 },
  followup_3: { label: "Seguimiento en 3 días", type: "task", subject: "Seguimiento", days: 3 },
  followup_7: { label: "Seguimiento en una semana", type: "task", subject: "Seguimiento", days: 7 },
  followup_14: { label: "En dos semanas", type: "task", subject: "Retomar el contacto", days: 14 },
} as const;
export type NextPreset = keyof typeof NEXT_PRESETS;

/** El deal (abierto) se ha quedado sin actividades pendientes. */
export async function dealWithoutNext(dealId: string | null): Promise<{ id: string; title: string } | null> {
  if (!dealId) return null;
  const [d] = await sql<{ id: string; title: string }[]>`
    SELECT d.id, d.title FROM deals d
    WHERE d.id = ${dealId} AND d.status = 'open' AND d.deleted_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.deal_id = d.id AND NOT a.done)`;
  return d ?? null;
}

/** Un día laborable a N días vista, a las 10:00 en la hora del CRM. */
export function workdayAt(days: number, hour = 10, now = new Date()) {
  const day = new Date(`${new Intl.DateTimeFormat("en-CA", { timeZone: TZ() }).format(now)}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  while ([0, 6].includes(day.getUTCDay())) day.setUTCDate(day.getUTCDate() + 1);
  const ymd = day.toISOString().slice(0, 10);
  // Hora local → instante: se corrige con el desfase de la zona ese día.
  const guess = new Date(`${ymd}T${String(hour).padStart(2, "0")}:00:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(guess).map((x) => [x.type, x.value]));
  const asLocal = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(guess.getTime() - (asLocal - guess.getTime()));
}

export async function scheduleNext(actor: Actor, dealId: string, preset: NextPreset) {
  const p = NEXT_PRESETS[preset];
  if (!p) throw new UserError("Opción no válida.");
  const [deal] = await sql<{ id: string; owner_id: string | null }[]>`SELECT id, owner_id FROM deals WHERE id = ${dealId} AND deleted_at IS NULL`;
  if (!deal) throw new UserError("El deal ya no existe.");
  const [person] = await sql<{ person_id: string }[]>`
    SELECT person_id FROM deal_participants WHERE deal_id = ${dealId} ORDER BY is_primary DESC, created_at LIMIT 1`;
  return createActivity(actor, {
    type: p.type, subject: p.subject, deal_id: dealId, person_id: person?.person_id,
    due_at: workdayAt(p.days).toISOString(), owner_id: deal.owner_id ?? actor.id ?? undefined,
  });
}

/** Deshace un «siguiente paso» recién programado (solo si lo creó la misma persona hace poco y sigue pendiente). */
export async function undoScheduled(actor: Actor, activityId: string) {
  const [a] = await sql<{ id: string }[]>`
    DELETE FROM activities WHERE id = ${activityId} AND created_by_id = ${actor.id} AND NOT done
      AND created_at > now() - interval '15 minutes' RETURNING id`;
  if (!a) throw new UserError("Ya no se puede deshacer: edítala o bórrala desde la ficha del deal.");
}
