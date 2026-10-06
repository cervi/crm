import { sql } from "./db";
import { generate, parseJsonReply } from "./ai";
import { activityLabel, dateTime } from "./format";
import { notify } from "./notifications";
import { param, runJob } from "./agent-jobs";
import { getHealth } from "./health";

// ===========================================================================
// Agente ejecutivo de deal: prepara cada reunión con el cliente, extrae lo
// importante de lo que se habló y mantiene «lo que sabemos» del deal.
// ===========================================================================

export type Insights = {
  needs: string[]; decision_makers: { nombre: string; cargo?: string; rol?: string }[]; budget: string | null; timeline: string | null;
  objections: string[]; competitors: string[]; updated_at: Date; source: string | null;
};

export async function getInsights(dealId: string): Promise<Insights | null> {
  const [i] = await sql<Insights[]>`
    SELECT needs, decision_makers, budget, timeline, objections, competitors, updated_at, source FROM deal_insights WHERE deal_id = ${dealId}`;
  return i ?? null;
}

const clean = (xs: unknown, max = 8) =>
  (Array.isArray(xs) ? xs : []).map((x) => String(x ?? "").trim()).filter((x) => x && x.length < 400).slice(0, max);
const merge = (a: string[], b: string[], max = 12) => {
  const seen = new Set(a.map((x) => x.toLowerCase()));
  return [...a, ...b.filter((x) => !seen.has(x.toLowerCase()))].slice(-max);
};

/** Guarda lo que sabemos del deal a mano (una línea por elemento). */
export async function saveInsights(dealId: string, data: Record<string, unknown>) {
  const lines = (k: string) => String(data[k] ?? "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 20).map((x) => x.slice(0, 300));
  const dms = lines("decision_makers").map((l) => {
    const [nombre, cargo, rol] = l.split(/\s*[—–]\s*|\s+-\s+|\s*,\s*/);
    return { nombre: nombre ?? l, ...(cargo ? { cargo } : {}), ...(rol ? { rol } : {}) };
  });
  await sql`
    INSERT INTO deal_insights (deal_id, needs, decision_makers, budget, timeline, objections, competitors, source)
    VALUES (${dealId}, ${lines("needs")}::text[], ${sql.json(dms)}, ${String(data.budget ?? "").trim().slice(0, 300) || null},
            ${String(data.timeline ?? "").trim().slice(0, 300) || null}, ${lines("objections")}::text[], ${lines("competitors")}::text[], 'Editado a mano')
    ON CONFLICT (deal_id) DO UPDATE SET needs = EXCLUDED.needs, decision_makers = EXCLUDED.decision_makers, budget = EXCLUDED.budget,
      timeline = EXCLUDED.timeline, objections = EXCLUDED.objections, competitors = EXCLUDED.competitors, source = EXCLUDED.source, updated_at = now()`;
}

// ---------------------------------------------------------------------------
// Extracción tras una reunión

export type Extraction = {
  necesidades: string[]; decisores: { nombre: string; cargo?: string; rol?: string }[]; presupuesto: string; plazo: string;
  objeciones: string[]; competidores: string[]; proximos_pasos: { tarea: string; en_dias: number }[];
  importe_estimado: number | null; fecha_cierre: string | null;
};

/**
 * Lo extraído de una reunión (se calcula una vez con la IA y queda en la
 * actividad). null si no hay notas suficientes o no hay IA.
 */
export async function extractionFor(activityId: string): Promise<Extraction | null> {
  const [a] = await sql<{ id: string; deal_id: string | null; type: string; subject: string; note: string | null; transcript: string | null;
                          extraction: Extraction | null; done_at: Date | null }[]>`
    SELECT id, deal_id, type, subject, note, transcript, extraction, done_at FROM activities WHERE id = ${activityId}`;
  if (!a?.deal_id) return null;
  if (a.extraction) return a.extraction;
  const text = [a.transcript, a.note].filter(Boolean).join("\n\n").trim();
  if (text.length < 40) return null;
  const [d] = await sql<{ title: string; value: string | null; expected_close_date: string | null }[]>`
    SELECT title, value::text, expected_close_date::text FROM deals WHERE id = ${a.deal_id}`;
  const raw = parseJsonReply<Partial<Extraction>>(await generate("call_extraction", {
    deal: d, reunion: { tipo: activityLabel(a.type), asunto: a.subject, fecha: a.done_at }, texto: text.slice(0, 60000),
  }, { maxTokens: 1200 }));
  if (!raw) return null;
  const amount = Number(raw.importe_estimado);
  const x: Extraction = {
    necesidades: clean(raw.necesidades), objeciones: clean(raw.objeciones), competidores: clean(raw.competidores, 5),
    decisores: (Array.isArray(raw.decisores) ? raw.decisores : []).filter((p) => p && typeof p.nombre === "string" && p.nombre.trim())
      .slice(0, 6).map((p) => ({ nombre: p.nombre.trim().slice(0, 120), cargo: p.cargo ? String(p.cargo).slice(0, 120) : undefined, rol: p.rol ? String(p.rol).slice(0, 40) : undefined })),
    presupuesto: String(raw.presupuesto ?? "").trim().slice(0, 300), plazo: String(raw.plazo ?? "").trim().slice(0, 300),
    proximos_pasos: (Array.isArray(raw.proximos_pasos) ? raw.proximos_pasos : []).filter((p) => p && String(p.tarea ?? "").trim())
      .slice(0, 6).map((p) => ({ tarea: String(p.tarea).trim().slice(0, 250), en_dias: Math.max(0, Math.min(90, Math.round(Number(p.en_dias) || 2))) })),
    importe_estimado: Number.isFinite(amount) && amount > 0 ? Math.round(amount) : null,
    fecha_cierre: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.fecha_cierre ?? "")) ? String(raw.fecha_cierre) : null,
  };
  await sql`UPDATE activities SET extraction = ${sql.json(x as never)} WHERE id = ${activityId}`;
  return x;
}

