import { sql } from "./db";
import { companyDomainFromEmail } from "./validation";

// ===========================================================================
// Puntuación de leads: de 0 a 100, con los motivos a la vista. Combina el
// encaje (empresa, cargo, tamaño) y el interés (etapa, formularios, correos
// abiertos o respondidos, reuniones) y baja con la inactividad.
// ===========================================================================

export type ScoreReason = { label: string; points: number };
export type Temperature = "hot" | "warm" | "cold";

export const temperature = (score: number | null): Temperature | null =>
  score === null ? null : score >= 70 ? "hot" : score >= 40 ? "warm" : "cold";
export const TEMPERATURE_LABEL: Record<Temperature, string> = { hot: "Caliente", warm: "Templado", cold: "Frío" };

export type LeadFacts = {
  email: string | null; organization_id: string | null; job_title: string | null; employee_count: number | null;
  funnel_stage: string | null; forms: number; demo_requests: number; opened: number; clicked: number; replied: number;
  meetings: number; last_touch: Date; fit?: "fit" | "no_fit" | "unknown" | null;
};

const DECISION = /\b(ceo|cto|cfo|coo|cmo|cio|director|directora|head|jefe|jefa|gerente|founder|fundador|fundadora|owner|propietari[oa]|vp|chief|socio|socia|responsable|manager)\b/i;

export function scoreLead(f: LeadFacts, now = new Date()): { score: number; reasons: ScoreReason[] } {
  const r: ScoreReason[] = [];
  const add = (label: string, points: number) => { if (points) r.push({ label, points }); };
  if (f.organization_id || companyDomainFromEmail(f.email)) add("Empresa identificada", 10);
  if (f.job_title && DECISION.test(f.job_title)) add(`Cargo con capacidad de decisión (${f.job_title})`, 15);
  if (f.employee_count != null) {
    if (f.employee_count > 250) add(`Empresa grande (${f.employee_count} empleados)`, 15);
    else if (f.employee_count > 50) add(`Empresa mediana (${f.employee_count} empleados)`, 10);
  }
  if (f.funnel_stage === "bofu") add("En decisión (BOFU)", 30);
  else if (f.funnel_stage === "mofu") add("En consideración (MOFU)", 15);
  else if (f.funnel_stage === "tofu") add("Descubriendo (TOFU)", 5);
  if (f.demo_requests > 0) add("Ha pedido una demo o reunión", 20);
  if (f.forms > 1) add(`Ha vuelto a escribirnos (${f.forms} formularios)`, Math.min(10, (f.forms - 1) * 5));
  if (f.replied > 0) add("Ha respondido a un correo", 20);
  else if (f.clicked > 0) add("Ha hecho clic en un correo", 10);
  else if (f.opened > 0) add("Ha abierto un correo", 5);
  if (f.meetings > 0) add("Tiene una reunión agendada o hecha", 25);
  if (f.fit === "fit") add("Encaja con el perfil de cliente ideal", 15);
  else if (f.fit === "no_fit") add("No encaja con el perfil de cliente ideal", -25);
  const idle = Math.floor((now.getTime() - new Date(f.last_touch).getTime()) / 86400000);
  if (idle > 90) add(`Sin actividad desde hace ${idle} días`, -25);
  else if (idle > 30) add(`Sin actividad desde hace ${idle} días`, -10);
  const score = Math.max(0, Math.min(100, r.reduce((n, x) => n + x.points, 0)));
  return { score, reasons: r };
}

/** Recalcula la puntuación de los leads abiertos (o de uno). Devuelve cuántos cambiaron. */
export async function recomputeScores(leadId?: string): Promise<number> {
  const rows = await sql<(LeadFacts & { id: string; score: number | null })[]>`
    SELECT l.id, l.score, l.funnel_stage, l.organization_id, l.fit,
           (SELECT email FROM person_emails e WHERE e.person_id = l.person_id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           po.job_title, o.employee_count,
           (SELECT count(*)::int FROM events ev WHERE ev.entity_type = 'lead' AND ev.entity_id = l.id AND ev.event_type = 'lead.form_submitted') AS forms,
           (SELECT count(*)::int FROM events ev WHERE ev.entity_type = 'lead' AND ev.entity_id = l.id AND ev.event_type = 'lead.form_submitted'
              AND ev.payload->>'intent' = 'demo_request') AS demo_requests,
           (SELECT count(*)::int FROM emails m WHERE m.person_id = l.person_id AND m.direction = 'out' AND m.open_count > 0) AS opened,
           (SELECT count(*)::int FROM emails m WHERE m.person_id = l.person_id AND m.direction = 'out' AND m.click_count > 0) AS clicked,
           (SELECT count(*)::int FROM emails m WHERE m.person_id = l.person_id AND m.direction = 'in') AS replied,
           (SELECT count(*)::int FROM activities a JOIN activity_types t ON t.key = a.type AND t.is_session
              WHERE (a.lead_id = l.id OR a.person_id = l.person_id) AND coalesce(a.outcome, 'held') <> 'no_show') AS meetings,
           greatest(l.updated_at,
             coalesce((SELECT max(occurred_at) FROM events ev WHERE ev.entity_type = 'lead' AND ev.entity_id = l.id), l.updated_at),
             coalesce((SELECT max(coalesce(m.sent_at, m.created_at)) FROM emails m WHERE m.person_id = l.person_id), l.updated_at)) AS last_touch
    FROM leads l
    LEFT JOIN LATERAL (SELECT job_title, organization_id FROM person_organizations
                       WHERE person_id = l.person_id AND status = 'current' ORDER BY created_at DESC LIMIT 1) po ON true
    LEFT JOIN organizations o ON o.id = coalesce(l.organization_id, po.organization_id)
    WHERE l.deleted_at IS NULL AND (${leadId ?? null}::uuid IS NOT NULL AND l.id = ${leadId ?? null}::uuid
                                    OR ${leadId ?? null}::uuid IS NULL AND l.status = 'open')
    LIMIT 5000`;
  let changed = 0;
  for (const row of rows) {
    const { score, reasons } = scoreLead(row);
    if (score === row.score && !leadId) continue;
    // updated_at no se toca: la puntuación no es «actividad» del lead.
    await sql`UPDATE leads SET score = ${score}, score_reasons = ${sql.json(reasons)}, scored_at = now() WHERE id = ${row.id}`;
    changed++;
  }
  return changed;
}
