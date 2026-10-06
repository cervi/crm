import { z } from "zod";
import type postgres from "postgres";
import { sql, json } from "./db";
import { AI_ACTOR, UI_ACTOR, recordEvent, type Actor } from "./events";
import { completeActivity, createActivity } from "./activities";
import { createNote } from "./notes";
import { moveDealToStage } from "./deals";
import { UserError } from "./errors";
import { activityLabel, money } from "./format";
import { optText, optional, parse } from "./validation";
import { hasActiveMailbox, sendEmail, senderFor, slotsText, syncAllMailboxes } from "./mailbox";
import { generate, parseJsonReply } from "./ai";
import { refreshStaleBriefs } from "./briefs";
import { zonedToUtc } from "./slots";
import { sendDueDigests } from "./digest";

// ===========================================================================
// Motor de automatizaciones
//
// Cada regla detecta situaciones («deal parado», «no se presentó», «deal
// ganado»…) y propone una acción. Lo que pasa después depende de la autonomía:
//
//   off   no hace nada
//   ask   deja la propuesta en la bandeja de decisiones
//   auto  la ejecuta y queda en el registro, con opción de deshacer
//
// La autonomía efectiva es la menor entre la de la regla y el permiso del
// agente para ese tipo de acción (ai_permissions): el permiso es el techo.
// ===========================================================================

export type Autonomy = "off" | "ask" | "auto";
export type AgentKind = "assistant" | "external";
export type ExecutableAction = "create_task" | "add_note" | "draft_email" | "move_stage" | "update_deal";
export type ActionType = ExecutableAction | "notify";
export type ActionStatus = "pending" | "done" | "dismissed" | "expired" | "failed" | "undone";

export const AUTONOMY_LEVELS: { value: Autonomy; label: string; help: string }[] = [
  { value: "off", label: "No", help: "No lo hace." },
  { value: "ask", label: "Preguntar", help: "Lo propone en la bandeja y espera tu decisión." },
  { value: "auto", label: "Sola", help: "Lo hace sin preguntar; queda en el registro y se puede deshacer." },
];

export const ACTION_TYPES: { value: ExecutableAction; label: string; help: string }[] = [
  { value: "create_task", label: "Crear tareas", help: "Tareas y recordatorios en los deals." },
  { value: "add_note", label: "Escribir notas", help: "Notas en la ficha del deal." },
  { value: "draft_email", label: "Enviar correos", help: "Desde tu correo conectado (Outlook o Gmail). Sin cuenta conectada, solo prepara borradores." },
  { value: "move_stage", label: "Mover deals de fase", help: "Avanzar o retroceder un deal en su pipeline." },
  { value: "update_deal", label: "Editar deals", help: "Cambiar título, importe o fecha de cierre." },
];
export const actionLabel = (t: string) =>
  t === "notify" ? "Pedir una decisión" : ACTION_TYPES.find((a) => a.value === t)?.label ?? t;

export const AGENTS: { value: AgentKind; label: string; help: string }[] = [
  { value: "assistant", label: "Asistente del CRM", help: "Las reglas automáticas y, más adelante, la IA integrada." },
  { value: "external", label: "Agentes externos", help: "Grok Bot u otros agentes conectados por MCP (siguiente fase)." },
];

const RANK: Record<Autonomy, number> = { off: 0, ask: 1, auto: 2 };
export const minAutonomy = (a: Autonomy, b: Autonomy): Autonomy => (RANK[a] <= RANK[b] ? a : b);

// ---------------------------------------------------------------------------
// Reglas y permisos

export type Rule = {
  id: string;
  key: string;
  name: string;
  description: string;
  autonomy: Autonomy;
  allowed_autonomy: Autonomy[];
  params: Record<string, unknown>;
  position: number;
};

/** Qué acción produce cada regla incluida. */
export const RULE_ACTION: Record<string, ActionType> = {
  meeting_recap: "draft_email",
  advance_after_session: "move_stage",
  offer_session_slots: "draft_email",
  missing_stage_session: "create_task",
  stale_deal_followup: "draft_email",
  no_show_rebook: "draft_email",
  stale_deal_escalate: "notify",
  won_handoff: "create_task",
};

type ParamSpec = { key: string; label: string; kind: "days" | "number" | "text" | "textarea"; help?: string };

/** Parámetros ajustables de cada regla. */
export const RULE_PARAMS: Record<string, ParamSpec[]> = {
  offer_session_slots: [
    { key: "grace_days", label: "Días de margen al entrar en la fase", kind: "days" },
    { key: "cooldown_days", label: "No repetir antes de (días)", kind: "days" },
    { key: "subject", label: "Asunto", kind: "text" },
    { key: "body", label: "Texto", kind: "textarea", help: "Puedes usar {deal}, {nombre}, {responsable}, {sesion} y {huecos} (tus próximos huecos libres)." },
  ],
  missing_stage_session: [
    { key: "grace_days", label: "Días de margen al entrar en la fase", kind: "days" },
    { key: "cooldown_days", label: "No repetir antes de (días)", kind: "days" },
  ],
  stale_deal_followup: [
    { key: "cooldown_days", label: "No repetir antes de (días)", kind: "days" },
    { key: "subject", label: "Asunto", kind: "text" },
    { key: "body", label: "Texto", kind: "textarea", help: "Puedes usar {deal}, {nombre}, {responsable} y {huecos} (tus próximos huecos libres)." },
  ],
  no_show_rebook: [
    { key: "subject", label: "Asunto", kind: "text" },
    { key: "body", label: "Texto", kind: "textarea", help: "Puedes usar {deal}, {nombre}, {responsable}, {sesion} y {huecos} (tus próximos huecos libres)." },
  ],
  stale_deal_escalate: [
    { key: "factor", label: "Veces el límite de días de la fase", kind: "number" },
    { key: "cooldown_days", label: "No repetir antes de (días)", kind: "days" },
  ],
  meeting_recap: [
    { key: "subject", label: "Asunto", kind: "text" },
    { key: "body", label: "Texto", kind: "textarea", help: "Puedes usar {deal}, {nombre}, {responsable}, {sesion}, {resumen}, {proximos_pasos} y {huecos}." },
  ],
  won_handoff: [
    { key: "due_days", label: "Plazo de la tarea (días)", kind: "days" },
  ],
};

export async function listRules(): Promise<Rule[]> {
  return sql<Rule[]>`
    SELECT id, key, name, description, autonomy, allowed_autonomy, params, position
    FROM automation_rules ORDER BY position, name`;
}