/** Suma lo extraído de una reunión a «lo que sabemos» del deal. */
export async function applyExtraction(dealId: string, x: Extraction, source: string) {
  const cur = await getInsights(dealId);
  const dms = [...(cur?.decision_makers ?? [])];
  for (const p of x.decisores) if (!dms.some((q) => q.nombre.toLowerCase() === p.nombre.toLowerCase())) dms.push(p);
  await sql`
    INSERT INTO deal_insights (deal_id, needs, decision_makers, budget, timeline, objections, competitors, source)
    VALUES (${dealId}, ${merge(cur?.needs ?? [], x.necesidades)}::text[], ${sql.json(dms.slice(-10))}, ${x.presupuesto || cur?.budget || null},
            ${x.plazo || cur?.timeline || null}, ${merge(cur?.objections ?? [], x.objeciones)}::text[], ${merge(cur?.competitors ?? [], x.competidores, 8)}::text[], ${source})
    ON CONFLICT (deal_id) DO UPDATE SET needs = EXCLUDED.needs, decision_makers = EXCLUDED.decision_makers, budget = EXCLUDED.budget,
      timeline = EXCLUDED.timeline, objections = EXCLUDED.objections, competitors = EXCLUDED.competitors, source = EXCLUDED.source, updated_at = now()`;
}

/** Trabajo: reuniones recién hechas con notas → extracción y «lo que sabemos». */
export async function runCallExtraction(): Promise<string | number | null> {
  return runJob("call_extraction", async () => {
    const rows = await sql<{ id: string; deal_id: string; subject: string; type: string }[]>`
      SELECT a.id, a.deal_id, a.subject, a.type FROM activities a
      JOIN deals d ON d.id = a.deal_id AND d.deleted_at IS NULL
      WHERE a.done AND a.done_at > now() - interval '7 days' AND coalesce(a.outcome, 'held') = 'held'
        AND a.type IN (SELECT key FROM activity_types WHERE is_session)
        AND length(coalesce(a.transcript, '') || coalesce(a.note, '')) >= 40
        AND NOT EXISTS (SELECT 1 FROM deal_insights i WHERE i.deal_id = a.deal_id AND i.source = 'reunion:' || a.id::text)
      ORDER BY a.done_at LIMIT 10`;
    let n = 0;
    for (const a of rows) {
      const x = await extractionFor(a.id);
      if (!x) continue;
      await applyExtraction(a.deal_id, x, `reunion:${a.id}`);
      n++;
    }
    return n;
  });
}

