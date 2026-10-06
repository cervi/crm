import { sql } from "./db";
import { recordEvent, AI_ACTOR } from "./events";
import { notify } from "./notifications";
import { localNow } from "./digest";
import { RED, levelOf, type HealthLevel } from "./health-level";
export { RED, levelOf, LEVEL_LABEL, type HealthLevel } from "./health-level";

// ===========================================================================
// Salud de los deals: de 0 a 100, con las señales que la explican.
//
// Parte de 50. Las señales de riesgo restan (nadie responde, fecha de cierre
// pasada o movida, un solo contacto, ausencias, competidor o precio en la
// conversación, parado…) y las positivas suman (reunión agendada, responde
// rápido, abre la propuesta varias veces, entra un directivo…). La calcula
// la revisión periódica; si un deal entra en rojo, se avisa a su responsable.
// ===========================================================================

export type HealthTone = "risk" | "good";
export type HealthSignal = { key: string; label: string; detail?: string | null; tone: HealthTone; points: number };
export type Health = { score: number; level: HealthLevel; signals: HealthSignal[] };

export type HealthFacts = {
  id: string; title: string; owner_id: string | null; days_in_stage: number; rotten_after_days: number | null;
  expected_close_date: string | null; close_moves: number; contacts: number; seniors: number; new_senior: string | null;
  unreplied_out: number; last_in_at: Date | null; last_out_at: Date | null; quick_reply: boolean;
  no_shows: number; overdue: number; upcoming_session_at: Date | null; next_activity_at: Date | null; booked: boolean;
  mention: string | null; proposal_views: number; opens_week: number; open_spots: number; last_touch_at: Date | null;
};

const DECISION = "(ceo|cto|cfo|coo|cmo|cio|director|directora|head|jefe|jefa|gerente|founder|fundador|fundadora|owner|propietari|vp|chief|socio|socia)";
const MENTIONS = "competidor|competencia|otro proveedor|otra propuesta|otras opciones|otra opción|más barato|mas barato|muy caro|demasiado caro|fuera de presupuesto|presupuesto ajustado|sin presupuesto|rebaja|descuento";

const days = (d: Date | null, now: Date) => (d ? Math.floor((now.getTime() - new Date(d).getTime()) / 86400000) : null);
const ago = (n: number) => (n === 0 ? "hoy" : n === 1 ? "ayer" : `hace ${n} días`);
const shortDate = (d: Date | string) => new Date(d).toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: process.env.TZ || "Europe/Madrid" });