export type Permission = { actor: AgentKind; action_type: ExecutableAction; autonomy: Autonomy; allowed_autonomy: Autonomy[] };

export async function listPermissions(): Promise<Permission[]> {
  return sql<Permission[]>`SELECT actor, action_type, autonomy, allowed_autonomy FROM ai_permissions`;
}

/**
 * Autonomía con la que actúa una regla: la menor entre la regla y el permiso
 * del asistente. Sin buzón conectado, un correo no puede salir solo.
 */
export function effectiveAutonomy(rule: Rule, permissions: Permission[], ctx: { mailbox: boolean }): Autonomy {
  const action = RULE_ACTION[rule.key];
  if (!action) return "off";
  // Pedir una decisión nunca es automático: es una pregunta.
  if (action === "notify") return minAutonomy(rule.autonomy, "ask");
  const perm = permissions.find((p) => p.actor === "assistant" && p.action_type === action);
  const level = minAutonomy(rule.autonomy, perm?.autonomy ?? "off");
  return action === "draft_email" && !ctx.mailbox ? minAutonomy(level, "ask") : level;
}

/** Límite de un permiso de correo cuando no hay buzón. */
export const capForMailbox = (action: string, level: Autonomy, mailbox: boolean): Autonomy =>
  action === "draft_email" && !mailbox ? minAutonomy(level, "ask") : level;

export async function setRuleAutonomy(ruleId: string, autonomy: Autonomy) {
  const [rule] = await sql<{ allowed_autonomy: Autonomy[] }[]>`SELECT allowed_autonomy FROM automation_rules WHERE id = ${ruleId}`;
  if (!rule) throw new UserError("La regla no existe.");
  if (!rule.allowed_autonomy.includes(autonomy)) throw new UserError("Esta regla no admite ese nivel todavía.");
  await sql`UPDATE automation_rules SET autonomy = ${autonomy} WHERE id = ${ruleId}`;
  if (autonomy === "off") {
    await sql`UPDATE automation_actions SET status = 'expired', decided_at = now()
              WHERE rule_id = ${ruleId} AND status = 'pending'`;
  }
}

export async function setPermission(actor: AgentKind, action: ExecutableAction, autonomy: Autonomy) {
  const [p] = await sql<{ allowed_autonomy: Autonomy[] }[]>`
    SELECT allowed_autonomy FROM ai_permissions WHERE actor = ${actor} AND action_type = ${action}`;
  if (!p) throw new UserError("Permiso no válido.");
  if (!p.allowed_autonomy.includes(autonomy)) throw new UserError("Ese nivel aún no está disponible para esta acción.");
  await sql`UPDATE ai_permissions SET autonomy = ${autonomy}, updated_at = now()
            WHERE actor = ${actor} AND action_type = ${action}`;
}

export async function updateRuleParams(ruleId: string, data: Record<string, unknown>) {
  const [rule] = await sql<{ key: string; params: Record<string, unknown> }[]>`
    SELECT key, params FROM automation_rules WHERE id = ${ruleId}`;
  if (!rule) throw new UserError("La regla no existe.");
  const next = { ...rule.params };
  for (const spec of RULE_PARAMS[rule.key] ?? []) {
    const raw = data[spec.key];
    if (raw === undefined) continue;
    if (spec.kind === "days" || spec.kind === "number") {
      const n = Number(String(raw).replace(",", "."));
      const min = spec.kind === "days" ? 0 : 1;
      if (!Number.isFinite(n) || n < min || n > 365) throw new UserError(`«${spec.label}» debe ser un número entre ${min} y 365.`);
      next[spec.key] = spec.kind === "days" ? Math.round(n) : n;
    } else {
      const s = String(raw).trim();
      if (!s) throw new UserError(`«${spec.label}» no puede quedar vacío.`);
      if (s.length > 5000) throw new UserError(`«${spec.label}» es demasiado largo.`);
      next[spec.key] = s;
    }
  }
  await sql`UPDATE automation_rules SET params = ${json(next)} WHERE id = ${ruleId}`;
}

export type AutomationSettings = { paused: boolean; last_run_at: Date | null };

export async function getSettings(): Promise<AutomationSettings> {
  const [s] = await sql<AutomationSettings[]>`SELECT paused, last_run_at FROM automation_settings`;
  return s ?? { paused: false, last_run_at: null };
}

export async function setPaused(paused: boolean) {
  await sql`UPDATE automation_settings SET paused = ${paused}, updated_at = now()`;
}

// ---------------------------------------------------------------------------
// Propuestas

type Candidate = {
  dealId: string;
  title: string;
  reason: string;
  payload: Record<string, unknown> & { stage_id?: string; activity_id?: string };
};

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v : fallback);
const firstName = (full: string | null) => (full ?? "").trim().split(/\s+/)[0] ?? "";

/** Sustituye {deal}, {nombre}, {responsable}… en las plantillas. */
export function renderTemplate(template: string, vars: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}

type DealContact = {
  id: string; title: string; stage_id: string; stage_name: string; days_in_stage: number;
  rotten_after_days: number | null; required_activity_type: string | null; owner_id: string | null;
  owner_name: string | null; person_id: string | null; person_name: string | null; email: string | null;
};

/** Deals abiertos con su contacto principal (que acepte correos) y su responsable. */
type Fragment = postgres.PendingQuery<postgres.Row[]>;

const openDeals = (where: Fragment) => sql<DealContact[]>`
  SELECT ods.id, ods.title, ods.stage_id, ods.stage_name, ods.days_in_stage, s.rotten_after_days,
         ods.required_activity_type, d.owner_id, u.name AS owner_name,
         pc.person_id, pc.full_name AS person_name, pc.email
  FROM open_deals_status ods
  JOIN deals d ON d.id = ods.id
  JOIN stages s ON s.id = ods.stage_id
  LEFT JOIN users u ON u.id = d.owner_id
  LEFT JOIN LATERAL (
    SELECT p.id AS person_id, p.full_name,
           (SELECT e.email FROM person_emails e WHERE e.person_id = p.id ORDER BY e.is_primary DESC, e.created_at LIMIT 1) AS email
    FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
    WHERE dp.deal_id = ods.id AND p.deleted_at IS NULL AND p.unsubscribed_at IS NULL
    ORDER BY dp.is_primary DESC, dp.created_at LIMIT 1
  ) pc ON true
  WHERE ${where}
  ORDER BY ods.days_in_stage DESC
  LIMIT 500`;