// ---------------------------------------------------------------------------
// Preparación de reuniones

type PrepFacts = {
  activity_id: string; deal_id: string; subject: string; type: string; due_at: Date; owner_id: string | null; title: string;
  stage: string; organization: string | null; value: string | null;
};

/** Ficha de preparación de una reunión (con IA si está configurada; si no, con los datos del CRM). */
export async function buildPrep(f: PrepFacts): Promise<string> {
  const [people, notes, emails, last, insights, health] = await Promise.all([
    sql<{ full_name: string; job_title: string | null; role: string | null }[]>`
      SELECT p.full_name, po.job_title, dp.role FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
      LEFT JOIN LATERAL (SELECT job_title FROM person_organizations WHERE person_id = p.id AND status = 'current' LIMIT 1) po ON true
      WHERE dp.deal_id = ${f.deal_id} ORDER BY dp.is_primary DESC LIMIT 8`,
    sql<{ content: string; created_at: Date }[]>`SELECT content, created_at FROM notes WHERE deal_id = ${f.deal_id} ORDER BY created_at DESC LIMIT 4`,
    sql<{ direction: string; subject: string; at: Date }[]>`
      SELECT direction, subject, coalesce(sent_at, created_at) AS at FROM emails WHERE deal_id = ${f.deal_id} AND status = 'sent' OR (deal_id = ${f.deal_id} AND direction = 'in')
      ORDER BY coalesce(sent_at, created_at) DESC LIMIT 5`,
    sql<{ subject: string; summary: string | null; note: string | null; done_at: Date }[]>`
      SELECT subject, summary, note, done_at FROM activities WHERE deal_id = ${f.deal_id} AND done AND type IN (SELECT key FROM activity_types WHERE is_session)
      ORDER BY done_at DESC LIMIT 1`,
    getInsights(f.deal_id), getHealth(f.deal_id),
  ]);
  const attendees = people.map((p) => [p.full_name, p.job_title, p.role].filter(Boolean).join(", "));
  const facts = {
    reunion: { tipo: activityLabel(f.type), asunto: f.subject, cuando: f.due_at },
    deal: { titulo: f.title, empresa: f.organization, fase: f.stage, importe: f.value },
    asistentes: attendees,
    ultima_reunion: last[0] ? { asunto: last[0].subject, resumen: last[0].summary ?? last[0].note?.slice(0, 800) } : null,
    notas_recientes: notes.map((n) => n.content.slice(0, 500)),
    correos_recientes: emails.map((e) => `${e.direction === "in" ? "Recibido" : "Enviado"}: ${e.subject}`),
    lo_que_sabemos: insights,
    senales: health?.signals.slice(0, 6).map((s) => `${s.tone === "risk" ? "Riesgo" : "A favor"}: ${s.label}`) ?? [],
  };
  const ai = parseJsonReply<{ objetivo?: string; contexto?: string; preguntas?: string[]; cuidado?: string[] }>(
    await generate("meeting_prep", facts, { maxTokens: 700 }));
  const lines: string[] = [];
  const bullet = (xs: string[]) => xs.map((x) => `- ${x}`);
  if (ai?.objetivo || ai?.contexto) {
    if (ai.objetivo) lines.push(`Objetivo: ${ai.objetivo}`);
    if (ai.contexto) lines.push("", ai.contexto);
  } else {
    lines.push(`Objetivo: avanzar «${f.title}» desde «${f.stage}» y dejar fijado el siguiente paso con fecha.`);
    if (last[0]) lines.push("", `Última reunión (${dateTime(last[0].done_at)}): ${last[0].subject}${last[0].summary ? ` — ${last[0].summary.slice(0, 300)}` : ""}`);
  }
  if (attendees.length) lines.push("", "Quién viene:", ...bullet(attendees));
  if (insights) {
    const known = [
      insights.needs.length ? `Necesidades: ${insights.needs.join("; ")}` : null,
      insights.budget ? `Presupuesto: ${insights.budget}` : null,
      insights.timeline ? `Plazos: ${insights.timeline}` : null,
      insights.decision_makers.length ? `Decisores: ${insights.decision_makers.map((d) => d.nombre).join(", ")}` : null,
    ].filter(Boolean) as string[];
    if (known.length) lines.push("", "Lo que sabemos:", ...bullet(known));
  }
  const questions = ai?.preguntas?.length ? clean(ai.preguntas, 5) : [
    !insights?.budget ? "¿Qué presupuesto tenéis previsto?" : null,
    !insights?.timeline ? "¿Para cuándo necesitáis tenerlo en marcha?" : null,
    !insights?.decision_makers.length ? "¿Quién más participa en la decisión y quién firma?" : null,
    "¿Qué tendría que pasar para seguir adelante?",
  ].filter(Boolean) as string[];
  lines.push("", "Preguntas:", ...bullet(questions));
  const careful = ai?.cuidado?.length ? clean(ai.cuidado, 3)
    : [...(insights?.objections ?? []).slice(0, 2), ...(health?.signals.filter((s) => s.tone === "risk").slice(0, 2).map((s) => s.label) ?? [])];
  if (careful.length) lines.push("", "Cuidado con:", ...bullet(careful));
  return lines.join("\n").slice(0, 5000) + (ai ? "\n\n(Preparado por la IA)" : "");
}

