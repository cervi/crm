import type postgres from "postgres";
import { sql, json } from "./db";
import { aiReady, generate, getAiSettings, parseJsonReply } from "./ai";
import { activityLabel, date, money } from "./format";
import { activityTypes } from "./activity-types";

// ===========================================================================
// Resumen y siguiente paso de cada deal.
//
// Las «señales» de un deal (correo sin responder, reunión sin marcar, tarea
// vencida, sesión sin agendar, días parado…) se calculan con una consulta y
// deciden el siguiente paso. Con la IA configurada, además se redacta un
// resumen que se guarda en caché hasta que el deal cambia.
// ===========================================================================

export type Signals = {
  id: string; title: string; organization_name: string | null; owner_id: string | null; owner_name: string | null;
  value: string | null; currency: string; stage_name: string; days_in_stage: number; rotten_after_days: number | null;
  required_activity_type: string | null; has_upcoming_session: boolean;
  overdue_subject: string | null; overdue_at: Date | null; overdue_count: number;
  unmarked_subject: string | null; unmarked_type: string | null; unmarked_at: Date | null;
  unanswered_subject: string | null; unanswered_from: string | null; unanswered_at: Date | null;
  next_subject: string | null; next_type: string | null; next_at: Date | null;
  last_touch_at: Date | null; pending_ai: number; expected_close_date: string | null;
};

// Tipos que son sesiones con el cliente (configurable en Ajustes → Tipos de actividad).
const SESSIONS = sql`(SELECT key FROM activity_types WHERE is_session)`;

/** Señales de los deals abiertos que cumplen `where` (sobre la vista open_deals_status «ods»). */
export function dealSignals(where: postgres.PendingQuery<postgres.Row[]> = sql`true`, limit = 500) {
  return sql<Signals[]>`
    SELECT ods.id, ods.title, o.name AS organization_name, ods.owner_id, u.name AS owner_name, ods.value::text, ods.currency,
           ods.stage_name, ods.days_in_stage, s.rotten_after_days, ods.required_activity_type, ods.has_upcoming_session,
           ov.subject AS overdue_subject, ov.due_at AS overdue_at, coalesce(ov.n, 0)::int AS overdue_count,
           um.subject AS unmarked_subject, um.type AS unmarked_type, um.due_at AS unmarked_at,
           ua.subject AS unanswered_subject, ua.sender AS unanswered_from, ua.done_at AS unanswered_at,
           nx.subject AS next_subject, nx.type AS next_type, nx.due_at AS next_at,
           lt.at AS last_touch_at, coalesce(ai.n, 0)::int AS pending_ai, d.expected_close_date::text
    FROM open_deals_status ods
    JOIN deals d ON d.id = ods.id
    JOIN stages s ON s.id = ods.stage_id
    LEFT JOIN organizations o ON o.id = ods.organization_id
    LEFT JOIN users u ON u.id = ods.owner_id
    -- tareas vencidas (lo que no es una sesión)
    LEFT JOIN LATERAL (
      SELECT (array_agg(a.subject ORDER BY a.due_at))[1] AS subject, min(a.due_at) AS due_at, count(*) AS n
      FROM activities a WHERE a.deal_id = ods.id AND NOT a.done AND a.due_at < now() AND a.type NOT IN ${SESSIONS}
    ) ov ON true
    -- sesiones ya pasadas sin marcar cómo fueron (últimas dos semanas)
    LEFT JOIN LATERAL (
      SELECT a.subject, a.type, a.due_at FROM activities a
      WHERE a.deal_id = ods.id AND NOT a.done AND a.type IN ${SESSIONS}
        AND a.due_at < now() AND a.due_at > now() - interval '14 days'
      ORDER BY a.due_at DESC LIMIT 1
    ) um ON true
    -- último correo recibido, si es posterior al último enviado
    LEFT JOIN LATERAL (
      SELECT r.subject, substring(r.note FROM '^Recibido de ([^\n]+)') AS sender, r.done_at FROM activities r
      WHERE r.deal_id = ods.id AND r.type = 'email' AND r.done AND r.note LIKE 'Recibido de %'
        AND r.done_at > coalesce((SELECT max(s2.done_at) FROM activities s2
                                  WHERE s2.deal_id = ods.id AND s2.type = 'email' AND s2.done AND s2.note NOT LIKE 'Recibido de %'), '-infinity')
      ORDER BY r.done_at DESC LIMIT 1
    ) ua ON true
    -- próxima actividad
    LEFT JOIN LATERAL (
      SELECT a.subject, a.type, a.due_at FROM activities a
      WHERE a.deal_id = ods.id AND NOT a.done AND a.due_at >= now() ORDER BY a.due_at LIMIT 1
    ) nx ON true
    -- última interacción (actividad hecha o nota)
    LEFT JOIN LATERAL (
      SELECT greatest((SELECT max(done_at) FROM activities WHERE deal_id = ods.id AND done),
                      (SELECT max(created_at) FROM notes WHERE deal_id = ods.id)) AS at
    ) lt ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS n FROM automation_actions x WHERE x.deal_id = ods.id AND x.status = 'pending'
    ) ai ON true
    WHERE ${where}
    LIMIT ${limit}`;
}