/** Lo que necesitan las reglas en una revisión: todas las reglas, permisos y el calendario. */
export type RunContext = {
  rules: Rule[];
  permissions: Permission[];
  /** Hay al menos un buzón conectado (para enviar correos y leer el calendario). */
  mailbox: boolean;
  /** Texto con los próximos huecos libres del calendario del responsable (se calcula una vez por revisión). */
  slotsFor: (ownerId: string | null) => Promise<string>;
};

export async function buildContext(): Promise<RunContext> {
  const [rules, permissions, mailbox] = await Promise.all([listRules(), listPermissions(), hasActiveMailbox()]);
  const cache = new Map<string, Promise<string>>();
  return {
    rules, permissions, mailbox,
    slotsFor(ownerId) {
      const key = ownerId ?? "";
      if (!cache.has(key)) cache.set(key, senderFor(ownerId).then((c) => slotsText(c)));
      return cache.get(key)!;
    },
  };
}

type Scanner = (rule: Rule, ctx: RunContext) => Promise<Candidate[]>;
type EventRow = { id: string; entity_id: string; event_type: string; payload: Record<string, unknown>; occurred_at: Date };
type EventHandler = { events: string[]; handle: (rule: Rule, e: EventRow, ctx: RunContext) => Promise<Candidate | null>; stillValid: () => Fragment };

const escalateFactor = (all: Rule[]) => num(all.find((r) => r.key === "stale_deal_escalate")?.params.factor, 2);

/** Rellena una plantilla de correo; {huecos} solo se calcula si aparece. */
async function renderEmail(rule: Rule, ctx: RunContext, ownerId: string | null, vars: Record<string, string>, defaults: { subject: string; body: string }) {
  const subjectT = str(rule.params.subject, defaults.subject), bodyT = str(rule.params.body, defaults.body);
  const all = { ...vars };
  if (bodyT.includes("{huecos}") || subjectT.includes("{huecos}")) all.huecos = await ctx.slotsFor(ownerId);
  return { subject: renderTemplate(subjectT, all), body: renderTemplate(bodyT, all) };
}

/** Las condiciones del deal que piden una sesión sin agendar. */
const missingSession = (grace: number) => sql`
  ods.required_activity_type IS NOT NULL AND NOT ods.has_upcoming_session AND ods.days_in_stage >= ${grace}`;

const SCANNERS: Record<string, Scanner> = {
  // Fase que requiere una sesión (demo, llamada…) y el deal no la tiene agendada.
  // Si el calendario está conectado y la regla de ofrecer huecos está activa, de
  // los deals con email se encarga esa regla; aquí quedan los demás.
  async missing_stage_session(rule, ctx) {
    const grace = num(rule.params.grace_days, 1);
    const offer = ctx.rules.find((r) => r.key === "offer_session_slots");
    const offering = ctx.mailbox && offer !== undefined && effectiveAutonomy(offer, ctx.permissions, ctx) !== "off";
    const rows = await openDeals(missingSession(grace));
    return rows.filter((d) => !(offering && d.email)).map((d) => {
      const session = activityLabel(d.required_activity_type).toLowerCase();
      return {
        dealId: d.id,
        title: `Agendar ${session}: ${d.title}`,
        reason: `Lleva ${d.days_in_stage} día${d.days_in_stage === 1 ? "" : "s"} en «${d.stage_name}» y no tiene ninguna ${session} agendada.`,
        payload: {
          stage_id: d.stage_id, type: "task", subject: `Agendar ${session} con ${d.person_name ?? d.title}`,
          note: `La fase «${d.stage_name}» requiere una ${session} y no hay ninguna agendada.`,
          due_in_days: 0, person_id: d.person_id, owner_id: d.owner_id,
        },
      };
    });
  },

  // Fase que requiere una sesión: correo al contacto con tus huecos libres.
  async offer_session_slots(rule, ctx) {
    if (!ctx.mailbox) return [];
    const rows = await openDeals(missingSession(num(rule.params.grace_days, 0)));
    const out: Candidate[] = [];
    for (const d of rows.filter((r) => r.email)) {
      const session = activityLabel(d.required_activity_type).toLowerCase();
      const vars = { deal: d.title, nombre: firstName(d.person_name), responsable: d.owner_name ?? "", sesion: session };
      out.push({
        dealId: d.id,
        title: `Ofrecer huecos a ${d.person_name} para la ${session}`,
        reason: `«${d.title}» está en «${d.stage_name}», que requiere una ${session}, y no hay ninguna agendada.`,
        payload: {
          stage_id: d.stage_id, to: d.email, to_name: d.person_name, person_id: d.person_id,
          ...(await renderEmail(rule, ctx, d.owner_id, vars, { subject: "{deal}: ¿cuándo hacemos la {sesion}?", body: "Hola {nombre},\n\n{huecos}" })),
        },
      });
    }
    return out;
  },

  // Deal parado (supera los días de su fase) sin nada agendado ni correos
  // recientes: correo de seguimiento.
  async stale_deal_followup(rule, ctx) {
    const factor = escalateFactor(ctx.rules);
    const quiet = num(rule.params.cooldown_days, 7);
    const rows = await openDeals(sql`
      ods.is_rotten AND ods.days_in_stage < s.rotten_after_days * ${factor}
      AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.deal_id = ods.id AND NOT a.done AND a.due_at >= now())
      AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.deal_id = ods.id AND a.type = 'email' AND a.done
                        AND a.done_at > now() - make_interval(days => ${quiet}))`);
    const out: Candidate[] = [];
    for (const d of rows.filter((r) => r.email)) {
      const vars = { deal: d.title, nombre: firstName(d.person_name), responsable: d.owner_name ?? "" };
      out.push({
        dealId: d.id,
        title: `Escribir a ${d.person_name} para retomar «${d.title}»`,
        reason: `Lleva ${d.days_in_stage} días en «${d.stage_name}» (el límite es ${d.rotten_after_days}) y no hay nada agendado.`,
        payload: {
          stage_id: d.stage_id, to: d.email, to_name: d.person_name, person_id: d.person_id,
          ...(await renderEmail(rule, ctx, d.owner_id, vars, { subject: "¿Seguimos con {deal}?", body: "Hola {nombre}," })),
        },
      });
    }
    return out;
  },

  // Deal muy parado: pide a una persona que decida.
  async stale_deal_escalate(rule) {
    const factor = num(rule.params.factor, 2);
    const rows = await openDeals(sql`s.rotten_after_days IS NOT NULL AND ods.days_in_stage >= s.rotten_after_days * ${factor}`);
    return rows.map((d) => ({
      dealId: d.id,
      title: `Decide qué hacer con «${d.title}»`,
      reason: `Lleva ${d.days_in_stage} días en «${d.stage_name}», ${factor === 2 ? "más del doble de" : `${factor} veces`} lo normal (${d.rotten_after_days}). ¿Insistir, cambiar de enfoque o darlo por perdido?`,
      payload: { stage_id: d.stage_id, days_in_stage: d.days_in_stage },
    }));
  },
};