/** Trabajo: prepara las reuniones de las próximas horas y avisa poco antes. */
export async function runMeetingPrep(): Promise<string | number | null> {
  return runJob("meeting_prep", async (p) => {
    const hours = param(p, "hours_ahead", 36), minutes = param(p, "notify_minutes", 60);
    const due = await sql<PrepFacts[]>`
      SELECT a.id AS activity_id, a.deal_id, a.subject, a.type, a.due_at, coalesce(a.owner_id, d.owner_id) AS owner_id, d.title, s.name AS stage,
             o.name AS organization, d.value::text
      FROM activities a JOIN deals d ON d.id = a.deal_id AND d.status = 'open' AND d.deleted_at IS NULL
      JOIN stages s ON s.id = d.stage_id LEFT JOIN organizations o ON o.id = d.organization_id
      WHERE NOT a.done AND a.due_at > now() AND a.due_at < now() + make_interval(hours => ${hours})
        AND a.type IN (SELECT key FROM activity_types WHERE is_session)
        AND (a.prep IS NULL OR a.prep_at < now() - interval '20 hours')
      ORDER BY a.due_at LIMIT 20`;
    for (const f of due) {
      const prep = await buildPrep(f);
      await sql`UPDATE activities SET prep = ${prep}, prep_at = now() WHERE id = ${f.activity_id}`;
    }
    // Aviso poco antes de la reunión, con la ficha.
    const soon = await sql<{ id: string; deal_id: string; subject: string; due_at: Date; owner_id: string | null; title: string }[]>`
      SELECT a.id, a.deal_id, a.subject, a.due_at, coalesce(a.owner_id, d.owner_id) AS owner_id, d.title
      FROM activities a JOIN deals d ON d.id = a.deal_id
      WHERE NOT a.done AND a.prep IS NOT NULL AND a.prep_notified_at IS NULL
        AND a.due_at > now() AND a.due_at <= now() + make_interval(mins => ${minutes})`;
    for (const a of soon) {
      await sql`UPDATE activities SET prep_notified_at = now() WHERE id = ${a.id}`;
      if (!a.owner_id) continue;
      const mins = Math.max(1, Math.round((new Date(a.due_at).getTime() - Date.now()) / 60000));
      await notify(sql, { userId: a.owner_id, kind: "meeting_prep", title: `En ${mins} min: «${a.subject}» — tienes la ficha preparada`,
                          body: a.title, link: `/deals/${a.deal_id}#act-${a.id}` });
    }
    return due.length;
  });
}