/** Las señales y la puntuación de un deal a partir de sus datos (sin consultas: se puede probar aislado). */
export function scoreHealth(f: HealthFacts, now = new Date()): Health {
  const s: HealthSignal[] = [];
  const risk = (key: string, label: string, points: number, detail?: string) => s.push({ key, label, points: -points, tone: "risk", detail });
  const good = (key: string, label: string, points: number, detail?: string) => s.push({ key, label, points, tone: "good", detail });

  // --- Riesgos
  if (f.unreplied_out >= 2) risk("no_reply", `${f.unreplied_out} correos sin respuesta en 10 días`, f.unreplied_out >= 3 ? 20 : 15, "Prueba otro canal (llamada, LinkedIn) u otro contacto.");
  const inDays = days(f.last_in_at, now);
  if (f.last_in_at && (!f.last_out_at || f.last_in_at > f.last_out_at) && inDays !== null && inDays >= 2) {
    risk("we_owe_reply", `Te escribió ${ago(inDays)} y no hay respuesta`, 10);
  }
  if (f.rotten_after_days !== null && f.days_in_stage > f.rotten_after_days) {
    const double = f.days_in_stage >= f.rotten_after_days * 2;
    risk("stalled", `Parado: ${f.days_in_stage} días en la fase (límite ${f.rotten_after_days})`, double ? 25 : 15);
  }
  if (f.expected_close_date && new Date(`${f.expected_close_date}T23:59:59`) < now) risk("close_past", `La fecha de cierre (${shortDate(`${f.expected_close_date}T12:00:00`)}) ya pasó`, 10);
  if (f.close_moves >= 2) risk("close_moved", `Fecha de cierre movida ${f.close_moves} veces`, 10, "Pide una fecha realista y ajusta la previsión.");
  if (f.contacts === 0) risk("no_contacts", "Sin ningún contacto", 15);
  else if (f.contacts === 1) risk("single_thread", "Un solo contacto", 10, "Implica a más personas: decisor, usuario, compras.");
  if (f.contacts > 0 && f.seniors === 0) risk("no_decision_maker", "Ningún contacto con capacidad de decisión", 5);
  if (f.no_shows > 0) risk("no_show", f.no_shows === 1 ? "No se presentó a una reunión" : `${f.no_shows} ausencias en reuniones`, 10);
  if (f.mention) risk("competition", `Se habla de «${f.mention}» en la conversación`, 10, "Prepara argumentos de valor y avisa al responsable.");
  if (f.overdue > 0) risk("overdue", f.overdue === 1 ? "Una tarea vencida" : `${f.overdue} tareas vencidas`, 5);
  if (!f.next_activity_at) risk("no_next_step", "Sin siguiente paso agendado", 5);
  const quiet = days(f.last_touch_at, now);
  if (quiet === null || quiet > 21) risk("quiet", quiet === null ? "Todavía sin ninguna interacción" : `Sin interacción desde hace ${quiet} días`, 10);

  // --- Señales positivas
  if (f.upcoming_session_at) good("meeting", `Reunión agendada para el ${shortDate(f.upcoming_session_at)}`, 15);
  if (f.booked) good("booked", "Reservó la reunión él mismo", 5);
  if (inDays !== null && inDays <= 7) good("engaged", `Respondió ${ago(inDays)}`, 10);
  if (f.quick_reply) good("quick_reply", "Responde en menos de 24 horas", 10);
  if (f.proposal_views >= 2) good("proposal_views", `Ha abierto la propuesta ${f.proposal_views} veces en dos semanas`, 10, "Buen momento para llamar.");
  else if (f.proposal_views === 1) good("proposal_view", "Ha abierto la propuesta", 5);
  if (f.open_spots >= 2) good("shared", "Correos abiertos desde varios dispositivos o lugares", 5, "Puede que lo esté compartiendo con su equipo.");
  if (f.opens_week >= 3) good("opens", `Ha abierto tus correos ${f.opens_week} veces esta semana`, 5);
  if (f.new_senior) good("senior", `Nuevo interlocutor con capacidad de decisión: ${f.new_senior}`, 10, "Propón una reunión ejecutiva.");

  const score = Math.max(0, Math.min(100, 50 + s.reduce((n, x) => n + x.points, 0)));
  s.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score, level: levelOf(score), signals: s };
}