/** A quién escribir tras una sesión: su contacto si tiene email; si no, el principal del deal. */
async function contactFor(personId: string | null, d: DealContact) {
  let to = { person_id: d.person_id, name: d.person_name, email: d.email };
  if (personId && personId !== d.person_id) {
    const [p] = await sql<{ full_name: string; email: string | null }[]>`
      SELECT p.full_name, (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email
      FROM persons p WHERE p.id = ${personId} AND p.deleted_at IS NULL AND p.unsubscribed_at IS NULL`;
    if (p?.email) to = { person_id: personId, name: p.full_name, email: p.email };
  }
  return to;
}

const EVENT_HANDLERS: Record<string, EventHandler> = {
  // Sesión marcada como «No se presentó»: correo para reagendar.
  no_show_rebook: {
    events: ["activity.completed"],
    async handle(rule, e, ctx) {
      if (e.payload.outcome !== "no_show" || typeof e.payload.activity_id !== "string") return null;
      const [a] = await sql<{ type: string; subject: string; person_id: string | null }[]>`
        SELECT type, subject, person_id FROM activities WHERE id = ${e.payload.activity_id}`;
      if (!a) return null;
      const [d] = await openDeals(sql`ods.id = ${e.entity_id}`);
      if (!d) return null;
      const to = await contactFor(a.person_id, d);
      if (!to.email) return null;
      const vars = { deal: d.title, nombre: firstName(to.name), responsable: d.owner_name ?? "", sesion: activityLabel(a.type).toLowerCase() };
      return {
        dealId: d.id,
        title: `Proponer otra fecha a ${to.name}`,
        reason: `No se presentó a «${a.subject}».`,
        payload: {
          activity_id: e.payload.activity_id, to: to.email, to_name: to.name, person_id: to.person_id,
          ...(await renderEmail(rule, ctx, d.owner_id, vars, { subject: "¿Buscamos otro hueco?", body: "Hola {nombre},\n\n{huecos}" })),
        },
      };
    },
    // Caduca si el deal se cierra o si ya se ha agendado otra sesión después.
    stillValid: () => sql`d.status = 'open' AND NOT EXISTS (
      SELECT 1 FROM activities a WHERE a.deal_id = d.id AND NOT a.done AND a.due_at >= now() AND a.created_at > x.created_at)`,
  },

  // Deal ganado: tarea de traspaso a Customer Success con el resumen.
  // Reunión celebrada: correo al contacto con el resumen, próximos pasos y huecos.
  meeting_recap: {
    events: ["activity.completed"],
    async handle(rule, e, ctx) {
      if (e.payload.outcome !== "held" || typeof e.payload.activity_id !== "string") return null;
      const [a] = await sql<{ type: string; subject: string; note: string | null; transcript: string | null; person_id: string | null }[]>`
        SELECT type, subject, note, transcript, person_id FROM activities WHERE id = ${e.payload.activity_id}`;
      if (!a || !["call", "meeting", "video_call", "demo"].includes(a.type)) return null;
      const [d] = await openDeals(sql`ods.id = ${e.entity_id}`);
      if (!d) return null;
      const to = await contactFor(a.person_id, d);
      if (!to.email) return null;
      const session = activityLabel(a.type).toLowerCase();
      // Con IA: resumen y próximos pasos a partir de las notas o la transcripción.
      const ai = parseJsonReply<{ resumen?: string; proximos_pasos?: string[] }>(await generate("meeting_recap", {
        deal: { titulo: d.title, fase: d.stage_name },
        reunion: { tipo: activityLabel(a.type), asunto: a.subject, notas: a.note, transcripcion: a.transcript?.slice(0, 60000) ?? null },
        contacto: to.name,
      }));
      const resumen = ai?.resumen?.trim() || a.note?.trim() || "[Añade aquí lo más importante de la reunión]";
      const pasos = (ai?.proximos_pasos?.length ? ai.proximos_pasos : ["Te envío lo que hemos acordado", "Agendamos la siguiente sesión"])
        .map((x) => `- ${String(x).replace(/^[-•]\s*/, "")}`).join("\n");
      if (ai?.resumen) await sql`UPDATE activities SET summary = ${ai.resumen.slice(0, 5000)} WHERE id = ${e.payload.activity_id}`;
      const vars = { deal: d.title, nombre: firstName(to.name), responsable: d.owner_name ?? "", sesion: session, resumen, proximos_pasos: pasos };
      return {
        dealId: d.id,
        title: `Enviar el resumen de la ${session} a ${to.name}`,
        reason: `Se celebró «${a.subject}».${ai ? " Resumen redactado por la IA a partir de tus notas." : a.note ? " Resumen a partir de tus notas." : " Añade tus notas al resumen antes de enviarlo."}`,
        payload: {
          activity_id: e.payload.activity_id, to: to.email, to_name: to.name, person_id: to.person_id,
          ...(await renderEmail(rule, ctx, d.owner_id, vars, { subject: "Resumen de nuestra {sesion}: {deal}", body: "Hola {nombre},\n\n{resumen}\n\n{proximos_pasos}" })),
        },
      };
    },
    stillValid: () => sql`d.status = 'open'`,
  },

  // Se celebró la sesión que pide la fase: proponer pasar a la siguiente.
  advance_after_session: {
    events: ["activity.completed"],
    async handle(_rule, e) {
      if (e.payload.outcome !== "held" || typeof e.payload.activity_id !== "string") return null;
      const [x] = await sql<{ deal_id: string; title: string; subject: string; stage_id: string; stage_name: string;
                              next_id: string | null; next_name: string | null }[]>`
        SELECT d.id AS deal_id, d.title, a.subject, s.id AS stage_id, s.name AS stage_name, nx.id AS next_id, nx.name AS next_name
        FROM activities a JOIN deals d ON d.id = a.deal_id AND d.status = 'open' AND d.deleted_at IS NULL
        JOIN stages s ON s.id = d.stage_id AND s.required_activity_type = a.type
        LEFT JOIN LATERAL (
          SELECT id, name FROM stages WHERE pipeline_id = d.pipeline_id AND is_active AND position > s.position ORDER BY position LIMIT 1
        ) nx ON true
        WHERE a.id = ${e.payload.activity_id}`;
      if (!x?.next_id) return null;
      return {
        dealId: x.deal_id,
        title: `Pasar «${x.title}» a «${x.next_name}»`,
        reason: `Se celebró «${x.subject}», la sesión que pide «${x.stage_name}».`,
        payload: { activity_id: e.payload.activity_id, stage_id: x.next_id, stage_name: x.next_name, from_stage_id: x.stage_id },
      };
    },
    stillValid: () => sql`d.status = 'open' AND d.stage_id::text = x.payload->>'from_stage_id'`,
  },

  won_handoff: {
    events: ["deal.won"],
    async handle(rule, e) {
      const summary = await handoffSummary(e.entity_id);
      if (!summary) return null;
      // Con IA, el resumen lo redacta el modelo; los datos de siempre quedan debajo.
      const ai = await generate("handoff", { datos_del_deal: summary.text });
      if (ai) summary.text = `${ai}\n\n— Datos del CRM —\n${summary.text}`.slice(0, 4900);
      return {
        dealId: e.entity_id,
        title: `Traspaso a Customer Success: ${summary.title}`,
        reason: "Deal ganado. Se prepara el resumen de lo ocurrido para el equipo de Customer Success.",
        payload: {
          type: "task", subject: `Traspaso a Customer Success: ${summary.title}`, note: summary.text,
          due_in_days: num(rule.params.due_days, 1), person_id: summary.personId, owner_id: summary.ownerId,
        },
      };
    },
    stillValid: () => sql`d.status = 'won'`,
  },
};

