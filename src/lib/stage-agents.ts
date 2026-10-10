import { sql, json } from "./db";
import { UserError } from "./errors";
import { aiReady, generate, getAiSettings, parseJsonReply } from "./ai";
import { activityTypes } from "./activity-types";
import { activityLabel, money } from "./format";
import { dealFacts } from "./briefs";
import { getInsights } from "./deal-agent";
import { bookingLinkFor } from "./booking";
import type { Actor } from "./events";
import type { CustomAction, CustomTrigger, Rule, RuleFilter } from "./automations";

// ===========================================================================
// Agentes por fase: instrucciones en lenguaje natural para lo que la IA hace
// con los deals de cada fase del funnel (o de todo un pipeline, o de todos).
//
//   «Cuando entre en Demo agendada, escríbele para agendar con mis huecos»
//   «Muévelo a Propuesta si ya han confirmado presupuesto y fecha»
//   «Si lleva 5 días sin responder, crea una llamada de seguimiento»
//
// La IA convierte cada instrucción en una o varias reglas (cuándo → si →
// qué hace) que se enseñan antes de activarlas. Las condiciones en lenguaje
// natural las evalúa la IA en cada deal, y lo hecho pasa por el motor de
// siempre: autonomía (preguntar / sola), permisos, registro y deshacer.
// ===========================================================================

export type Autonomy = "off" | "ask" | "auto";
export type CompiledRule = { name: string; trigger: CustomTrigger; condition: string | null; action: CustomAction; description?: string };
export type Plan = { summary: string; doubts: string[]; rules: CompiledRule[]; by: "ai" | "rules" };
export type Scope = { pipelineId: string | null; stageId: string | null };

export type Instruction = {
  id: string; pipeline_id: string | null; stage_id: string | null; text: string; autonomy: Autonomy; summary: string | null;
  doubts: string[]; compiled_by: "ai" | "rules"; created_at: Date; author: string | null; stage_name: string | null; pipeline_name: string | null;
  rules: { id: string; name: string; description: string; condition: string | null; action_kind: string }[];
  stats: { pending: number; done: number; last_at: Date | null };
};

// ---------------------------------------------------------------------------
// Contexto para entender la instrucción

type StageRow = { id: string; name: string; pipeline_id: string; pipeline: string; position: number };