/** Datos de salud de los deals abiertos (o de uno). */
export async function healthFacts(dealId?: string): Promise<HealthFacts[]> {
  const [settings] = await sql<{ competitors: string[] }[]>`SELECT competitors FROM app_settings LIMIT 1`;
  const names = (settings?.competitors ?? []).map((c) => c.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(Boolean);
  const mentionRe = `(${[MENTIONS, ...names].join("|")})`;
  return sql<HealthFacts[]>`
    WITH people AS (
      SELECT dp.deal_id, dp.person_id FROM deal_participants dp
    )
    SELECT ods.id, ods.title, ods.owner_id, ods.days_in_stage, s.rotten_after_days, d.expected_close_date::text,
      (SELECT count(*)::int FROM events ev WHERE ev.entity_type = 'deal' AND ev.entity_id = ods.id
         AND ev.event_type = 'deal.close_date_changed' AND ev.payload->>'from' IS NOT NULL AND ev.occurred_at > now() - interval '120 days') AS close_moves,
      (SELECT count(*)::int FROM deal_participants dp JOIN persons p ON p.id = dp.person_id AND p.deleted_at IS NULL WHERE dp.deal_id = ods.id) AS contacts,
      (SELECT count(*)::int FROM deal_participants dp
         JOIN person_organizations po ON po.person_id = dp.person_id AND po.status = 'current'
         WHERE dp.deal_id = ods.id AND (po.job_title ~* ${DECISION} OR dp.role ~* '(decisor|decision)')) AS seniors,
      (SELECT p.full_name FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
         JOIN person_organizations po ON po.person_id = dp.person_id AND po.status = 'current'
         WHERE dp.deal_id = ods.id AND po.job_title ~* ${DECISION} AND dp.created_at > now() - interval '30 days'
           AND dp.created_at > d.created_at + interval '1 day'
         ORDER BY dp.created_at DESC LIMIT 1) AS new_senior,
      io.last_in_at, io.last_out_at,
      (SELECT count(*)::int FROM emails m WHERE m.deal_id = ods.id AND m.direction = 'out' AND m.status = 'sent'
         AND m.sent_at > now() - interval '10 days' AND m.sent_at > coalesce(io.last_in_at, '-infinity')) AS unreplied_out,
      EXISTS (SELECT 1 FROM emails r WHERE r.direction = 'in' AND r.sent_at > now() - interval '30 days'
                AND (r.deal_id = ods.id OR r.person_id IN (SELECT person_id FROM people WHERE deal_id = ods.id))
                AND EXISTS (SELECT 1 FROM emails o WHERE o.deal_id = ods.id AND o.direction = 'out' AND o.status = 'sent'
                              AND o.sent_at < r.sent_at AND o.sent_at > r.sent_at - interval '24 hours')) AS quick_reply,
      (SELECT count(*)::int FROM activities a WHERE a.deal_id = ods.id AND a.outcome = 'no_show' AND a.done_at > now() - interval '60 days') AS no_shows,
      (SELECT count(*)::int FROM activities a WHERE a.deal_id = ods.id AND NOT a.done AND a.due_at < now()
         AND a.type NOT IN (SELECT key FROM activity_types WHERE is_session)) AS overdue,
      (SELECT min(a.due_at) FROM activities a WHERE a.deal_id = ods.id AND NOT a.done AND a.due_at >= now()
         AND a.type IN (SELECT key FROM activity_types WHERE is_session)) AS upcoming_session_at,
      (SELECT min(a.due_at) FROM activities a WHERE a.deal_id = ods.id AND NOT a.done AND a.due_at >= now()) AS next_activity_at,
      EXISTS (SELECT 1 FROM events ev WHERE ev.entity_type = 'deal' AND ev.entity_id = ods.id AND ev.event_type = 'deal.booked'
                AND ev.occurred_at > now() - interval '30 days') AS booked,
      (SELECT substring(lower(t.txt) FROM ${mentionRe}) FROM (
          SELECT r.body AS txt, r.sent_at AS at FROM emails r WHERE r.direction = 'in' AND r.sent_at > now() - interval '30 days'
            AND (r.deal_id = ods.id OR r.person_id IN (SELECT person_id FROM people WHERE deal_id = ods.id))
          UNION ALL SELECT n.content, n.created_at FROM notes n WHERE n.deal_id = ods.id AND n.created_at > now() - interval '30 days'
          UNION ALL SELECT coalesce(a.transcript, '') || ' ' || coalesce(a.note, ''), a.done_at FROM activities a
            WHERE a.deal_id = ods.id AND a.done AND a.done_at > now() - interval '30 days' AND a.type <> 'email'
        ) t WHERE lower(t.txt) ~ ${mentionRe} ORDER BY t.at DESC LIMIT 1) AS mention,
      (SELECT count(*)::int FROM proposal_views v JOIN proposals pr ON pr.id = v.proposal_id
         WHERE pr.deal_id = ods.id AND v.at > now() - interval '14 days') AS proposal_views,
      (SELECT count(*)::int FROM email_opens eo JOIN emails m ON m.id = eo.email_id
         WHERE m.deal_id = ods.id AND NOT eo.automatic AND eo.at > now() - interval '7 days') AS opens_week,
      (SELECT count(DISTINCT coalesce(eo.device, '') || '|' || coalesce(eo.client, '') || '|' || coalesce(eo.place, ''))::int
         FROM email_opens eo JOIN emails m ON m.id = eo.email_id
         WHERE m.deal_id = ods.id AND NOT eo.automatic AND eo.at > now() - interval '30 days'
           AND (eo.device IS DISTINCT FROM 'unknown' OR eo.place IS NOT NULL)) AS open_spots,
      greatest((SELECT max(done_at) FROM activities WHERE deal_id = ods.id AND done),
               (SELECT max(created_at) FROM notes WHERE deal_id = ods.id), io.last_in_at, io.last_out_at) AS last_touch_at
    FROM open_deals_status ods
    JOIN deals d ON d.id = ods.id
    JOIN stages s ON s.id = ods.stage_id
    LEFT JOIN LATERAL (
      SELECT max(m.sent_at) FILTER (WHERE m.direction = 'in') AS last_in_at,
             max(m.sent_at) FILTER (WHERE m.direction = 'out' AND m.status = 'sent') AS last_out_at
      FROM emails m
      WHERE m.deal_id = ods.id OR (m.direction = 'in' AND m.person_id IN (SELECT person_id FROM people WHERE deal_id = ods.id))
    ) io ON true
    WHERE ${dealId ? sql`ods.id = ${dealId}` : sql`true`}
    LIMIT 5000`;
}

/**
 * Recalcula la salud de los deals abiertos (o de uno) y avisa al responsable
 * de los que acaban de entrar en rojo. Devuelve cuántos han cambiado.
 */
export async function recomputeHealth(dealId?: string): Promise<number> {
  const facts = await healthFacts(dealId);
  const day = localNow().day;
  let changed = 0;
  for (const f of facts) {
    const h = scoreHealth(f);
    const [prev] = await sql<{ score: number; red_since: Date | null }[]>`SELECT score, red_since FROM deal_health WHERE deal_id = ${f.id}`;
    const nowRed = h.score < RED;
    // Histéresis: sale del rojo a partir de 45, para no avisar cada vez que oscila.
    const redSince = nowRed ? prev?.red_since ?? new Date() : prev?.red_since && h.score < RED + 5 ? prev.red_since : null;
    await sql`
      INSERT INTO deal_health (deal_id, score, signals, computed_at, red_since)
      VALUES (${f.id}, ${h.score}, ${sql.json(h.signals)}, now(), ${redSince})
      ON CONFLICT (deal_id) DO UPDATE SET score = EXCLUDED.score, signals = EXCLUDED.signals, computed_at = now(), red_since = EXCLUDED.red_since`;
    await sql`INSERT INTO deal_health_daily (deal_id, day, score) VALUES (${f.id}, ${day}, ${h.score})
              ON CONFLICT (deal_id, day) DO UPDATE SET score = EXCLUDED.score`;
    if (prev?.score !== h.score) changed++;
    // Entra en rojo (y antes no lo estaba): a la historia y aviso al responsable.
    if (nowRed && !prev?.red_since && prev !== undefined) {
      const why = h.signals.filter((x) => x.tone === "risk").slice(0, 3).map((x) => x.label);
      await recordEvent(sql, AI_ACTOR, "deal", f.id, "deal.health_red", { score: h.score, reasons: why });
      if (f.owner_id) {
        await notify(sql, { userId: f.owner_id, kind: "health", title: `«${f.title}» está en riesgo (salud ${h.score})`, body: why.join(" · "), link: `/deals/${f.id}` });
      }
    }
  }
  if (!dealId) {
    await sql`DELETE FROM deal_health h WHERE NOT EXISTS (SELECT 1 FROM open_deals_status o WHERE o.id = h.deal_id)`;
    await sql`DELETE FROM deal_health_daily WHERE day < current_date - 120`;
  }
  return changed;
}

export type StoredHealth = Health & { computed_at: Date };

export async function getHealth(dealId: string): Promise<StoredHealth | null> {
  const [h] = await sql<{ score: number; signals: HealthSignal[]; computed_at: Date }[]>`
    SELECT score, signals, computed_at FROM deal_health WHERE deal_id = ${dealId}`;
  return h ? { ...h, level: levelOf(h.score) } : null;
}

/** Deals cuya salud ha cambiado al menos `min` puntos desde ayer (para el parte del día). */
export async function healthMovers(ownerId: string | null, min = 10) {
  return sql<{ id: string; title: string; score: number; before: number; signals: HealthSignal[] }[]>`
    SELECT d.id, d.title, h.score, y.score AS before, h.signals
    FROM deal_health h
    JOIN deals d ON d.id = h.deal_id AND d.status = 'open' AND d.deleted_at IS NULL
    JOIN LATERAL (SELECT score FROM deal_health_daily x WHERE x.deal_id = h.deal_id AND x.day < current_date ORDER BY x.day DESC LIMIT 1) y ON true
    WHERE abs(h.score - y.score) >= ${min} AND (${ownerId}::uuid IS NULL OR d.owner_id = ${ownerId}::uuid)
    ORDER BY abs(h.score - y.score) DESC LIMIT 10`;
}