/** Resumen del deal para Customer Success con los datos del CRM (la IA, si está configurada, lo redacta encima). */
export async function handoffSummary(dealId: string) {
  const [d] = await sql<{ title: string; value: string | null; currency: string; organization_name: string | null; owner_id: string | null;
                          owner_name: string | null; source: string | null; lead_source: string | null; lead_detail: string | null;
                          created_at: Date; won_at: Date | null; pipeline_name: string }[]>`
    SELECT d.title, d.value::text, d.currency, o.name AS organization_name, d.owner_id, u.name AS owner_name, d.source,
           l.source AS lead_source, l.source_detail AS lead_detail, d.created_at, d.won_at, p.name AS pipeline_name
    FROM deals d JOIN pipelines p ON p.id = d.pipeline_id
    LEFT JOIN organizations o ON o.id = d.organization_id
    LEFT JOIN users u ON u.id = d.owner_id
    LEFT JOIN leads l ON l.id = d.lead_id
    WHERE d.id = ${dealId} AND d.deleted_at IS NULL`;
  if (!d) return null;
  const [contacts, products, stages, sessions, notes] = await Promise.all([
    sql<{ person_id: string; full_name: string; role: string | null; email: string | null; job_title: string | null }[]>`
      SELECT p.id AS person_id, p.full_name, dp.role,
             (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
             (SELECT job_title FROM person_organizations WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1) AS job_title
      FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
      WHERE dp.deal_id = ${dealId} ORDER BY dp.is_primary DESC, p.full_name`,
    sql<{ name: string; quantity: string }[]>`
      SELECT pr.name, dp.quantity::text FROM deal_products dp JOIN products pr ON pr.id = dp.product_id WHERE dp.deal_id = ${dealId}`,
    sql<{ stage_name: string; days: number }[]>`
      SELECT s.name AS stage_name,
             floor(extract(epoch FROM coalesce(lead(h.changed_at) OVER w, now()) - h.changed_at) / 86400)::int AS days
      FROM deal_stage_history h JOIN stages s ON s.id = h.to_stage_id
      WHERE h.deal_id = ${dealId} WINDOW w AS (ORDER BY h.changed_at, h.id) ORDER BY h.changed_at, h.id`,
    sql<{ held: number; no_show: number }[]>`
      SELECT count(*) FILTER (WHERE outcome = 'held')::int AS held, count(*) FILTER (WHERE outcome = 'no_show')::int AS no_show
      FROM activities WHERE deal_id = ${dealId} AND done`,
    sql<{ content: string }[]>`SELECT content FROM notes WHERE deal_id = ${dealId} ORDER BY created_at DESC LIMIT 5`,
  ]);
  const cycle = Math.max(0, Math.round(((d.won_at ? new Date(d.won_at) : new Date()).getTime() - new Date(d.created_at).getTime()) / 86400000));
  const lines = [
    `Cliente: ${d.organization_name ?? "—"} · Importe: ${money(d.value, d.currency)} · Responsable: ${d.owner_name ?? "—"}`,
    `Origen: ${[d.lead_source ?? d.source, d.lead_detail].filter(Boolean).join(" — ") || "—"} · Pipeline: ${d.pipeline_name} · Ciclo de venta: ${cycle} días`,
    "",
    "Contactos:",
    ...(contacts.length ? contacts.map((c) => `- ${c.full_name}${[c.role, c.job_title, c.email].filter(Boolean).length ? ` (${[c.role, c.job_title, c.email].filter(Boolean).join(", ")})` : ""}`) : ["- (ninguno)"]),
  ];
  if (products.length) lines.push("", "Productos:", ...products.map((p) => `- ${p.name} × ${Number(p.quantity)}`));
  if (stages.length) lines.push("", `Recorrido: ${stages.map((s) => `${s.stage_name} (${s.days} d)`).join(" → ")}`);
  lines.push(`Sesiones: ${sessions[0]?.held ?? 0} celebradas, ${sessions[0]?.no_show ?? 0} ausencias.`);
  if (notes.length) lines.push("", "Últimas notas:", ...notes.map((n) => `- ${n.content.replace(/\s+/g, " ").slice(0, 300)}`));
  return { title: d.title, text: lines.join("\n").slice(0, 4900), personId: contacts[0]?.person_id ?? null, ownerId: d.owner_id };
}