async function scopeContext(scope: Scope) {
  const stages = await sql<StageRow[]>`
    SELECT s.id, s.name, s.pipeline_id, p.name AS pipeline, s.position FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.is_active AND (${scope.pipelineId}::uuid IS NULL OR s.pipeline_id = ${scope.pipelineId}::uuid)
    ORDER BY p.position, p.name, s.position`;
  const types = (await activityTypes(true)).map((t) => ({ key: t.key, label: t.label }));
  const users = await sql<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE is_active AND kind = 'human' ORDER BY name`;
  return { stages, types, users };
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[«»"'.]/g, "").trim();

function findStage(stages: StageRow[], ref: unknown, pipelineId: string | null): StageRow | null {
  if (typeof ref !== "string" || !ref.trim()) return null;
  const pool = pipelineId ? stages.filter((s) => s.pipeline_id === pipelineId) : stages;
  return pool.find((s) => s.id === ref) ?? pool.find((s) => norm(s.name) === norm(ref))
    ?? pool.find((s) => norm(s.name).includes(norm(ref)) || norm(ref).includes(norm(s.name))) ?? null;
}

// ---------------------------------------------------------------------------
// De lo que devuelve la IA (o las reglas) a reglas válidas

type RawRule = {
  nombre?: string;
  cuando?: { tipo?: string; fase?: string; dias?: number; tipo_actividad?: string; resultado?: string; incluir_existentes?: boolean };
  si?: string | null;
  accion?: { tipo?: string; fase_destino?: string; asunto?: string; instrucciones_correo?: string; usar_calendario?: boolean; texto?: string;
             tipo_actividad?: string; dias?: number; responsable?: string };
};

const TRIGGER_KINDS: Record<string, CustomTrigger["kind"]> = {
  entra_en_fase: "deal_stage", lleva_dias_en_fase: "deal_stage", novedades: "stage_review", novedades_en_fase: "stage_review",
  sin_movimiento: "deal_idle", responde: "email_received", abre_correo: "email_opened", reserva: "booked",
  actividad_hecha: "activity_done", actividad_vencida: "activity_overdue", propuesta_vista: "proposal_viewed",
  propuesta_aceptada: "proposal_accepted", deal_creado: "deal_created", ganado: "deal_won", perdido: "deal_lost",
};

function toRule(raw: RawRule, scope: Scope, ctx: Awaited<ReturnType<typeof scopeContext>>): CompiledRule {
  const c = raw.cuando ?? {};
  const a = raw.accion ?? {};
  const kind = TRIGGER_KINDS[String(c.tipo ?? "")] ?? (scope.stageId ? "deal_stage" : null);
  if (!kind) throw new UserError(`No entiendo cuándo debe actuar («${c.tipo ?? "?"}»).`);
  const daysN = Math.max(0, Math.min(365, Math.round(Number(c.dias) || 0)));
  const scopeStage = scope.stageId;
  const named = findStage(ctx.stages, c.fase, scope.pipelineId);
  const stageId = named?.id ?? scopeStage;
  const filter: RuleFilter = {
    ...(scope.pipelineId ? { pipeline_id: scope.pipelineId } : {}),
    ...(stageId && kind !== "deal_stage" ? { stage_id: stageId } : {}),
  };
  const condition = typeof raw.si === "string" && raw.si.trim() ? raw.si.trim().slice(0, 600) : null;
  let trigger: CustomTrigger;
  switch (kind) {
    case "deal_stage":
      if (!stageId) throw new UserError("Dime en qué fase (o crea la instrucción desde la columna de la fase).");
      trigger = { kind, stage_id: stageId, days: c.tipo === "lleva_dias_en_fase" ? Math.max(1, daysN) : daysN, include_existing: Boolean(c.incluir_existentes), filter };
      break;
    case "stage_review":
      if (!condition) throw new UserError("Para revisar los deals cada vez que haya novedades, dime qué condición deben cumplir.");
      trigger = { kind, filter };
      break;
    case "deal_idle": trigger = { kind, days: Math.max(1, daysN || 7), filter }; break;
    case "deal_created": trigger = { kind, days: daysN, filter }; break;
    case "activity_done": {
      const t = ctx.types.find((x) => x.key === c.tipo_actividad || norm(x.label) === norm(String(c.tipo_actividad ?? "")));
      const outcome = (["held", "no_show", "rescheduled", "cancelled"] as const).find((o) => o === c.resultado) ?? "any";
      trigger = { kind, activity_type: t?.key ?? null, outcome, filter };
      break;
    }
    case "activity_overdue": {
      const t = ctx.types.find((x) => x.key === c.tipo_actividad || norm(x.label) === norm(String(c.tipo_actividad ?? "")));
      trigger = { kind, activity_type: t?.key ?? null, days: daysN, filter };
      break;
    }
    default: trigger = { kind, filter } as CustomTrigger;
  }

  let action: CustomAction;
  switch (a.tipo) {
    case "correo": {
      const prompt = (a.instrucciones_correo || a.texto || "").trim();
      action = { kind: "draft_email", subject: (a.asunto || "Seguimiento").slice(0, 300), body: "",
                 ai_prompt: (prompt || "Escribe un correo breve de seguimiento acorde a la fase del deal.").slice(0, 1500), use_slots: Boolean(a.usar_calendario) };
      break;
    }
    case "mover": {
      const st = findStage(ctx.stages, a.fase_destino, scope.pipelineId);
      if (!st) throw new UserError(`No encuentro la fase «${a.fase_destino ?? "?"}» a la que moverlo.`);
      action = { kind: "move_stage", stage_id: st.id };
      break;
    }
    case "tarea": {
      const t = ctx.types.find((x) => x.key === a.tipo_actividad || norm(x.label) === norm(String(a.tipo_actividad ?? ""))) ?? ctx.types.find((x) => x.key === "task") ?? ctx.types[0];
      action = { kind: "create_activity", activity_type: t.key, subject: (a.texto || a.asunto || "Seguimiento").slice(0, 300),
                 due_in_days: Math.max(0, Math.min(90, Math.round(Number(a.dias) || 0))), note: null };
      break;
    }
    case "nota": action = { kind: "add_note", content: (a.texto || "Revisar este deal.").slice(0, 2000) }; break;
    case "avisar": action = { kind: "notify", message: (a.texto || "Revisa este deal.").slice(0, 300) }; break;
    case "asignar": {
      const u = ctx.users.find((x) => norm(x.name) === norm(String(a.responsable ?? ""))) ?? ctx.users.find((x) => norm(x.name).includes(norm(String(a.responsable ?? "")).split(" ")[0] || "@@"));
      if (!u) throw new UserError(`No encuentro a «${a.responsable ?? "?"}» en el equipo.`);
      action = { kind: "assign_owner", owner_id: u.id };
      break;
    }
    default: throw new UserError(`No entiendo qué tiene que hacer («${a.tipo ?? "?"}»).`);
  }
  if (action.kind === "move_stage" && kind === "deal_stage" && (trigger as { stage_id: string }).stage_id === action.stage_id) {
    throw new UserError("Moverlo a la misma fase en la que entra no tiene sentido.");
  }
  const name = (raw.nombre || "").trim().slice(0, 120) || defaultName(action);
  return { name, trigger, condition, action };
}

const defaultName = (a: CustomAction) => a.kind === "draft_email" ? "Escribir al contacto" : a.kind === "move_stage" ? "Mover de fase"
  : a.kind === "create_activity" ? "Crear actividad" : a.kind === "add_note" ? "Dejar nota" : a.kind === "notify" ? "Avisarte" : "Asignar responsable";

// ---------------------------------------------------------------------------
// Interpretar una instrucción

/** Lo que entiende la IA (o, sin IA, unas reglas sencillas) de una instrucción. */
export async function interpretInstruction(text: string, scope: Scope): Promise<Plan> {
  const t = text.trim();
  if (t.length < 3) throw new UserError("Escribe qué quieres que haga.");
  if (t.length > 2000) throw new UserError("La instrucción es demasiado larga (máximo 2000 caracteres).");
  const ctx = await scopeContext(scope);
  const here = scope.stageId ? ctx.stages.find((s) => s.id === scope.stageId) : null;
  const ai = aiReady(await getAiSettings());
  if (ai) {
    const reply = await generate("compile_instruction", {
      instruccion: t,
      ambito: here ? { tipo: "fase", fase: here.name, pipeline: here.pipeline } : scope.pipelineId ? { tipo: "pipeline", pipeline: ctx.stages[0]?.pipeline ?? "" } : { tipo: "todos los pipelines" },
      fases: ctx.stages.map((s) => ({ fase: s.name, pipeline: s.pipeline, orden: s.position })),
      tipos_de_actividad: ctx.types.map((x) => x.label),
      equipo: ctx.users.map((u) => u.name),
    }, { maxTokens: 1500 });
    const j = parseJsonReply<{ resumen?: string; dudas?: string[]; reglas?: RawRule[] }>(reply);
    if (j?.reglas?.length) {
      const rules = j.reglas.slice(0, 5).map((r) => toRule(r, scope, ctx));
      return { summary: (j.resumen ?? "").slice(0, 600), doubts: (j.dudas ?? []).map(String).slice(0, 5), rules, by: "ai" };
    }
    if (j && j.reglas && j.reglas.length === 0) throw new UserError(j.dudas?.[0] ?? "No he sabido convertir eso en algo que la IA pueda hacer. Prueba a decir cuándo y qué tiene que hacer.");
  }
  // Sin IA (o si no responde): lo más habitual, con reglas.
  const rules = heuristic(t, scope, ctx);
  if (!rules.length) {
    throw new UserError(ai ? "La IA no ha respondido. Prueba otra vez en un momento."
      : "Sin IA configurada solo entiendo instrucciones sencillas (escribir para agendar, mover a una fase, crear una tarea…). Configura la IA en Ajustes → IA para todo lo demás.");
  }
  return { summary: "Interpretado con reglas (sin IA).", doubts: [], rules, by: "rules" };
}

/** Instrucciones sencillas sin IA. */
function heuristic(t: string, scope: Scope, ctx: Awaited<ReturnType<typeof scopeContext>>): CompiledRule[] {
  const n = norm(t);
  const raw: RawRule = { cuando: {}, accion: {} };
  const dias = /(\d+)\s*dias?/.exec(n);
  if (/sin (respuesta|responder|movimiento|actividad|contestar)|no responde|no contesta/.test(n)) raw.cuando = { tipo: "sin_movimiento", dias: dias ? Number(dias[1]) : 5 };
  else if (/(responde|contesta)/.test(n)) raw.cuando = { tipo: "responde" };
  else if (/reserva|agenda una reunion/.test(n) && !/para agendar/.test(n)) raw.cuando = { tipo: "reserva" };
  else if (dias && /lleva/.test(n)) raw.cuando = { tipo: "lleva_dias_en_fase", dias: Number(dias[1]) };
  else raw.cuando = { tipo: "entra_en_fase" };
  const move = /(mueve|muevelo|pasa|pasalo|llevalo)\s+(?:el deal\s+)?(?:a|al|a la)\s+(?:fase\s+)?([^,;]+?)(?:\s+(?:si|cuando)\b|[,;]|$)/.exec(n);
  if (move) raw.accion = { tipo: "mover", fase_destino: move[2] };
  else if (/(correo|mail|email|escrib)/.test(n)) raw.accion = { tipo: "correo", instrucciones_correo: t, usar_calendario: /(agend|calendario|hueco|reunion|demo|llamada)/.test(n), asunto: /(agend|reunion|demo)/.test(n) ? "¿Buscamos un hueco?" : "Seguimiento" };
  else if (/(llama|llamada|tarea|recuerda)/.test(n)) raw.accion = { tipo: "tarea", tipo_actividad: /llama/.test(n) ? "call" : "task", texto: t.slice(0, 120), dias: 0 };
  else if (/(avisa|avisame|notifica)/.test(n)) raw.accion = { tipo: "avisar", texto: t.slice(0, 200) };
  else return [];
  const cond = /\bsi\s+(.+)$/.exec(t);
  if (cond && raw.accion.tipo === "mover") return []; // mover «si…» necesita a la IA para entender la condición
  try { return [toRule(raw, scope, ctx)]; } catch { return []; }
}

// ---------------------------------------------------------------------------
// Guardar, listar, cambiar

const DESCRIBE = async (r: CompiledRule) => {
  const { describeCustomRule } = await import("./automations");
  return describeCustomRule(r.trigger, r.action, r.condition);
};

/** Describe cada regla del plan (para enseñarlo antes de activarlo). */
export async function describePlan(plan: Plan): Promise<Plan> {
  return { ...plan, rules: await Promise.all(plan.rules.map(async (r) => ({ ...r, description: await DESCRIBE(r) }))) };
}

export async function createInstruction(actor: Actor, scope: Scope, text: string, autonomy: Autonomy): Promise<string> {
  await assertScope(scope);
  const plan = await interpretInstruction(text, scope);
  const a: Autonomy = (["off", "ask", "auto"] as const).includes(autonomy) ? autonomy : "ask";
  return sql.begin(async (tx) => {
    const [ins] = await tx<{ id: string }[]>`
      INSERT INTO stage_instructions (pipeline_id, stage_id, text, autonomy, summary, doubts, compiled_by, created_by)
      VALUES (${scope.pipelineId}, ${scope.stageId}, ${text.trim()}, ${a}, ${plan.summary || null}, ${plan.doubts}, ${plan.by}, ${actor.id})
      RETURNING id`;
    let i = 0;
    for (const r of plan.rules) {
      await tx`
        INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position, is_custom, trigger, action, instruction_id, condition, agent)
        VALUES (${`fase_${ins.id.slice(0, 8)}_${i++}_${Date.now().toString(36)}`}, ${r.name}, ${await DESCRIBE(r)}, ${a}, ARRAY['off', 'ask', 'auto'], '{}'::jsonb,
                (SELECT coalesce(max(position), 0) + 1 FROM automation_rules), true, ${json(r.trigger)}, ${json(r.action)}, ${ins.id}, ${r.condition}, 'ejecutivo')`;
    }
    return ins.id;
  });
}

async function assertScope(scope: Scope) {
  if (scope.stageId) {
    const [s] = await sql`SELECT 1 FROM stages WHERE id = ${scope.stageId} AND pipeline_id = ${scope.pipelineId}`;
    if (!s) throw new UserError("Esa fase no es de ese pipeline.");
  } else if (scope.pipelineId) {
    const [p] = await sql`SELECT 1 FROM pipelines WHERE id = ${scope.pipelineId}`;
    if (!p) throw new UserError("El pipeline no existe.");
  }
}

export async function setInstructionAutonomy(id: string, autonomy: Autonomy) {
  if (!(["off", "ask", "auto"] as const).includes(autonomy)) throw new UserError("Autonomía no válida.");
  await sql`UPDATE stage_instructions SET autonomy = ${autonomy}, updated_at = now() WHERE id = ${id}`;
  await sql`UPDATE automation_rules SET autonomy = ${autonomy} WHERE instruction_id = ${id}`;
  if (autonomy === "off") {
    await sql`UPDATE automation_actions SET status = 'expired', decided_at = now()
              WHERE status = 'pending' AND rule_id IN (SELECT id FROM automation_rules WHERE instruction_id = ${id})`;
  }
}

export async function deleteInstruction(id: string) {
  await sql.begin(async (tx) => {
    await tx`UPDATE automation_actions SET status = 'expired', decided_at = now()
             WHERE status = 'pending' AND rule_id IN (SELECT id FROM automation_rules WHERE instruction_id = ${id})`;
    await tx`UPDATE automation_actions SET rule_id = NULL WHERE rule_id IN (SELECT id FROM automation_rules WHERE instruction_id = ${id})`;
    await tx`DELETE FROM stage_instructions WHERE id = ${id}`;
  });
}

/** Reescribir una instrucción: se vuelve a interpretar y sustituye sus reglas. */
export async function updateInstruction(actor: Actor, id: string, text: string) {
  const [old] = await sql<{ pipeline_id: string | null; stage_id: string | null; autonomy: Autonomy }[]>`
    SELECT pipeline_id, stage_id, autonomy FROM stage_instructions WHERE id = ${id}`;
  if (!old) throw new UserError("La instrucción ya no existe.");
  const scope = { pipelineId: old.pipeline_id, stageId: old.stage_id };
  await interpretInstruction(text, scope); // falla aquí si no se entiende, sin tocar la anterior
  await deleteInstruction(id);
  return createInstruction(actor, scope, text, old.autonomy);
}

export async function listInstructions(filter: { pipelineId?: string | null; stageId?: string; all?: boolean } = {}): Promise<Instruction[]> {
  const rows = await sql<Omit<Instruction, "rules" | "stats">[]>`
    SELECT i.id, i.pipeline_id, i.stage_id, i.text, i.autonomy, i.summary, i.doubts, i.compiled_by, i.created_at,
           u.name AS author, s.name AS stage_name, p.name AS pipeline_name
    FROM stage_instructions i LEFT JOIN users u ON u.id = i.created_by LEFT JOIN stages s ON s.id = i.stage_id
    LEFT JOIN pipelines p ON p.id = i.pipeline_id
    WHERE ${filter.all ? sql`true`
      : filter.stageId ? sql`(i.stage_id = ${filter.stageId} OR (i.stage_id IS NULL AND (i.pipeline_id IS NULL OR i.pipeline_id = (SELECT pipeline_id FROM stages WHERE id = ${filter.stageId}))))`
      : filter.pipelineId ? sql`(i.pipeline_id = ${filter.pipelineId} OR i.pipeline_id IS NULL)` : sql`i.pipeline_id IS NULL`}
    ORDER BY i.created_at`;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const rules = await sql<{ id: string; instruction_id: string; name: string; description: string; condition: string | null; action_kind: string }[]>`
    SELECT id, instruction_id, name, description, condition, action->>'kind' AS action_kind FROM automation_rules
    WHERE instruction_id = ANY(${ids}::uuid[]) ORDER BY position`;
  const stats = await sql<{ instruction_id: string; pending: number; done: number; last_at: Date | null }[]>`
    SELECT r.instruction_id, count(*) FILTER (WHERE x.status = 'pending')::int AS pending,
           count(*) FILTER (WHERE x.status = 'done')::int AS done, max(x.created_at) AS last_at
    FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
    WHERE r.instruction_id = ANY(${ids}::uuid[]) GROUP BY r.instruction_id`;
  return rows.map((r) => ({
    ...r,
    rules: rules.filter((x) => x.instruction_id === r.id).map(({ instruction_id: _, ...x }) => x),
    stats: stats.find((x) => x.instruction_id === r.id) ?? { pending: 0, done: 0, last_at: null },
  }));
}

/** Cuántas instrucciones activas hay por fase de un pipeline (para el tablero). */
export async function instructionCounts(pipelineId: string): Promise<{ byStage: Record<string, number>; pipeline: number }> {
  const rows = await sql<{ stage_id: string | null; n: number }[]>`
    SELECT stage_id, count(*)::int AS n FROM stage_instructions
    WHERE autonomy <> 'off' AND (pipeline_id = ${pipelineId} OR pipeline_id IS NULL) GROUP BY stage_id`;
  return { byStage: Object.fromEntries(rows.filter((r) => r.stage_id).map((r) => [r.stage_id!, r.n])), pipeline: rows.filter((r) => !r.stage_id).reduce((a, r) => a + r.n, 0) };
}

// ---------------------------------------------------------------------------
// Condiciones y correos (los usa el motor)

async function conditionFacts(dealId: string) {
  const [f, insights, emails] = await Promise.all([
    dealFacts(dealId), getInsights(dealId),
    sql<{ direction: string; subject: string; body: string; at: Date }[]>`
      SELECT direction, subject, left(body, 500) AS body, coalesce(sent_at, created_at) AS at FROM emails
      WHERE deal_id = ${dealId} AND status = 'sent' ORDER BY coalesce(sent_at, created_at) DESC LIMIT 6`,
  ]);
  if (!f) return null;
  const s = f.signals;
  return {
    deal: { titulo: s.title, empresa: s.organization_name, importe: money(s.value, s.currency), fase: s.stage_name, dias_en_fase: s.days_in_stage,
            cierre_previsto: s.expected_close_date, responsable: s.owner_name, sesion_agendada: s.has_upcoming_session,
            proxima_actividad: s.next_subject ? { asunto: s.next_subject, fecha: s.next_at } : null },
    contactos: f.contacts.map((c) => ({ nombre: c.full_name, rol: c.role, cargo: c.job_title })),
    historial: f.history.map((h) => ({ fecha: new Date(h.at).toISOString().slice(0, 10), tipo: h.kind === "note" ? "nota" : activityLabel(h.kind), asunto: h.subject, resultado: h.outcome, texto: h.text })),
    correos: emails.map((m) => ({ fecha: new Date(m.at).toISOString().slice(0, 10), de: m.direction === "in" ? "cliente" : "nosotros", asunto: m.subject, texto: m.body })),
    lo_que_sabemos: insights ? { necesidades: insights.needs, presupuesto: insights.budget, plazos: insights.timeline, objeciones: insights.objections, decisores: insights.decision_makers } : null,
  };
}

/** ¿Cumple el deal la condición de la regla? (lo decide la IA; se guarda por deal y situación). Sin IA: no se actúa. */
export async function checkCondition(rule: Pick<Rule, "id" | "condition">, dealId: string, key: string): Promise<{ ok: boolean; reason: string } | null> {
  if (!rule.condition) return { ok: true, reason: "" };
  const [cached] = await sql<{ result: boolean; reason: string | null }[]>`
    SELECT result, reason FROM ai_condition_checks WHERE rule_id = ${rule.id} AND deal_id = ${dealId} AND key = ${key}`;
  if (cached) return { ok: cached.result, reason: cached.reason ?? "" };
  const facts = await conditionFacts(dealId);
  if (!facts) return null;
  const reply = await generate("check_condition", { condicion: rule.condition, datos: facts }, { maxTokens: 300 });
  const j = parseJsonReply<{ cumple?: boolean; motivo?: string }>(reply);
  if (!j || typeof j.cumple !== "boolean") return null; // sin IA o sin respuesta: se vuelve a intentar en la próxima revisión
  const reason = `${j.cumple ? "Se cumple" : "No se cumple"} «${rule.condition}»: ${(j.motivo ?? "").slice(0, 300)}`;
  await sql`INSERT INTO ai_condition_checks (rule_id, deal_id, key, result, reason) VALUES (${rule.id}, ${dealId}, ${key}, ${j.cumple}, ${reason})
            ON CONFLICT (rule_id, deal_id, key) DO UPDATE SET result = EXCLUDED.result, reason = EXCLUDED.reason, checked_at = now()`;
  return { ok: j.cumple, reason };
}

/** Correo que redacta la IA para un deal siguiendo la instrucción (con huecos y enlace de reserva si se pidió). */
export async function writeAgentEmail(o: { dealId: string; prompt: string; contact: string | null; slots: string | null; fallbackSubject: string;
                                           personId: string | null; ownerId: string | null }): Promise<{ subject: string; body: string }> {
  const link = o.slots !== null ? await bookingLinkFor(o.ownerId, o.dealId, o.personId).catch(() => null) : null;
  const facts = await conditionFacts(o.dealId);
  const first = (o.contact ?? "").trim().split(/\s+/)[0] || "";
  const reply = await generate("write_email", {
    accion: "escribir", formato: "text", instrucciones: o.prompt,
    contexto_del_deal: facts, destinatario: o.contact,
    huecos_libres_de_mi_calendario: o.slots, enlace_para_reservar: link,
    reglas: "Escribe el correo ya personalizado (sin variables {{…}}). Si hay huecos, ofrécelos tal cual; si hay enlace, inclúyelo. Firma con el nombre del responsable.",
  }, { maxTokens: 900 });
  const j = parseJsonReply<{ asunto?: string; texto?: string }>(reply);
  if (j?.texto) return { subject: (j.asunto || o.fallbackSubject).slice(0, 300), body: j.texto.replace(/\{\{[^}]*\}\}/g, "").trim() };
  const owner = facts?.deal.responsable ?? "";
  return {
    subject: o.fallbackSubject,
    body: [`Hola${first ? ` ${first}` : ""},`, "", o.slots ? "¿Te encaja que lo hablemos? Estos son mis próximos huecos:" : "¿Cómo lo ves? Quedo atento.",
           ...(o.slots ? ["", o.slots] : []), ...(link ? ["", `O elige el que mejor te venga aquí: ${link}`] : []), "", "Un saludo,", owner].join("\n"),
  };
}

// ---------------------------------------------------------------------------
// Probar con un deal (sin hacer nada)

export type DryRun = { rule: string; applies: boolean; detail: string };

export async function testInstruction(instructionId: string, dealId: string): Promise<DryRun[]> {
  const rules = await sql<(Pick<Rule, "id" | "name" | "condition" | "trigger" | "action"> & { description: string })[]>`
    SELECT id, name, condition, trigger, action, description FROM automation_rules WHERE instruction_id = ${instructionId} ORDER BY position`;
  const [d] = await sql<{ stage_id: string; pipeline_id: string; stage_name: string }[]>`
    SELECT d.stage_id, d.pipeline_id, s.name AS stage_name FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ${dealId}`;
  if (!d) throw new UserError("Ese deal no existe.");
  const out: DryRun[] = [];
  for (const r of rules) {
    const f = r.trigger?.filter ?? {};
    const stage = r.trigger?.kind === "deal_stage" ? r.trigger.stage_id : f.stage_id;
    if ((f.pipeline_id && f.pipeline_id !== d.pipeline_id) || (stage && stage !== d.stage_id)) {
      out.push({ rule: r.name, applies: false, detail: `No aplica: el deal está en «${d.stage_name}».` });
      continue;
    }
    if (r.condition) {
      const facts = await conditionFacts(dealId);
      const reply = await generate("check_condition", { condicion: r.condition, datos: facts }, { maxTokens: 300 });
      const j = parseJsonReply<{ cumple?: boolean; motivo?: string }>(reply);
      if (!j || typeof j.cumple !== "boolean") { out.push({ rule: r.name, applies: false, detail: "Hace falta la IA para comprobar la condición." }); continue; }
      if (!j.cumple) { out.push({ rule: r.name, applies: false, detail: `No se cumple la condición: ${j.motivo ?? ""}` }); continue; }
      out.push({ rule: r.name, applies: true, detail: `Se cumple la condición (${j.motivo ?? ""}). Haría: ${r.description.replace(/^.*?,\s*/, "")}` });
      continue;
    }
    out.push({ rule: r.name, applies: true, detail: `Le aplica. ${r.description}` });
  }
  return out;
}