export type NextStep = { text: string; priority: 1 | 2 | 3 | 4; why: string };

const daysAgo = (d: Date | null) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null);
const ago = (d: Date | null) => {
  const n = daysAgo(d);
  return n === null ? "" : n === 0 ? "hoy" : n === 1 ? "ayer" : `hace ${n} días`;
};

/** El siguiente paso más útil según las señales, con su prioridad (1 = urgente). */
export function nextStep(s: Signals): NextStep {
  if (s.unanswered_subject) {
    return { priority: 1, text: `Responde a ${s.unanswered_from ?? "tu contacto"}: «${s.unanswered_subject}»`, why: `Te escribió ${ago(s.unanswered_at)} y no hay respuesta.` };
  }
  if (s.unmarked_subject) {
    return { priority: 1, text: `Marca cómo fue «${s.unmarked_subject}»`, why: `La ${activityLabel(s.unmarked_type).toLowerCase()} fue ${ago(s.unmarked_at)} y no tiene resultado.` };
  }
  if (s.overdue_subject) {
    return { priority: 1, text: `Completa «${s.overdue_subject}»`, why: `Vencida ${ago(s.overdue_at)}${s.overdue_count > 1 ? ` (y ${s.overdue_count - 1} más)` : ""}.` };
  }
  if (s.pending_ai > 0) {
    return { priority: 2, text: `Revisa ${s.pending_ai === 1 ? "la propuesta" : `las ${s.pending_ai} propuestas`} de la IA`, why: "Están esperando tu decisión en la bandeja." };
  }
  if (s.required_activity_type && !s.has_upcoming_session) {
    const session = activityLabel(s.required_activity_type).toLowerCase();
    return { priority: 2, text: `Agenda la ${session}`, why: `La fase «${s.stage_name}» la requiere y no hay ninguna agendada.` };
  }
  if (s.rotten_after_days !== null && s.days_in_stage > s.rotten_after_days) {
    return { priority: 2, text: "Retoma el contacto", why: `Lleva ${s.days_in_stage} días en «${s.stage_name}» (el límite es ${s.rotten_after_days}).` };
  }
  if (!s.next_subject) {
    return { priority: 3, text: "Programa el siguiente paso", why: "No hay nada agendado." };
  }
  return { priority: 4, text: `Prepara «${s.next_subject}»`, why: `${activityLabel(s.next_type)} el ${date(s.next_at)}.` };
}

/** Riesgos visibles en las señales. */
export function risks(s: Signals, extra: { noShows: number; contactsWithEmail: number; contacts: number }): string[] {
  const out: string[] = [];
  if (s.expected_close_date && new Date(`${s.expected_close_date}T23:59:59`) < new Date()) out.push(`La fecha de cierre prevista (${date(s.expected_close_date)}) ya ha pasado.`);
  if (extra.noShows > 0) out.push(`${extra.noShows === 1 ? "Ya hubo una ausencia" : `Ya hubo ${extra.noShows} ausencias`} en sus sesiones.`);
  const quiet = daysAgo(s.last_touch_at);
  if (quiet === null) out.push("Todavía no hay ninguna interacción registrada.");
  else if (quiet > 14) out.push(`Sin interacción desde hace ${quiet} días.`);
  if (extra.contacts === 0) out.push("No tiene ningún contacto asociado.");
  else if (extra.contactsWithEmail === 0) out.push("Ningún contacto del deal tiene email.");
  else if (extra.contacts === 1) out.push("Solo hay un contacto: conviene implicar a más personas (decisor, usuario).");
  return out.slice(0, 4);
}