/** Ya se propuso esto hace poco (o la tarea anterior sigue abierta). */
async function coolingDown(rule: Rule, c: Candidate) {
  const days = num(rule.params.cooldown_days, 0);
  const [row] = await sql<{ x: number }[]>`
    SELECT 1 AS x FROM automation_actions x
    WHERE x.rule_id = ${rule.id} AND x.subject_type = 'deal' AND x.subject_id = ${c.dealId}
      AND (
        (x.status IN ('pending', 'done', 'dismissed') AND x.created_at > now() - make_interval(days => ${days})
           AND (x.payload->>'stage_id') IS NOT DISTINCT FROM ${c.payload.stage_id ?? null}::text)
        OR (x.status = 'done' AND x.action_type = 'create_task' AND EXISTS (
              SELECT 1 FROM activities a WHERE a.id = (x.result->>'activity_id')::uuid AND NOT a.done))
      )
    LIMIT 1`;
  return Boolean(row);
}

/** Un evento ya atendido (p. ej. la misma ausencia o el mismo traspaso). */
async function alreadyHandled(rule: Rule, c: Candidate) {
  const [row] = await sql<{ x: number }[]>`
    SELECT 1 AS x FROM automation_actions
    WHERE rule_id = ${rule.id} AND subject_type = 'deal' AND subject_id = ${c.dealId}
      AND ${c.payload.activity_id
        ? sql`payload->>'activity_id' = ${c.payload.activity_id}`
        : sql`status IN ('pending', 'done')`}
    LIMIT 1`;
  return Boolean(row);
}

/** Crea la propuesta; si la autonomía es «auto», la ejecuta. */
async function propose(rule: Rule, mode: "ask" | "auto", c: Candidate): Promise<"proposed" | "executed" | "failed" | "exists"> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO automation_actions ${sql({
      actor: "assistant", rule_id: rule.id, subject_type: "deal", subject_id: c.dealId, deal_id: c.dealId,
      action_type: RULE_ACTION[rule.key], title: c.title, reason: c.reason, payload: json(c.payload), mode,
    })}
    ON CONFLICT (rule_id, subject_type, subject_id) WHERE status = 'pending' DO NOTHING
    RETURNING id`;
  if (!row) return "exists";
  if (mode === "ask") return "proposed";
  try {
    await executeAction(row.id, { actor: AI_ACTOR });
    return "executed";
  } catch {
    return "failed";
  }
}

// ---------------------------------------------------------------------------
// Ejecución

export type RunResult = {
  status: "ok" | "paused" | "busy"; proposed: number; executed: number; expired: number; failed: number;
  sync?: { emails: number; meetings: number; updated: number; error?: string };
  briefs?: number;
  digests?: number;
};

const LOCK_KEY = 4_201_337; // pg_advisory_lock: una sola ejecución a la vez

/** Pasa todas las reglas. La llaman el temporizador, el botón «Revisar ahora» y el endpoint de cron. */
export async function runAutomations(): Promise<RunResult> {
  const result: RunResult = { status: "ok", proposed: 0, executed: 0, expired: 0, failed: 0 };
  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked`;
    if (!locked) return { ...result, status: "busy" };
    try {
      // Primero se traen los correos y reuniones (aunque la IA esté en pausa).
      result.sync = await syncAllMailboxes();
      const paused = (await getSettings()).paused;
      if (!paused) {
        await runLocked(result);
        // Resúmenes de los deals que han cambiado.
        result.briefs = await refreshStaleBriefs().catch(() => 0);
      }
      // El parte del día sale aunque la IA esté en pausa: es información, no una acción.
      result.digests = await sendDueDigests().catch((err) => { console.error("[parte del día]", err); return 0; });
      if (paused) return { ...result, status: "paused" };
      await sql`UPDATE automation_settings SET last_run_at = now()`;
    } finally {
      await conn`SELECT pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
  return result;
}

async function runLocked(result: RunResult) {
  const ctx = await buildContext();
  const { rules, permissions } = ctx;
  const count = (r: Awaited<ReturnType<typeof propose>>) => {
    if (r === "proposed") result.proposed++;
    else if (r === "executed") result.executed++;
    else if (r === "failed") result.failed++;
  };

  for (const rule of rules) {
    const mode = effectiveAutonomy(rule, permissions, ctx);
    if (mode === "off") {
      const expired = await sql`UPDATE automation_actions SET status = 'expired', decided_at = now()
                                WHERE rule_id = ${rule.id} AND status = 'pending'`;
      result.expired += expired.count;
      continue;
    }

    const scan = SCANNERS[rule.key];
    if (scan) {
      // Los huecos ofrecidos caducan: una propuesta con {huecos} de hace más de
      // dos días se retira y se vuelve a proponer con huecos actuales.
      if (str(rule.params.body, "").includes("{huecos}")) {
        const stale = await sql`UPDATE automation_actions SET status = 'expired', decided_at = now()
                                 WHERE rule_id = ${rule.id} AND status = 'pending' AND created_at < now() - interval '2 days'`;
        result.expired += stale.count;
      }
      const candidates = await scan(rule, ctx);
      // Las propuestas pendientes que ya no se cumplen caducan (p. ej. ya se agendó la demo).
      const keys = candidates.map((c) => `${c.dealId}:${c.payload.stage_id ?? ""}`);
      const expired = await sql`
        UPDATE automation_actions SET status = 'expired', decided_at = now()
        WHERE rule_id = ${rule.id} AND status = 'pending'
          AND NOT (subject_id::text || ':' || coalesce(payload->>'stage_id', '') = ANY(${keys}::text[]))`;
      result.expired += expired.count;
      for (const c of candidates) {
        if (await coolingDown(rule, c)) continue;
        count(await propose(rule, mode, c));
      }
    }

    const handler = EVENT_HANDLERS[rule.key];
    if (handler) {
      const expired = await sql`
        UPDATE automation_actions x SET status = 'expired', decided_at = now()
        FROM deals d
        WHERE x.rule_id = ${rule.id} AND x.status = 'pending' AND d.id = x.deal_id AND NOT (${handler.stillValid()})`;
      result.expired += expired.count;
    }
  }

  // Reglas que se disparan con un evento. Lo de hace más de una semana (p. ej.
  // con el motor en pausa) ya no dispara nada.
  const events = await sql<EventRow[]>`
    SELECT id::text, entity_id, event_type, payload, occurred_at FROM events
    WHERE processed_at IS NULL ORDER BY id LIMIT 2000`;
  for (const e of events) {
    if (Date.now() - new Date(e.occurred_at).getTime() > 7 * 86400000) continue;
    for (const rule of rules) {
      const handler = EVENT_HANDLERS[rule.key];
      if (!handler || !handler.events.includes(e.event_type)) continue;
      const mode = effectiveAutonomy(rule, permissions, ctx);
      if (mode === "off") continue;
      try {
        const c = await handler.handle(rule, e, ctx);
        if (!c || (await alreadyHandled(rule, c))) continue;
        count(await propose(rule, mode, c));
      } catch (err) {
        console.error(`[automatizaciones] ${rule.key} / evento ${e.id}`, err);
        result.failed++;
      }
    }
  }
  if (events.length) await sql`UPDATE events SET processed_at = now() WHERE id = ANY(${events.map((e) => e.id)}::bigint[])`;
}

// ---------------------------------------------------------------------------
// Ejecutar, descartar y deshacer

type ActionRow = {
  id: string; action_type: ActionType; deal_id: string | null; title: string; payload: Record<string, unknown>;
  status: ActionStatus; result: Record<string, unknown> | null; executed_at: Date | null;
};

const emailEdits = z.object({
  to: optional(z.email({ message: "El email del destinatario no es válido" })),
  subject: optText(300),
  body: optText(20000),
});
const taskEdits = z.object({ subject: optText(300), note: optText(5000) });

/** Vencimiento de una tarea: al final del día (hora local) dentro de `days` días; así no nace vencida. */
const dueAt = (days: unknown) => {
  const tz = process.env.TZ || "Europe/Madrid";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return zonedToUtc(Number(p.year), Number(p.month), Number(p.day) + num(days, 0), 23, 59, tz).toISOString();
};

/**
 * Ejecuta una propuesta (aprobada por una persona o en modo automático).
 * `edits` permite corregir el borrador o la tarea antes de aprobarla.
 */
export async function executeAction(actionId: string, opts: { actor: Actor; edits?: Record<string, unknown> }) {
  // Se reclama la propuesta para que dos clics no la ejecuten dos veces.
  const [a] = await sql<ActionRow[]>`
    UPDATE automation_actions SET decided_at = now(), decided_by = ${opts.actor.type === "user" ? opts.actor.id : null}
    WHERE id = ${actionId} AND status = 'pending' AND decided_at IS NULL
    RETURNING id, action_type, deal_id, title, payload, status, result, executed_at`;
  if (!a) throw new UserError("Esta propuesta ya no está pendiente.");
  try {
    const result = await perform(a, opts.edits ?? {}, opts.actor);
    await sql`UPDATE automation_actions SET status = 'done', executed_at = now(), result = ${json(result)}
              WHERE id = ${actionId}`;
  } catch (err) {
    const message = err instanceof UserError ? err.message : "No se pudo ejecutar.";
    if (!(err instanceof UserError)) console.error("[automatizaciones]", err);
    await sql`UPDATE automation_actions SET status = 'failed', error = ${message} WHERE id = ${actionId}`;
    throw new UserError(message);
  }
}

async function perform(a: ActionRow, edits: Record<string, unknown>, actor: Actor): Promise<Record<string, unknown>> {
  const p = a.payload;
  switch (a.action_type) {
    case "create_task": {
      const e = parse(taskEdits, edits);
      const activityId = await createActivity(AI_ACTOR, {
        type: str(p.type, "task"), subject: e.subject ?? str(p.subject, a.title), note: e.note ?? (p.note as string | undefined),
        due_at: dueAt(p.due_in_days), deal_id: a.deal_id ?? undefined,
        person_id: (p.person_id as string | null) ?? undefined, owner_id: (p.owner_id as string | null) ?? undefined,
      });
      return { activity_id: activityId };
    }
    case "draft_email": {
      const e = parse(emailEdits, edits);
      const to = e.to ?? str(p.to, "");
      if (!to) throw new UserError("Falta el destinatario.");
      const subject = e.subject ?? str(p.subject, a.title);
      const body = e.body ?? str(p.body, "");
      const [deal] = a.deal_id
        ? await sql<{ owner_id: string | null; organization_id: string | null }[]>`SELECT owner_id, organization_id FROM deals WHERE id = ${a.deal_id}`
        : [];
      // Con cuenta conectada sale desde su correo (salvo que la persona diga que ya lo envió ella).
      const sender = edits.manual === "1" ? null : await senderFor(deal?.owner_id);
      if (sender) {
        const sent = await sendEmail(sender, actor, {
          to: { email: to, name: str(p.to_name, "") || null }, subject, body,
          dealId: a.deal_id, personId: (p.person_id as string | null) ?? null, organizationId: deal?.organization_id ?? null,
        });
        return { activity_id: sent.activityId, to, subject, from: sent.from, sent: true };
      }
      if (actor.type !== "user") throw new UserError("No hay ningún buzón conectado desde el que enviar.");
      // Sin buzón: lo envía la persona desde su correo y aquí queda registrado.
      const activityId = await createActivity(UI_ACTOR, {
        type: "email", subject, note: `Para: ${to}\n\n${body}`.slice(0, 5000),
        deal_id: a.deal_id ?? undefined, person_id: (p.person_id as string | null) ?? undefined,
      });
      await completeActivity(UI_ACTOR, activityId, {});
      return { activity_id: activityId, to, subject };
    }
    case "add_note": {
      if (!a.deal_id) throw new UserError("La propuesta no tiene deal.");
      const noteId = await createNote(AI_ACTOR, { content: str(p.content, a.title), deal_id: a.deal_id });
      return { note_id: noteId };
    }
    case "move_stage": {
      if (!a.deal_id) throw new UserError("La propuesta no tiene deal.");
      const [d] = await sql<{ stage_id: string }[]>`SELECT stage_id FROM deals WHERE id = ${a.deal_id}`;
      if (!d) throw new UserError("El deal ya no existe.");
      await moveDealToStage(AI_ACTOR, a.deal_id, str(p.stage_id, ""));
      return { from_stage_id: d.stage_id, to_stage_id: p.stage_id };
    }
    case "update_deal": {
      if (!a.deal_id) throw new UserError("La propuesta no tiene deal.");
      const changes = parse(z.object({
        title: optText(300), value: optional(z.coerce.number().min(0)), expected_close_date: optional(z.iso.date()),
      }), p.changes ?? {});
      const [before] = await sql<{ title: string; value: string | null; expected_close_date: string | null }[]>`
        SELECT title, value::text, expected_close_date::text FROM deals WHERE id = ${a.deal_id} AND deleted_at IS NULL`;
      if (!before) throw new UserError("El deal ya no existe.");
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (Object.keys(set).length === 0) throw new UserError("La propuesta no cambia nada.");
      await sql`UPDATE deals SET ${sql(set)} WHERE id = ${a.deal_id}`;
      await recordEvent(sql, AI_ACTOR, "deal", a.deal_id, "deal.updated", { changes: set });
      return { before: Object.fromEntries(Object.keys(set).map((k) => [k, before[k as keyof typeof before]])) };
    }
    case "notify":
      return {};
  }
}

export async function dismissAction(actionId: string, actor: Actor = UI_ACTOR) {
  const res = await sql`
    UPDATE automation_actions SET status = 'dismissed', decided_at = now(), decided_by = ${actor.id}
    WHERE id = ${actionId} AND status = 'pending' AND decided_at IS NULL`;
  if (res.count === 0) throw new UserError("Esta propuesta ya no está pendiente.");
}

const UNDO_DAYS = 30;
export const isUndoable = (a: { status: string; action_type: string; executed_at: Date | null }) =>
  // Un correo ya enviado no se puede «desenviar».
  a.status === "done" && a.action_type !== "notify" && a.action_type !== "draft_email" && a.executed_at !== null
  && Date.now() - new Date(a.executed_at).getTime() < UNDO_DAYS * 86400000;

/** Deshace una acción ejecutada (borra la tarea, devuelve el deal a su fase…). */
export async function undoAction(actionId: string, actor: Actor = UI_ACTOR) {
  const [a] = await sql<ActionRow[]>`
    SELECT id, action_type, deal_id, title, payload, status, result, executed_at FROM automation_actions WHERE id = ${actionId}`;
  if (!a || !isUndoable(a)) throw new UserError("Esta acción no se puede deshacer.");
  const r = a.result ?? {};
  switch (a.action_type) {
    case "create_task": {
      const del = await sql`DELETE FROM activities WHERE id = ${String(r.activity_id)} AND NOT done`;
      if (del.count === 0) throw new UserError("La tarea ya está hecha o se ha borrado: no se puede deshacer.");
      break;
    }
    case "add_note":
      await sql`DELETE FROM notes WHERE id = ${String(r.note_id)}`;
      break;
    case "move_stage": {
      const [d] = await sql<{ stage_id: string; status: string }[]>`SELECT stage_id, status FROM deals WHERE id = ${a.deal_id}`;
      if (!d || d.status !== "open" || d.stage_id !== r.to_stage_id) {
        throw new UserError("El deal ha cambiado desde entonces: muévelo a mano si hace falta.");
      }
      await moveDealToStage(actor, a.deal_id!, String(r.from_stage_id));
      break;
    }
    case "update_deal": {
      const before = (r.before ?? {}) as Record<string, unknown>;
      if (Object.keys(before).length) await sql`UPDATE deals SET ${sql(before as Record<string, string>)} WHERE id = ${a.deal_id}`;
      break;
    }
  }
  await sql`UPDATE automation_actions SET status = 'undone' WHERE id = ${actionId}`;
  if (a.deal_id) await recordEvent(sql, actor, "deal", a.deal_id, "ai.action_undone", { action_id: actionId, title: a.title });
}

// ---------------------------------------------------------------------------
// Bandeja, registro y estadísticas

export type InboxItem = {
  id: string; actor: AgentKind; agent_name: string | null; rule_key: string | null; rule_name: string | null;
  action_type: ActionType; title: string; reason: string; payload: Record<string, unknown>; status: ActionStatus;
  mode: "ask" | "auto"; result: Record<string, unknown> | null; error: string | null;
  deal_id: string | null; deal_title: string | null; organization_name: string | null;
  created_at: Date; decided_at: Date | null; executed_at: Date | null;
};

export async function listActions({ view, dealId, limit = 200 }: { view: "pending" | "log"; dealId?: string; limit?: number }) {
  return sql<InboxItem[]>`
    SELECT x.id, x.actor, x.agent_name, r.key AS rule_key, r.name AS rule_name, x.action_type, x.title, x.reason,
           x.payload, x.status, x.mode, x.result, x.error, x.deal_id, d.title AS deal_title,
           o.name AS organization_name, x.created_at, x.decided_at, x.executed_at
    FROM automation_actions x
    LEFT JOIN automation_rules r ON r.id = x.rule_id
    LEFT JOIN deals d ON d.id = x.deal_id
    LEFT JOIN organizations o ON o.id = d.organization_id
    WHERE ${view === "pending" ? sql`x.status = 'pending'` : sql`x.status <> 'pending'`}
      AND (${dealId ?? null}::uuid IS NULL OR x.deal_id = ${dealId ?? null}::uuid)
    ORDER BY ${view === "pending" ? sql`x.created_at` : sql`coalesce(x.executed_at, x.decided_at, x.created_at) DESC`}
    LIMIT ${limit}`;
}

export async function countPending(): Promise<number> {
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM automation_actions WHERE status = 'pending'`;
  return n;
}