export type Brief = {
  resumen: string; siguiente_paso: string; por_que: string; riesgos: string[]; prioridad: NextStep["priority"];
  source: "ai" | "rules"; generated_at: Date | null; stale: boolean;
};

type Facts = Awaited<ReturnType<typeof dealFacts>>;

/** Todo lo que se sabe del deal, para el resumen por reglas y para la IA. */
export async function dealFacts(dealId: string) {
  await activityTypes();
  const [s] = await dealSignals(sql`ods.id = ${dealId}`, 1);
  if (!s) return null;
  const [contacts, history, docs, [counts], [basis]] = await Promise.all([
    sql<{ full_name: string; role: string | null; job_title: string | null; email: string | null }[]>`
      SELECT p.full_name, dp.role,
             (SELECT job_title FROM person_organizations WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1) AS job_title,
             (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email
      FROM deal_participants dp JOIN persons p ON p.id = dp.person_id WHERE dp.deal_id = ${dealId}
      ORDER BY dp.is_primary DESC, p.full_name`,
    sql<{ at: Date; kind: string; subject: string | null; outcome: string | null; text: string | null }[]>`
      SELECT * FROM (
        SELECT coalesce(a.done_at, a.due_at) AS at, a.type AS kind, a.subject, a.outcome,
               left(coalesce(a.summary, a.note), 600) AS text
        FROM activities a WHERE a.deal_id = ${dealId} AND a.done
        UNION ALL
        SELECT n.created_at, 'note', NULL, NULL, left(n.content, 600) FROM notes n WHERE n.deal_id = ${dealId}
      ) h ORDER BY at DESC LIMIT 12`,
    sql<{ title: string }[]>`SELECT title FROM deal_documents WHERE deal_id = ${dealId} ORDER BY created_at DESC LIMIT 10`,
    sql<{ no_shows: number }[]>`SELECT count(*)::int AS no_shows FROM activities WHERE deal_id = ${dealId} AND outcome = 'no_show'`,
    sql<{ v: string }[]>`SELECT coalesce(max(id), 0)::text AS v FROM events WHERE entity_type = 'deal' AND entity_id = ${dealId}`,
  ]);
  return {
    signals: s,
    contacts,
    history,
    documents: docs.map((d) => d.title),
    noShows: counts.no_shows,
    // La versión del resumen: último evento del deal y día (las fechas relativas cambian cada día).
    basis: `${basis.v}:${new Date().toISOString().slice(0, 10)}`,
  };
}

function ruleBrief(f: NonNullable<Facts>): Brief {
  const s = f.signals;
  const step = nextStep(s);
  const last = f.history[0];
  const lastText = last
    ? `Última interacción: ${last.kind === "note" ? "nota" : activityLabel(last.kind).toLowerCase()}${last.subject ? ` «${last.subject}»` : ""} ${ago(last.at)}.`
    : "Todavía no hay interacciones registradas.";
  const who = f.contacts[0] ? ` con ${f.contacts[0].full_name}${f.contacts[0].job_title ? ` (${f.contacts[0].job_title})` : ""}` : "";
  return {
    resumen: `En «${s.stage_name}» desde hace ${s.days_in_stage} día${s.days_in_stage === 1 ? "" : "s"}, ${money(s.value, s.currency)}${who}. ${lastText}`,
    siguiente_paso: step.text,
    por_que: step.why,
    riesgos: risks(s, { noShows: f.noShows, contacts: f.contacts.length, contactsWithEmail: f.contacts.filter((c) => c.email).length }),
    prioridad: step.priority,
    source: "rules",
    generated_at: null,
    stale: false,
  };
}

/** Datos que se envían al modelo (sin ids internos). */
function aiInput(f: NonNullable<Facts>, rules: Brief) {
  const s = f.signals;
  return {
    deal: { titulo: s.title, empresa: s.organization_name, importe: money(s.value, s.currency), fase: s.stage_name,
            dias_en_fase: s.days_in_stage, limite_dias_fase: s.rotten_after_days, cierre_previsto: s.expected_close_date,
            responsable: s.owner_name, sesion_que_pide_la_fase: s.required_activity_type ? activityLabel(s.required_activity_type) : null,
            sesion_agendada: s.has_upcoming_session },
    contactos: f.contacts.map((c) => ({ nombre: c.full_name, rol: c.role, cargo: c.job_title, tiene_email: Boolean(c.email) })),
    historial: f.history.map((h) => ({ fecha: new Date(h.at).toISOString().slice(0, 10), tipo: h.kind === "note" ? "nota" : activityLabel(h.kind),
                                       asunto: h.subject, resultado: h.outcome, texto: h.text })),
    proxima_actividad: s.next_subject ? { asunto: s.next_subject, fecha: s.next_at } : null,
    documentos: f.documents,
    señales: { siguiente_paso_por_reglas: rules.siguiente_paso, motivo: rules.por_que, riesgos_por_reglas: rules.riesgos },
  };
}

/** Resumen para mostrar: el de la IA si está al día, si no el de reglas (siempre al instante). */
export async function getDealBrief(dealId: string): Promise<Brief | null> {
  const f = await dealFacts(dealId);
  if (!f) return null;
  const rules = ruleBrief(f);
  const [cached] = await sql<{ basis: string; content: { resumen: string; siguiente_paso: string; riesgos: string[] }; generated_at: Date }[]>`
    SELECT basis, content, generated_at FROM deal_briefs WHERE deal_id = ${dealId}`;
  if (!cached) return rules;
  return {
    ...rules,
    resumen: cached.content.resumen || rules.resumen,
    siguiente_paso: cached.content.siguiente_paso || rules.siguiente_paso,
    riesgos: cached.content.riesgos?.length ? cached.content.riesgos.slice(0, 4) : rules.riesgos,
    source: "ai",
    generated_at: cached.generated_at,
    stale: cached.basis !== f.basis,
  };
}

/** Pide a la IA el resumen de un deal y lo guarda. Devuelve false si no hay IA o falla. */
export async function refreshDealBrief(dealId: string): Promise<boolean> {
  const f = await dealFacts(dealId);
  if (!f) return false;
  const reply = parseJsonReply<{ resumen?: string; siguiente_paso?: string; riesgos?: string[] }>(
    await generate("deal_brief", aiInput(f, ruleBrief(f))));
  if (!reply?.resumen) return false;
  const content = {
    resumen: String(reply.resumen).slice(0, 1500),
    siguiente_paso: String(reply.siguiente_paso ?? "").slice(0, 300),
    riesgos: (Array.isArray(reply.riesgos) ? reply.riesgos : []).map(String).slice(0, 4),
  };
  await sql`
    INSERT INTO deal_briefs (deal_id, basis, content) VALUES (${dealId}, ${f.basis}, ${json(content)})
    ON CONFLICT (deal_id) DO UPDATE SET basis = EXCLUDED.basis, content = EXCLUDED.content, generated_at = now()`;
  return true;
}

/**
 * Rehace con la IA los resúmenes que se han quedado atrás (los deals con
 * movimiento más reciente primero). Lo llama la revisión periódica.
 */
export async function refreshStaleBriefs(limit = 10): Promise<number> {
  if (!aiReady(await getAiSettings())) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const rows = await sql<{ id: string }[]>`
    SELECT ods.id FROM open_deals_status ods
    LEFT JOIN deal_briefs b ON b.deal_id = ods.id
    LEFT JOIN LATERAL (SELECT coalesce(max(e.id), 0) AS v FROM events e WHERE e.entity_type = 'deal' AND e.entity_id = ods.id) ev ON true
    WHERE b.deal_id IS NULL OR b.basis <> ev.v::text || ':' || ${today}
    ORDER BY ev.v DESC
    LIMIT ${limit}`;
  let n = 0;
  for (const r of rows) if (await refreshDealBrief(r.id)) n++;
  return n;
}