export type RuleStats = { rule_id: string; decided: number; approved: number; auto_done: number; undone: number; pending: number };

/** Últimos 90 días: cuánto se aprueba y cuánto se deshace, para ajustar la autonomía. */
export async function ruleStats(): Promise<Map<string, RuleStats>> {
  const rows = await sql<RuleStats[]>`
    SELECT rule_id,
           count(*) FILTER (WHERE mode = 'ask' AND status IN ('done', 'dismissed', 'undone'))::int AS decided,
           count(*) FILTER (WHERE mode = 'ask' AND status IN ('done', 'undone'))::int AS approved,
           count(*) FILTER (WHERE mode = 'auto' AND status IN ('done', 'undone'))::int AS auto_done,
           count(*) FILTER (WHERE status = 'undone')::int AS undone,
           count(*) FILTER (WHERE status = 'pending')::int AS pending
    FROM automation_actions
    WHERE rule_id IS NOT NULL AND created_at > now() - interval '90 days'
    GROUP BY rule_id`;
  return new Map(rows.map((r) => [r.rule_id, r]));
}

/** Sugerencia para subir o bajar la autonomía de una regla según el uso. */
export function autonomySuggestion(rule: Rule, s: RuleStats | undefined): string | null {
  if (!s) return null;
  if (rule.autonomy === "ask" && rule.allowed_autonomy.includes("auto") && s.decided >= 10) {
    const rate = s.approved / s.decided;
    if (rate >= 0.9) return `Apruebas el ${Math.round(rate * 100)} % de sus propuestas: podrías dejar que lo haga sola.`;
  }
  if (rule.autonomy === "auto" && s.auto_done >= 5 && s.undone / s.auto_done >= 0.2) {
    return `Has deshecho ${s.undone} de ${s.auto_done} acciones: quizá sea mejor que pregunte antes.`;
  }
  return null;
}
