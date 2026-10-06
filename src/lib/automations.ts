import { z } from "zod";
import type postgres from "postgres";
import { sql, json } from "./db";
import { AI_ACTOR, UI_ACTOR, recordEvent, type Actor } from "./events";
import { completeActivity, createActivity } from "./activities";
import { createNote } from "./notes";
import { moveDealToStage } from "./deals";
import { UserError } from "./errors";
import { activityLabel, isSessionType, money } from "./format";
import { activityTypes } from "./activity-types";
import { optText, optional, parse } from "./validation";
import { hasActiveMailbox, sendEmail, senderFor, slotsText, syncAllMailboxes } from "./mailbox";
import { generate, parseJsonReply } from "./ai";
import { refreshStaleBriefs } from "./briefs";
import { zonedToUtc } from "./slots";
import { sendDueDigests } from "./digest";
import { applyExtraction, extractionFor } from "./deal-agent";
import { bookingPageLink } from "./booking";

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
export type ExecutableAction = "create_task" | "add_note" | "draft_email" | "move_stage" | "update_deal" | "webhook";
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
  { value: "update_deal", label: "Editar deals", help: "Cambiar título, importe, fecha de cierre o responsable." },
  { value: "webhook", label: "Avisar a otras herramientas", help: "Llamar a un webhook (Zapier, Make, Slack, n8n…) con los datos del deal." },
];
export const actionLabel = (t: string) =>
  t === "notify" ? "Pedir una decisión" : ACTION_TYPES.find((a) => a.value === t)?.label ?? t;

export const AGENTS: { value: AgentKind; label: string; help: string }[] = [
  { value: "assistant", label: "Asistente del CRM", help: "Las reglas automáticas y, más adelante, la IA integrada." },
  { value: "external", label: "Agentes externos", help: "Grok Bot u otros agentes conectados por MCP (Ajustes → Agentes externos)." },
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
  is_custom: boolean;
  trigger: CustomTrigger | null;
  action: CustomAction | null;
  created_at: Date;
};

// ---------------------------------------------------------------------------
// Reglas personalizadas: «cuando una actividad de tal tipo se hace (con tal
// resultado) o sigue sin hacerse N días después, haz tal cosa».

export type Outcome = "any" | "held" | "no_show" | "rescheduled" | "cancelled";
/** Condiciones opcionales: solo deals de un pipeline, desde un importe o de un responsable. */
export type RuleFilter = { pipeline_id?: string | null; min_value?: number | null; owner_id?: string | null };
export type CustomTrigger = (
  | { kind: "activity_done"; activity_type: string | null; outcome: Outcome }
  | { kind: "activity_overdue"; activity_type: string | null; days: number }
  | { kind: "deal_stage"; stage_id: string; days: number }
  | { kind: "deal_created"; days: number }
  | { kind: "deal_idle"; days: number }
  | { kind: "deal_won" }
  | { kind: "deal_lost" }
  | { kind: "email_opened" }
  | { kind: "email_received" }
  | { kind: "booked" }
  | { kind: "proposal_viewed" }
  | { kind: "proposal_accepted" }
) & { filter?: RuleFilter };
export type CustomAction =
  | { kind: "create_activity"; activity_type: string; subject: string; due_in_days: number; note: string | null }
  | { kind: "draft_email"; subject: string; body: string }
  | { kind: "move_stage"; stage_id: string }
  | { kind: "notify"; message: string }
  | { kind: "add_note"; content: string }
  | { kind: "assign_owner"; owner_id: string }
  | { kind: "webhook"; url: string };

const CUSTOM_ACTION: Record<CustomAction["kind"], ActionType> = {
  create_activity: "create_task", draft_email: "draft_email", move_stage: "move_stage", notify: "notify",
  add_note: "add_note", assign_owner: "update_deal", webhook: "webhook",
};

/** Qué tipo de acción produce una regla (de serie o personalizada). */
export function ruleAction(rule: Pick<Rule, "key" | "is_custom" | "action">): ActionType | undefined {
  return rule.is_custom && rule.action ? CUSTOM_ACTION[rule.action.kind] : RULE_ACTION[rule.key];
}

/** Qué acción produce cada regla incluida. */
export const RULE_ACTION: Record<string, ActionType> = {
  won_handoff_email: "draft_email",
  meeting_recap: "draft_email",
  advance_after_session: "move_stage",
  offer_session_slots: "draft_email",
  missing_stage_session: "create_task",
  stale_deal_followup: "draft_email",
  no_show_rebook: "draft_email",
  stale_deal_escalate: "notify",
  won_handoff: "create_task",
  inbound_first_reply: "draft_email",
  call_next_steps: "create_task",
  call_deal_update: "update_deal",
  multithread: "create_task",
  close_date_past: "update_deal",
  proposal_stage: "move_stage",
};

type ParamSpec = { key: string; label: string; kind: "days" | "number" | "text" | "textarea" | "email"; help?: string; optional?: boolean };

/** Parámetros ajustables de cada regla. */
export const RULE_PARAMS: Record<string, ParamSpec[]> = {
  won_handoff_email: [
    { key: "cs_email", label: "Email de Customer Success por defecto", kind: "email", optional: true,
      help: "Se usa cuando la empresa no tiene su propio responsable de CS (en la ficha de la empresa)." },
    { key: "cs_name", label: "Nombre para el saludo", kind: "text", optional: true, help: "Por ejemplo «equipo» o el nombre de la persona." },
    { key: "subject", label: "Asunto", kind: "text" },
    { key: "body", label: "Texto", kind: "textarea", help: "Puedes usar {deal}, {empresa}, {cs_nombre}, {responsable}, {resumen} (el resumen del traspaso) y {enlace} (la ficha en el CRM)." },
  ],
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
  inbound_first_reply: [
    { key: "max_age_hours", label: "Solo leads de las últimas (horas)", kind: "number" },
    { key: "subject", label: "Asunto", kind: "text" },
    { key: "body", label: "Texto", kind: "textarea", help: "Puedes usar {nombre}, {empresa}, {responsable}, {enlace_reserva} (tu página de reservas) y {huecos} (tus próximos huecos libres)." },
  ],
  multithread: [
    { key: "min_age_days", label: "Días desde que se creó el deal", kind: "days" },
    { key: "cooldown_days", label: "No repetir antes de (días)", kind: "days" },
  ],
  close_date_past: [
    { key: "push_days", label: "Nueva fecha: dentro de (días)", kind: "days" },
    { key: "cooldown_days", label: "No repetir antes de (días)", kind: "days" },
  ],
};

export async function listRules(): Promise<Rule[]> {
  return sql<Rule[]>`
    SELECT id, key, name, description, autonomy, allowed_autonomy, params, position, is_custom, trigger, action, created_at
    FROM automation_rules ORDER BY is_custom, position, name`;
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
  const action = ruleAction(rule);
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
    } else if (spec.kind === "email") {
      const s = String(raw).trim().toLowerCase();
      if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new UserError(`«${spec.label}» no es un email válido.`);
      next[spec.key] = s;
    } else {
      const s = String(raw).trim();
      if (!s && spec.optional) { next[spec.key] = ""; continue; }
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
  /** El deal (o el lead, si `subject` es «lead») sobre el que actúa. */
  dealId: string;
  subject?: "lead";
  title: string;
  reason: string;
  payload: Record<string, unknown> & { stage_id?: string; activity_id?: string; once_key?: string };
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
  /** Resumen de traspaso a CS de un deal (con IA si está configurada), una vez por revisión. */
  handoffFor: (dealId: string) => Promise<HandoffSummary | null>;
};

type HandoffSummary = NonNullable<Awaited<ReturnType<typeof handoffSummary>>> & { ai: boolean };

export async function buildContext(): Promise<RunContext> {
  const [rules, permissions, mailbox] = await Promise.all([listRules(), listPermissions(), hasActiveMailbox()]);
  const cache = new Map<string, Promise<string>>();
  const handoffs = new Map<string, Promise<HandoffSummary | null>>();
  return {
    rules, permissions, mailbox,
    handoffFor(dealId) {
      if (!handoffs.has(dealId)) {
        handoffs.set(dealId, (async () => {
          const summary = await handoffSummary(dealId);
          if (!summary) return null;
          // Con IA, el resumen lo redacta el modelo; los datos de siempre quedan debajo.
          const ai = await generate("handoff", { datos_del_deal: summary.text });
          return ai ? { ...summary, text: `${ai}\n\n— Datos del CRM —\n${summary.text}`.slice(0, 4900), ai: true } : { ...summary, ai: false };
        })());
      }
      return handoffs.get(dealId)!;
    },
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
  return renderTemplates(ctx, ownerId, vars, str(rule.params.subject, defaults.subject), str(rule.params.body, defaults.body));
}

async function renderTemplates(ctx: RunContext, ownerId: string | null, vars: Record<string, string>, subjectT: string, bodyT: string) {
  const all = { ...vars };
  if (bodyT.includes("{huecos}") || subjectT.includes("{huecos}")) all.huecos = await ctx.slotsFor(ownerId);
  return { subject: renderTemplate(subjectT, all), body: renderTemplate(bodyT, all) };
}

/** Las condiciones del deal que piden una sesión sin agendar. */
const missingSession = (grace: number) => sql`
  ods.required_activity_type IS NOT NULL AND NOT ods.has_upcoming_session AND ods.days_in_stage >= ${grace}`;

const SCANNERS: Record<string, Scanner> = {
  // Lead nuevo de la web que encaja (o sin perfil): primer correo en minutos.
  async inbound_first_reply(rule, ctx) {
    if (!ctx.mailbox) return [];
    const hours = num(rule.params.max_age_hours, 72);
    const rows = await sql<{ id: string; person_id: string; full_name: string; email: string; owner_id: string | null; owner_name: string | null;
                             organization: string | null; fit: string | null; fit_reason: string | null; source: string | null }[]>`
      SELECT l.id, p.id AS person_id, p.full_name, pe.email, l.owner_id, u.name AS owner_name, o.name AS organization, l.fit, l.fit_reason, l.source
      FROM leads l JOIN persons p ON p.id = l.person_id AND p.deleted_at IS NULL AND p.unsubscribed_at IS NULL
      JOIN LATERAL (SELECT email FROM person_emails WHERE person_id = p.id AND bounced_at IS NULL ORDER BY is_primary DESC LIMIT 1) pe ON true
      LEFT JOIN organizations o ON o.id = l.organization_id LEFT JOIN users u ON u.id = l.owner_id
      WHERE l.status = 'open' AND l.deleted_at IS NULL AND l.created_at > now() - make_interval(hours => ${hours})
        AND l.qualified_at IS NOT NULL AND l.fit IS DISTINCT FROM 'no_fit'
        AND EXISTS (SELECT 1 FROM events ev WHERE ev.entity_type = 'lead' AND ev.entity_id = l.id AND ev.event_type = 'lead.form_submitted'
                      AND ev.actor_type = 'integration')
        AND NOT EXISTS (SELECT 1 FROM emails m WHERE m.person_id = p.id AND m.direction = 'out' AND m.status IN ('sent', 'scheduled', 'sending'))
        AND NOT EXISTS (SELECT 1 FROM campaign_contacts cc WHERE cc.person_id = p.id)
      LIMIT 100`;
    const out: Candidate[] = [];
    for (const l of rows) {
      const link = await bookingPageLink(l.owner_id);
      const vars = { nombre: firstName(l.full_name), empresa: l.organization ?? "vosotros", responsable: l.owner_name ?? "", enlace_reserva: link ?? "{huecos}" };
      const subjectT = str(rule.params.subject, "Gracias por escribirnos, {nombre}");
      const bodyT = str(rule.params.body, "Hola {nombre},\n\nGracias por escribirnos. Para entender bien lo que necesitáis y ver cómo podemos ayudaros, ¿te va bien una llamada de 20 minutos? Puedes elegir el hueco que mejor te venga aquí:\n\n{enlace_reserva}\n\nUn saludo,\n{responsable}");
      const first = { subject: renderTemplate(subjectT, vars), body: renderTemplate(bodyT, vars) };
      const all = await renderTemplates(ctx, l.owner_id, {}, first.subject, first.body);
      out.push({
        dealId: l.id, subject: "lead",
        title: `Responder a ${l.full_name}${l.organization ? ` (${l.organization})` : ""}`,
        reason: `Lead nuevo ${l.source ? `de «${l.source}» ` : ""}sin respuesta todavía. ${l.fit === "fit" ? l.fit_reason ?? "Encaja con el perfil." : l.fit_reason ?? ""}`.trim(),
        payload: { to: l.email, to_name: l.full_name, person_id: l.person_id, owner_id: l.owner_id, subject: all.subject, body: all.body },
      });
    }
    return out;
  },

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
      -- «nada agendado»: ninguna sesión con el cliente por delante (una tarea interna no cuenta)
      AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.deal_id = ods.id AND NOT a.done AND a.due_at >= now()
                        AND a.type IN (SELECT key FROM activity_types WHERE is_session))
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
  // Deal con un solo contacto: a quién más implicar de la empresa.
  async multithread(rule) {
    const minAge = num(rule.params.min_age_days, 7);
    const rows = await sql<{ id: string; title: string; owner_id: string | null; organization_id: string | null; org: string | null;
                             only_person: string | null; contacts: number }[]>`
      SELECT ods.id, ods.title, ods.owner_id, ods.organization_id, o.name AS org,
             (SELECT p.full_name FROM deal_participants dp JOIN persons p ON p.id = dp.person_id WHERE dp.deal_id = ods.id LIMIT 1) AS only_person,
             (SELECT count(*)::int FROM deal_participants dp WHERE dp.deal_id = ods.id) AS contacts
      FROM open_deals_status ods JOIN deals d ON d.id = ods.id LEFT JOIN organizations o ON o.id = ods.organization_id
      WHERE d.created_at < now() - make_interval(days => ${minAge})
        AND (SELECT count(*) FROM deal_participants dp WHERE dp.deal_id = ods.id) <= 1
      LIMIT 300`;
    const out: Candidate[] = [];
    for (const d of rows) {
      const [c] = d.organization_id ? await sql<{ id: string; full_name: string; job_title: string | null }[]>`
        SELECT p.id, p.full_name, po.job_title FROM person_organizations po JOIN persons p ON p.id = po.person_id AND p.deleted_at IS NULL
        WHERE po.organization_id = ${d.organization_id} AND po.status = 'current'
          AND NOT EXISTS (SELECT 1 FROM deal_participants dp WHERE dp.deal_id = ${d.id} AND dp.person_id = p.id)
        ORDER BY (po.job_title ~* '(ceo|cto|cfo|coo|director|directora|head|jefe|jefa|gerente|founder|fundador|vp|chief|socio|socia)') DESC, p.created_at
        LIMIT 1` : [];
      out.push(c ? {
        dealId: d.id, title: `Implicar a ${c.full_name}${c.job_title ? ` (${c.job_title})` : ""} en «${d.title}»`,
        reason: d.contacts === 0 ? "El deal no tiene ningún contacto." : `Solo hay un contacto (${d.only_person}): si esa persona se va o se enfría, el deal se para.`,
        payload: { type: "task", subject: `Implicar a ${c.full_name} en «${d.title}»`, person_id: c.id, owner_id: d.owner_id, due_in_days: 2,
                   note: `${c.full_name}${c.job_title ? `, ${c.job_title},` : ""} también está en ${d.org}. Preséntate, cuéntale el proyecto o pide a ${d.only_person ?? "tu contacto"} que os presente.` },
      } : {
        dealId: d.id, title: `Identificar al decisor de ${d.org ?? "la empresa"} para «${d.title}»`,
        reason: d.contacts === 0 ? "El deal no tiene ningún contacto y no conocemos a nadie en la empresa." : `Solo hay un contacto (${d.only_person}) y no conocemos a nadie más en la empresa.`,
        payload: { type: "task", subject: `Identificar al decisor y a quien firma en ${d.org ?? d.title}`, owner_id: d.owner_id, due_in_days: 3,
                   note: "Pregunta quién más participa en la decisión (decisor, usuarios, compras) y añádelos al deal." },
      });
    }
    return out;
  },

  // Fecha de cierre ya pasada con el deal abierto: proponer una realista.
  async close_date_past(rule) {
    const push = num(rule.params.push_days, 14);
    const rows = await sql<{ id: string; title: string; expected_close_date: string }[]>`
      SELECT ods.id, ods.title, d.expected_close_date::text FROM open_deals_status ods JOIN deals d ON d.id = ods.id
      WHERE d.expected_close_date < current_date LIMIT 300`;
    const target = new Date(Date.now() + push * 86400000).toISOString().slice(0, 10);
    return rows.map((d) => ({
      dealId: d.id,
      title: `Mover el cierre de «${d.title}» al ${dateText(new Date(`${target}T12:00:00`))}`,
      reason: `La fecha de cierre prevista (${dateText(new Date(`${d.expected_close_date}T12:00:00`))}) ya pasó y el deal sigue abierto: la previsión no es real. Cambia la fecha propuesta si sabes una mejor.`,
      payload: { changes: { expected_close_date: target }, once_key: `close:${d.expected_close_date}` },
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
      if (!a || !isSessionType(a.type)) return null;
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

  // Deal ganado: el resumen del traspaso, por correo al responsable de CS.
  won_handoff_email: {
    events: ["deal.won"],
    async handle(rule, e, ctx) {
      const [d] = await sql<{ title: string; organization_name: string | null; cs_manager_name: string | null; cs_manager_email: string | null;
                             owner_id: string | null; owner_name: string | null }[]>`
        SELECT d.title, o.name AS organization_name, o.cs_manager_name, o.cs_manager_email, d.owner_id, u.name AS owner_name
        FROM deals d LEFT JOIN organizations o ON o.id = d.organization_id LEFT JOIN users u ON u.id = d.owner_id
        WHERE d.id = ${e.entity_id} AND d.status = 'won'`;
      if (!d) return null;
      const fromCompany = Boolean(d.cs_manager_email);
      const to = d.cs_manager_email || str(rule.params.cs_email, "");
      if (!to) return null; // sin dirección de CS no hay a quién enviarlo (se avisa en Ajustes)
      const summary = await ctx.handoffFor(e.entity_id);
      if (!summary) return null;
      const csName = (fromCompany ? d.cs_manager_name : null) || str(rule.params.cs_name, "") || "equipo";
      const vars = {
        deal: d.title, empresa: d.organization_name ?? "sin empresa", cs_nombre: csName, responsable: d.owner_name ?? "",
        resumen: summary.text, enlace: `${(process.env.APP_URL || "").replace(/\/$/, "")}/deals/${e.entity_id}`,
      };
      const subjectT = str(rule.params.subject, "Nuevo cliente: {empresa} — {deal}");
      const bodyT = str(rule.params.body, "Hola {cs_nombre},\n\n{resumen}\n\n{enlace}");
      return {
        dealId: e.entity_id,
        title: `Enviar el traspaso de «${d.title}» a Customer Success`,
        reason: `Deal ganado. Destinatario: ${fromCompany ? `${d.cs_manager_name ?? to}, responsable de CS de ${d.organization_name}` : "la dirección de CS por defecto"}.${summary.ai ? " Resumen redactado por la IA." : ""}`,
        payload: {
          to, to_name: fromCompany ? d.cs_manager_name : str(rule.params.cs_name, "") || null, person_id: null,
          subject: renderTemplate(subjectT, vars), body: renderTemplate(bodyT, vars),
        },
      };
    },
    stillValid: () => sql`d.status = 'won'`,
  },

  won_handoff: {
    events: ["deal.won"],
    async handle(rule, e, ctx) {
      const summary = await ctx.handoffFor(e.entity_id);
      if (!summary) return null;
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
  // Tras una reunión: tareas con los próximos pasos acordados (con la IA).
  call_next_steps: {
    events: ["activity.completed"],
    async handle(_rule, e) {
      if (typeof e.payload.activity_id !== "string" || (e.payload.outcome && e.payload.outcome !== "held")) return null;
      const [a] = await sql<{ deal_id: string | null; subject: string; owner_id: string | null; person_id: string | null }[]>`
        SELECT a.deal_id, a.subject, coalesce(a.owner_id, d.owner_id) AS owner_id, a.person_id FROM activities a
        JOIN deals d ON d.id = a.deal_id AND d.status = 'open' WHERE a.id = ${e.payload.activity_id}
          AND a.type IN (SELECT key FROM activity_types WHERE is_session)`;
      if (!a?.deal_id) return null;
      const x = await extractionFor(e.payload.activity_id);
      if (!x) return null;
      await applyExtraction(a.deal_id, x, `reunion:${e.payload.activity_id}`);
      if (x.proximos_pasos.length === 0) return null;
      const first = x.proximos_pasos[0];
      const many = x.proximos_pasos.length > 1;
      return {
        dealId: a.deal_id,
        title: many ? `Próximos pasos tras «${a.subject}» (${x.proximos_pasos.length})` : first.tarea,
        reason: `Acordado en «${a.subject}» según la transcripción o tus notas.`,
        payload: {
          activity_id: e.payload.activity_id, type: "task", owner_id: a.owner_id, person_id: a.person_id,
          subject: many ? `Próximos pasos tras «${a.subject}»` : first.tarea,
          note: x.proximos_pasos.map((p) => `- ${p.tarea} (en ${p.en_dias} día${p.en_dias === 1 ? "" : "s"})`).join("\n"),
          due_in_days: Math.min(...x.proximos_pasos.map((p) => p.en_dias)),
        },
      };
    },
    stillValid: () => sql`d.status = 'open'`,
  },

  // Tras una reunión: importe y fecha de cierre según lo hablado (con la IA).
  call_deal_update: {
    events: ["activity.completed"],
    async handle(_rule, e) {
      if (typeof e.payload.activity_id !== "string" || (e.payload.outcome && e.payload.outcome !== "held")) return null;
      const [d] = await sql<{ id: string; title: string; value: string | null; expected_close_date: string | null; subject: string; lines: number }[]>`
        SELECT d.id, d.title, d.value::text, d.expected_close_date::text, a.subject,
               (SELECT count(*)::int FROM deal_products dp WHERE dp.deal_id = d.id) AS lines
        FROM activities a JOIN deals d ON d.id = a.deal_id AND d.status = 'open'
        WHERE a.id = ${e.payload.activity_id} AND a.type IN (SELECT key FROM activity_types WHERE is_session)`;
      if (!d) return null;
      const x = await extractionFor(e.payload.activity_id);
      if (!x) return null;
      const changes: Record<string, unknown> = {};
      const why: string[] = [];
      // Con productos, el importe es la suma de las líneas: no se toca.
      if (x.importe_estimado && d.lines === 0 && Math.abs(x.importe_estimado - Number(d.value ?? 0)) >= Math.max(500, Number(d.value ?? 0) * 0.1)) {
        changes.value = x.importe_estimado;
        why.push(`importe ${money(d.value)} → ${money(String(x.importe_estimado))}${x.presupuesto ? ` («${x.presupuesto}»)` : ""}`);
      }
      if (x.fecha_cierre && x.fecha_cierre !== d.expected_close_date && new Date(`${x.fecha_cierre}T12:00:00`) > new Date()) {
        changes.expected_close_date = x.fecha_cierre;
        why.push(`cierre ${d.expected_close_date ? dateText(new Date(`${d.expected_close_date}T12:00:00`)) : "sin fecha"} → ${dateText(new Date(`${x.fecha_cierre}T12:00:00`))}${x.plazo ? ` («${x.plazo}»)` : ""}`);
      }
      if (why.length === 0) return null;
      return {
        dealId: d.id, title: `Actualizar «${d.title}»: ${why.map((w) => w.split(" (")[0].split(" («")[0]).join(" y ")}`,
        reason: `En «${d.subject}» se habló de ${why.join("; ")}.`,
        payload: { activity_id: e.payload.activity_id, changes },
      };
    },
    stillValid: () => sql`d.status = 'open'`,
  },

  // El cliente abrió la propuesta y el deal sigue en una fase anterior.
  proposal_stage: {
    events: ["proposal.viewed"],
    async handle(_rule, e) {
      const [x] = await sql<{ id: string; title: string; stage_name: string; to_id: string | null; to_name: string | null; from_id: string }[]>`
        SELECT d.id, d.title, s.name AS stage_name, t.id AS to_id, t.name AS to_name, s.id AS from_id
        FROM deals d JOIN stages s ON s.id = d.stage_id
        LEFT JOIN LATERAL (SELECT id, name FROM stages WHERE pipeline_id = d.pipeline_id AND is_active AND position > s.position
                             AND name ILIKE '%propuesta%' ORDER BY position LIMIT 1) t ON true
        WHERE d.id = ${e.entity_id} AND d.status = 'open' AND s.name NOT ILIKE '%propuesta%'`;
      if (!x?.to_id) return null;
      return {
        dealId: x.id, title: `Pasar «${x.title}» a «${x.to_name}»`,
        reason: `El cliente ya ha abierto la propuesta y el deal sigue en «${x.stage_name}».`,
        payload: { stage_id: x.to_id, stage_name: x.to_name, from_stage_id: x.from_id, once_key: `proposal:${String(e.payload.proposal_id ?? "")}` },
      };
    },
    stillValid: () => sql`d.status = 'open' AND d.stage_id::text = x.payload->>'from_stage_id'`,
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

// ---------------------------------------------------------------------------
// Motor de las reglas personalizadas

type TriggerActivity = { id: string; deal_id: string; type: string; subject: string; due_at: Date | null; person_id: string | null };

/** Deal (abierto o cerrado) con su contacto principal, para las reglas que no se limitan a deals abiertos. */
async function anyDeal(dealId: string) {
  const [d] = await sql<(DealContact & { pipeline_id: string; value: string | null; status: string; organization_name: string | null })[]>`
    SELECT d.id, d.title, d.stage_id, s.name AS stage_name, floor(extract(epoch FROM now() - d.stage_entered_at) / 86400)::int AS days_in_stage,
           s.rotten_after_days, s.required_activity_type, d.owner_id, u.name AS owner_name,
           pc.person_id, pc.full_name AS person_name, pc.email, d.pipeline_id, d.value::text, d.status, o.name AS organization_name
    FROM deals d
    JOIN stages s ON s.id = d.stage_id
    LEFT JOIN users u ON u.id = d.owner_id
    LEFT JOIN organizations o ON o.id = d.organization_id
    LEFT JOIN LATERAL (
      SELECT p.id AS person_id, p.full_name,
             (SELECT e.email FROM person_emails e WHERE e.person_id = p.id ORDER BY e.is_primary DESC, e.created_at LIMIT 1) AS email
      FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
      WHERE dp.deal_id = d.id AND p.deleted_at IS NULL AND p.unsubscribed_at IS NULL
      ORDER BY dp.is_primary DESC, dp.created_at LIMIT 1
    ) pc ON true
    WHERE d.id = ${dealId} AND d.deleted_at IS NULL`;
  return d ?? null;
}

/** ¿Cumple el deal las condiciones de la regla? */
function matchesFilter(f: RuleFilter | undefined, d: { pipeline_id: string; value: string | null; owner_id: string | null }) {
  if (!f) return true;
  if (f.pipeline_id && d.pipeline_id !== f.pipeline_id) return false;
  if (f.owner_id && d.owner_id !== f.owner_id) return false;
  if (f.min_value != null && Number(d.value ?? 0) < f.min_value) return false;
  return true;
}

type Source = { dealId: string; personId?: string | null; activity?: TriggerActivity; onceKey?: string };

/** Lo que hace la regla personalizada sobre el deal que la disparó. */
async function customCandidate(rule: Rule, ctx: RunContext, src: Source, why: string): Promise<Candidate | null> {
  const action = rule.action;
  if (!action) return null;
  const d = await anyDeal(src.dealId);
  if (!d || !matchesFilter(rule.trigger?.filter, d)) return null;
  const open = d.status === "open";
  // Mover de fase solo tiene sentido con el deal abierto; el resto sirve también tras ganar o perder.
  if (!open && action.kind === "move_stage") return null;
  const to = await contactFor(src.personId ?? src.activity?.person_id ?? null, d);
  const act = src.activity;
  const vars = {
    deal: d.title, nombre: firstName(to.name), responsable: d.owner_name ?? "", empresa: d.organization_name ?? "",
    fase: d.stage_name, actividad: act?.subject ?? "", tipo: act ? activityLabel(act.type).toLowerCase() : "",
    sesion: act ? activityLabel(act.type).toLowerCase() : "",
  };
  const base: { activity_id?: string; once_key?: string } = act ? { activity_id: act.id } : src.onceKey ? { once_key: src.onceKey } : {};
  switch (action.kind) {
    case "create_activity": {
      const subject = renderTemplate(action.subject, vars).slice(0, 300);
      return {
        dealId: d.id, reason: why,
        title: `${activityLabel(action.activity_type)}: ${subject}`,
        payload: { ...base, type: action.activity_type, subject, note: action.note ? renderTemplate(action.note, vars) : null,
                   due_in_days: action.due_in_days, person_id: to.person_id, owner_id: d.owner_id },
      };
    }
    case "draft_email": {
      if (!to.email) return null;
      return {
        dealId: d.id, reason: why,
        title: `Escribir a ${to.name}: ${renderTemplate(action.subject, vars)}`.slice(0, 300),
        payload: { ...base, to: to.email, to_name: to.name, person_id: to.person_id,
                   ...(await renderTemplates(ctx, d.owner_id, vars, action.subject, action.body)) },
      };
    }
    case "move_stage": {
      const [st] = await sql<{ name: string; pipeline_id: string; is_active: boolean }[]>`
        SELECT name, pipeline_id, is_active FROM stages WHERE id = ${action.stage_id}`;
      // Solo si la fase es de su pipeline y no está ya en ella.
      if (!st?.is_active || st.pipeline_id !== d.pipeline_id || d.stage_id === action.stage_id) return null;
      return {
        dealId: d.id, reason: why, title: `Pasar «${d.title}» a «${st.name}»`,
        payload: { ...base, stage_id: action.stage_id, stage_name: st.name, from_stage_id: d.stage_id },
      };
    }
    case "notify":
      return { dealId: d.id, reason: why, title: renderTemplate(action.message, vars).slice(0, 300), payload: base };
    case "add_note": {
      const content = renderTemplate(action.content, vars).slice(0, 5000);
      return { dealId: d.id, reason: why, title: `Nota en «${d.title}»: ${content.slice(0, 120)}`, payload: { ...base, content } };
    }
    case "assign_owner": {
      if (d.owner_id === action.owner_id) return null;
      const [u] = await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${action.owner_id} AND is_active AND kind = 'human'`;
      if (!u) return null;
      return {
        dealId: d.id, reason: why, title: `Asignar «${d.title}» a ${u.name}`,
        payload: { ...base, changes: { owner_id: action.owner_id }, owner_name: u.name },
      };
    }
    case "webhook":
      return {
        dealId: d.id, reason: why, title: `Avisar a ${hostOf(action.url)} de «${d.title}»`,
        payload: { ...base, url: action.url, event: rule.trigger?.kind ?? null, rule_name: rule.name },
      };
  }
}

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return "un webhook"; } };

const OUTCOME_TEXT: Record<string, string> = { held: "realizada", no_show: "no se presentó", rescheduled: "reprogramada", cancelled: "cancelada" };

/** Disparadores con evento: actividad hecha, deal ganado/perdido, correo abierto o respondido, reunión reservada. */
const CUSTOM_EVENTS: Partial<Record<CustomTrigger["kind"], string>> = {
  activity_done: "activity.completed", deal_won: "deal.won", deal_lost: "deal.lost",
  email_opened: "email.opened", email_received: "email.received", booked: "deal.booked",
  proposal_viewed: "proposal.viewed", proposal_accepted: "proposal.accepted",
};

function customEventHandler(kind: CustomTrigger["kind"]): EventHandler | undefined {
  const event = CUSTOM_EVENTS[kind];
  if (!event) return undefined;
  return {
    events: [event],
    async handle(rule, e, ctx) {
      const t = rule.trigger;
      if (!t || t.kind !== kind) return null;
      // Solo lo que pase después de crear la regla.
      if (new Date(e.occurred_at) < new Date(rule.created_at)) return null;
      if (t.kind === "activity_done") {
        if (typeof e.payload.activity_id !== "string") return null;
        const outcome = (e.payload.outcome as string | null) ?? null;
        if (t.outcome !== "any" && outcome !== t.outcome) return null;
        const [a] = await sql<TriggerActivity[]>`
          SELECT id, deal_id, type, subject, due_at, person_id FROM activities WHERE id = ${e.payload.activity_id} AND deal_id IS NOT NULL`;
        if (!a || (t.activity_type && a.type !== t.activity_type)) return null;
        return customCandidate(rule, ctx, { dealId: a.deal_id, activity: a },
          `Se marcó «${a.subject}» como hecha${outcome ? ` (${OUTCOME_TEXT[outcome] ?? outcome})` : ""}.`);
      }
      const why: Record<string, string> = {
        deal_won: "El deal se ha ganado.", deal_lost: `El deal se ha perdido${e.payload.reason ? ` («${e.payload.reason}»)` : ""}.`,
        email_opened: "El contacto ha abierto tu correo.", email_received: `El contacto ha respondido${e.payload.subject ? `: «${e.payload.subject}»` : ""}.`,
        booked: "El contacto ha reservado una reunión desde tu enlace.",
        proposal_viewed: "El cliente ha abierto la propuesta.",
        proposal_accepted: `El cliente ha aceptado la propuesta${e.payload.name ? ` (${e.payload.name})` : ""}.`,
      };
      return customCandidate(rule, ctx, { dealId: e.entity_id, personId: (e.payload.person_id as string | null) ?? null, onceKey: `ev:${e.id}` },
        why[t.kind] ?? "Ha ocurrido algo en el deal.");
    },
    // Tras ganar o perder, la propuesta sigue valiendo aunque el deal ya no esté abierto.
    stillValid: () => (kind === "deal_won" || kind === "deal_lost" ? sql`true` : sql`d.status = 'open'`),
  };
}

const days = (n: number) => `${n} día${n === 1 ? "" : "s"}`;

/** Disparadores que se revisan periódicamente. */
const CUSTOM_SCAN: Scanner = async (rule, ctx) => {
  const t = rule.trigger;
  if (!t) return [];
  const out: Candidate[] = [];
  const push = (c: Candidate | null) => { if (c) out.push(c); };
  switch (t.kind) {
    case "activity_overdue": {
      const rows = await sql<TriggerActivity[]>`
        SELECT a.id, a.deal_id, a.type, a.subject, a.due_at, a.person_id
        FROM activities a JOIN deals d ON d.id = a.deal_id AND d.status = 'open' AND d.deleted_at IS NULL
        WHERE NOT a.done AND a.due_at < now() - make_interval(days => ${Math.max(0, Math.round(t.days))})
          AND (${t.activity_type}::text IS NULL OR a.type = ${t.activity_type}::text)
        ORDER BY a.due_at LIMIT 300`;
      for (const a of rows) {
        const late = Math.floor((Date.now() - new Date(a.due_at!).getTime()) / 86400000);
        push(await customCandidate(rule, ctx, { dealId: a.deal_id, activity: a },
          `«${a.subject}» era para el ${dateText(a.due_at)} y sigue sin hacerse (${days(late)}).`));
      }
      break;
    }
    case "deal_stage": {
      // Al entrar en la fase (0 días) o cuando lleva N días en ella; una vez por cada entrada.
      const rows = await sql<{ id: string; stage_entered_at: Date; stage_name: string }[]>`
        SELECT d.id, d.stage_entered_at, s.name AS stage_name FROM deals d JOIN stages s ON s.id = d.stage_id
        WHERE d.stage_id = ${t.stage_id} AND d.status = 'open' AND d.deleted_at IS NULL
          AND d.stage_entered_at <= now() - make_interval(days => ${t.days})
          AND d.stage_entered_at + make_interval(days => ${t.days}) >= ${rule.created_at}
        LIMIT 300`;
      for (const r of rows) {
        push(await customCandidate(rule, ctx, { dealId: r.id, onceKey: `stage:${new Date(r.stage_entered_at).toISOString()}` },
          t.days === 0 ? `El deal ha entrado en «${r.stage_name}».` : `El deal lleva ${days(t.days)} en «${r.stage_name}».`));
      }
      break;
    }
    case "deal_created": {
      const rows = await sql<{ id: string }[]>`
        SELECT d.id FROM deals d
        WHERE d.status = 'open' AND d.deleted_at IS NULL
          AND d.created_at <= now() - make_interval(days => ${t.days})
          AND d.created_at + make_interval(days => ${t.days}) >= ${rule.created_at}
        LIMIT 300`;
      for (const r of rows) {
        push(await customCandidate(rule, ctx, { dealId: r.id, onceKey: "created" },
          t.days === 0 ? "Es un deal nuevo." : `El deal se creó hace ${days(t.days)}.`));
      }
      break;
    }
    case "deal_idle": {
      // Sin nada hecho ni programado en N días: una vez por cada parón.
      const rows = await sql<{ id: string; last_touch: Date }[]>`
        SELECT d.id, greatest(d.created_at, d.stage_entered_at, max(a.done_at), max(a.created_at)) AS last_touch
        FROM deals d LEFT JOIN activities a ON a.deal_id = d.id
        WHERE d.status = 'open' AND d.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM activities p WHERE p.deal_id = d.id AND NOT p.done AND p.due_at >= now())
        GROUP BY d.id
        HAVING greatest(d.created_at, d.stage_entered_at, max(a.done_at), max(a.created_at)) < now() - make_interval(days => ${Math.max(1, t.days)})
        ORDER BY 2 DESC LIMIT 300`;
      for (const r of rows) {
        push(await customCandidate(rule, ctx, { dealId: r.id, onceKey: `idle:${new Date(r.last_touch).toISOString()}` },
          `El deal no tiene movimiento desde el ${dateText(r.last_touch)} ni nada programado.`));
      }
      break;
    }
  }
  return out;
};

const dateText = (d: Date | null) => (d ? new Date(d).toLocaleDateString("es-ES", { day: "numeric", month: "short" }) : "—");

const SCANNED: CustomTrigger["kind"][] = ["activity_overdue", "deal_stage", "deal_created", "deal_idle"];

function scannerFor(rule: Rule): Scanner | undefined {
  if (rule.is_custom) return rule.trigger && SCANNED.includes(rule.trigger.kind) ? CUSTOM_SCAN : undefined;
  return SCANNERS[rule.key];
}
function handlerFor(rule: Rule): EventHandler | undefined {
  if (rule.is_custom) return rule.trigger ? customEventHandler(rule.trigger.kind) : undefined;
  return EVENT_HANDLERS[rule.key];
}

/** Ya se propuso esto hace poco (o la tarea anterior sigue abierta). */
async function coolingDown(rule: Rule, c: Candidate) {
  const days = num(rule.params.cooldown_days, 0);
  const [row] = await sql<{ x: number }[]>`
    SELECT 1 AS x FROM automation_actions x
    WHERE x.rule_id = ${rule.id} AND x.subject_type = ${c.subject ?? "deal"} AND x.subject_id = ${c.dealId}
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
    WHERE rule_id = ${rule.id} AND subject_type = ${c.subject ?? "deal"} AND subject_id = ${c.dealId}
      AND ${c.payload.activity_id
        ? sql`payload->>'activity_id' = ${c.payload.activity_id}`
        : c.payload.once_key
          ? sql`payload->>'once_key' = ${String(c.payload.once_key)}`
          : sql`status IN ('pending', 'done')`}
    LIMIT 1`;
  return Boolean(row);
}

/** Crea la propuesta; si la autonomía es «auto», la ejecuta. */
async function propose(rule: Rule, mode: "ask" | "auto", c: Candidate): Promise<"proposed" | "executed" | "failed" | "exists"> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO automation_actions ${sql({
      actor: "assistant", rule_id: rule.id, subject_type: c.subject ?? "deal", subject_id: c.dealId, deal_id: c.subject === "lead" ? null : c.dealId,
      action_type: ruleAction(rule), title: c.title, reason: c.reason, payload: json(c.payload), mode,
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
  await activityTypes(true);
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

    const scan = scannerFor(rule);
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
        // Las reglas sobre una actividad concreta actúan una vez por actividad.
        if (c.payload.activity_id || c.payload.once_key ? await alreadyHandled(rule, c) : await coolingDown(rule, c)) continue;
        count(await propose(rule, mode, c));
      }
    }

    const handler = handlerFor(rule);
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
      const handler = handlerFor(rule);
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
      const sender = edits.manual === "1" ? null : await senderFor(deal?.owner_id ?? (p.owner_id as string | null | undefined));
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
        owner_id: optional(z.string().regex(/^[0-9a-f-]{36}$/i)),
      }), p.changes ?? {});
      const [before] = await sql<{ title: string; value: string | null; expected_close_date: string | null; owner_id: string | null }[]>`
        SELECT title, value::text, expected_close_date::text, owner_id FROM deals WHERE id = ${a.deal_id} AND deleted_at IS NULL`;
      if (!before) throw new UserError("El deal ya no existe.");
      const set = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
      if (Object.keys(set).length === 0) throw new UserError("La propuesta no cambia nada.");
      await sql`UPDATE deals SET ${sql(set)} WHERE id = ${a.deal_id}`;
      await recordEvent(sql, AI_ACTOR, "deal", a.deal_id, "deal.updated", { changes: set });
      if ("expected_close_date" in set && set.expected_close_date !== before.expected_close_date) {
        await recordEvent(sql, AI_ACTOR, "deal", a.deal_id, "deal.close_date_changed", { from: before.expected_close_date, to: set.expected_close_date });
      }
      return { before: Object.fromEntries(Object.keys(set).map((k) => [k, before[k as keyof typeof before]])) };
    }
    case "webhook": {
      const url = checkWebhookUrl(str(p.url, ""));
      const d = a.deal_id ? await anyDeal(a.deal_id) : null;
      const body = {
        event: p.event ?? null, rule: p.rule_name ?? null, sent_at: new Date().toISOString(),
        deal: d && {
          id: d.id, title: d.title, status: d.status, value: d.value === null ? null : Number(d.value), stage: d.stage_name,
          organization: d.organization_name, owner: d.owner_name, contact: d.person_name, contact_email: d.email,
          url: `${(process.env.APP_URL ?? "").replace(/\/+$/, "")}/deals/${d.id}`,
        },
      };
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST", headers: { "content-type": "application/json", "user-agent": "CRM-webhook/1" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(10000), redirect: "manual",
        });
      } catch {
        throw new UserError(`No se pudo contactar con ${hostOf(url)}.`);
      }
      if (!res.ok) throw new UserError(`${hostOf(url)} respondió con un error (${res.status}).`);
      return { status: res.status, url };
    }
    case "notify":
      return {};
  }
}

/** Solo direcciones públicas por HTTPS (en local también HTTP) para los webhooks. */
export function checkWebhookUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UserError("La dirección del webhook no es válida."); }
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|\[?f[cd])/i.test(u.hostname);
  const prod = process.env.NODE_ENV === "production" && !process.env.ALLOW_PRIVATE_WEBHOOKS;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && !prod)) throw new UserError("El webhook tiene que ser una dirección https://.");
  if (local && prod) throw new UserError("El webhook no puede apuntar a una dirección interna.");
  return u.toString();
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
  a.status === "done" && a.action_type !== "notify" && a.action_type !== "draft_email" && a.action_type !== "webhook" && a.executed_at !== null
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
  lead_id: string | null; lead_title: string | null;
  created_at: Date; decided_at: Date | null; executed_at: Date | null;
};

export async function listActions({ view, dealId, limit = 200 }: { view: "pending" | "log"; dealId?: string; limit?: number }) {
  return sql<InboxItem[]>`
    SELECT x.id, x.actor, x.agent_name, r.key AS rule_key, r.name AS rule_name, x.action_type, x.title, x.reason,
           x.payload, x.status, x.mode, x.result, x.error, x.deal_id, d.title AS deal_title,
           o.name AS organization_name, l.id AS lead_id, l.title AS lead_title, x.created_at, x.decided_at, x.executed_at
    FROM automation_actions x
    LEFT JOIN automation_rules r ON r.id = x.rule_id
    LEFT JOIN deals d ON d.id = x.deal_id
    LEFT JOIN leads l ON x.subject_type = 'lead' AND l.id = x.subject_id
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

// ---------------------------------------------------------------------------
// Alta, edición y borrado de reglas personalizadas

const OUTCOME_LABELS: Record<Outcome, string> = {
  any: "cualquier resultado", held: "Realizada", no_show: "No se presentó", rescheduled: "Reprogramada", cancelled: "Cancelada",
};

/** Descripción legible de una regla personalizada («Cuando… → …»). */
export async function describeCustomRule(trigger: CustomTrigger, action: CustomAction): Promise<string> {
  await activityTypes();
  const stageName = async (id: string) => {
    const [st] = await sql<{ name: string; pipeline: string }[]>`
      SELECT s.name, p.name AS pipeline FROM stages s JOIN pipelines p ON p.id = s.pipeline_id WHERE s.id = ${id}`;
    return st ? `«${st.name}» (${st.pipeline})` : "«?»";
  };
  let when: string;
  switch (trigger.kind) {
    case "activity_done":
    case "activity_overdue": {
      const what = trigger.activity_type ? `una actividad «${activityLabel(trigger.activity_type)}»` : "cualquier actividad";
      when = trigger.kind === "activity_done"
        ? `Cuando ${what} de un deal se marca como hecha${trigger.outcome === "any" ? "" : ` con resultado «${OUTCOME_LABELS[trigger.outcome]}»`}`
        : `Cuando ${what} de un deal sigue sin hacerse ${trigger.days === 0 ? "pasada su fecha" : `${days(trigger.days)} después de su fecha`}`;
      break;
    }
    case "deal_stage":
      when = trigger.days === 0 ? `Cuando un deal entra en ${await stageName(trigger.stage_id)}`
        : `Cuando un deal lleva ${days(trigger.days)} en ${await stageName(trigger.stage_id)}`;
      break;
    case "deal_created": when = trigger.days === 0 ? "Cuando se crea un deal" : `${days(trigger.days)} después de crear un deal`; break;
    case "deal_idle": when = `Cuando un deal lleva ${days(trigger.days)} sin movimiento ni nada programado`; break;
    case "deal_won": when = "Cuando se gana un deal"; break;
    case "deal_lost": when = "Cuando se pierde un deal"; break;
    case "email_opened": when = "Cuando el contacto abre un correo"; break;
    case "email_received": when = "Cuando el contacto responde un correo"; break;
    case "booked": when = "Cuando el contacto reserva una reunión desde tu enlace"; break;
    case "proposal_viewed": when = "Cuando el cliente abre una propuesta"; break;
    case "proposal_accepted": when = "Cuando el cliente acepta una propuesta"; break;
  }
  const f = trigger.filter ?? {};
  const conds: string[] = [];
  if (f.pipeline_id) {
    const [p] = await sql<{ name: string }[]>`SELECT name FROM pipelines WHERE id = ${f.pipeline_id}`;
    conds.push(`del pipeline «${p?.name ?? "?"}»`);
  }
  if (f.min_value != null) conds.push(`de ${f.min_value.toLocaleString("es-ES")} € o más`);
  if (f.owner_id) {
    const [u] = await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${f.owner_id}`;
    conds.push(`de ${u?.name ?? "?"}`);
  }
  if (conds.length) when += ` (solo deals ${conds.join(", ")})`;
  let then: string;
  switch (action.kind) {
    case "create_activity":
      then = `crea «${action.subject}» (${activityLabel(action.activity_type)}) ${action.due_in_days === 0 ? "para el mismo día" : `para dentro de ${days(action.due_in_days)}`}`;
      break;
    case "draft_email": then = `prepara un correo al contacto: «${action.subject}»`; break;
    case "move_stage": then = `mueve el deal a ${await stageName(action.stage_id)}`; break;
    case "notify": then = `te pide una decisión: «${action.message}»`; break;
    case "add_note": then = "deja una nota en el deal"; break;
    case "assign_owner": {
      const [u] = await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${action.owner_id}`;
      then = `asigna el deal a ${u?.name ?? "?"}`;
      break;
    }
    case "webhook": then = `avisa a ${hostOf(action.url)} (webhook)`; break;
  }
  return `${when}, ${then}.`;
}

async function parseCustomRule(data: Record<string, unknown>) {
  const s = (k: string) => String(data[k] ?? "").trim();
  const name = s("name");
  if (!name) throw new UserError("Ponle un nombre a la regla.");
  if (name.length > 120) throw new UserError("El nombre es demasiado largo.");
  const types = await activityTypes(true);
  const typeOrNull = (k: string) => {
    const v = s(k);
    if (!v) return null;
    if (!types.some((t) => t.key === v)) throw new UserError("Tipo de actividad no válido.");
    return v;
  };
  const int = (k: string, label: string, max = 365) => {
    const n = Number(s(k) || "0");
    if (!Number.isInteger(n) || n < 0 || n > max) throw new UserError(`«${label}» debe ser un número de 0 a ${max}.`);
    return n;
  };
  const uuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const stageOf = async (k: string) => {
    const stage = s(k);
    const [st] = uuid(stage) ? await sql`SELECT 1 FROM stages WHERE id = ${stage} AND is_active` : [];
    if (!st) throw new UserError("Elige la fase.");
    return stage;
  };
  const ownerOf = async (k: string) => {
    const v = s(k);
    const [u] = uuid(v) ? await sql`SELECT 1 FROM users WHERE id = ${v} AND kind = 'human' AND is_active` : [];
    if (!u) throw new UserError("Elige a la persona.");
    return v;
  };

  // Condiciones (opcionales).
  const filter: RuleFilter = {};
  if (s("filter_pipeline")) {
    const [p] = uuid(s("filter_pipeline")) ? await sql`SELECT 1 FROM pipelines WHERE id = ${s("filter_pipeline")}` : [];
    if (!p) throw new UserError("Pipeline no válido.");
    filter.pipeline_id = s("filter_pipeline");
  }
  if (s("filter_min_value")) {
    const n = Number(s("filter_min_value").replace(",", "."));
    if (!Number.isFinite(n) || n < 0) throw new UserError("El importe mínimo no es válido.");
    filter.min_value = n;
  }
  if (s("filter_owner")) filter.owner_id = await ownerOf("filter_owner");
  const withFilter = <T extends object>(t: T) => (Object.keys(filter).length ? { ...t, filter } : t);

  let trigger: CustomTrigger;
  switch (s("trigger_kind")) {
    case "activity_done": {
      const outcome = (s("trigger_outcome") || "any") as Outcome;
      if (!(outcome in OUTCOME_LABELS)) throw new UserError("Resultado no válido.");
      trigger = withFilter({ kind: "activity_done" as const, activity_type: typeOrNull("trigger_type"), outcome });
      break;
    }
    case "activity_overdue":
      trigger = withFilter({ kind: "activity_overdue" as const, activity_type: typeOrNull("trigger_type"), days: int("trigger_days", "Días de retraso", 90) });
      break;
    case "deal_stage":
      trigger = withFilter({ kind: "deal_stage" as const, stage_id: await stageOf("trigger_stage"), days: int("trigger_days", "Días en la fase", 365) });
      break;
    case "deal_created":
      trigger = withFilter({ kind: "deal_created" as const, days: int("trigger_days", "Días tras crearlo", 365) });
      break;
    case "deal_idle": {
      const d = int("trigger_days", "Días sin movimiento", 365);
      if (d < 1) throw new UserError("Pon al menos 1 día sin movimiento.");
      trigger = withFilter({ kind: "deal_idle" as const, days: d });
      break;
    }
    case "deal_won": case "deal_lost": case "email_opened": case "email_received": case "booked":
    case "proposal_viewed": case "proposal_accepted":
      trigger = withFilter({ kind: s("trigger_kind") as "deal_won" });
      break;
    default: throw new UserError("Elige cuándo se dispara la regla.");
  }

  let action: CustomAction;
  const text = (k: string, label: string, max: number) => {
    const v = s(k);
    if (!v) throw new UserError(`Falta «${label}».`);
    if (v.length > max) throw new UserError(`«${label}» es demasiado largo.`);
    return v;
  };
  switch (s("action_kind")) {
    case "create_activity": {
      const type = typeOrNull("action_type");
      if (!type) throw new UserError("Elige el tipo de la actividad a crear.");
      action = { kind: "create_activity", activity_type: type, subject: text("action_subject", "Asunto de la actividad", 300),
                 due_in_days: int("action_due_days", "Plazo"), note: s("action_note") || null };
      break;
    }
    case "draft_email":
      action = { kind: "draft_email", subject: text("action_email_subject", "Asunto del correo", 300), body: text("action_email_body", "Texto del correo", 20000) };
      break;
    case "move_stage":
      action = { kind: "move_stage", stage_id: await stageOf("action_stage") };
      break;
    case "notify":
      action = { kind: "notify", message: text("action_message", "Mensaje", 300) };
      break;
    case "add_note":
      action = { kind: "add_note", content: text("action_note_content", "Texto de la nota", 5000) };
      break;
    case "assign_owner":
      action = { kind: "assign_owner", owner_id: await ownerOf("action_owner") };
      break;
    case "webhook":
      action = { kind: "webhook", url: checkWebhookUrl(text("action_url", "Dirección del webhook", 2000)) };
      break;
    default: throw new UserError("Elige qué hace la regla.");
  }
  return { name, trigger, action, description: await describeCustomRule(trigger, action) };
}

export async function createCustomRule(data: Record<string, unknown>) {
  const r = await parseCustomRule(data);
  const autonomy = (["off", "ask", "auto"] as const).find((a) => a === data.autonomy) ?? "ask";
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position, is_custom, trigger, action)
    VALUES (${`custom_${randomKey()}`}, ${r.name}, ${r.description}, ${autonomy}, ARRAY['off', 'ask', 'auto'], '{}'::jsonb,
            (SELECT coalesce(max(position), 0) + 1 FROM automation_rules), true, ${json(r.trigger)}, ${json(r.action)})
    RETURNING id`;
  return row.id;
}

export async function updateCustomRule(ruleId: string, data: Record<string, unknown>) {
  const r = await parseCustomRule(data);
  const res = await sql`
    UPDATE automation_rules SET name = ${r.name}, description = ${r.description}, trigger = ${json(r.trigger)}, action = ${json(r.action)}
    WHERE id = ${ruleId} AND is_custom`;
  if (res.count === 0) throw new UserError("La regla no existe.");
  // Lo pendiente se hizo con la versión anterior de la regla.
  await sql`UPDATE automation_actions SET status = 'expired', decided_at = now() WHERE rule_id = ${ruleId} AND status = 'pending'`;
}

/** Borra la regla; lo que ya hizo queda en el registro, sin regla. */
export async function deleteCustomRule(ruleId: string) {
  await sql.begin(async (tx) => {
    await tx`UPDATE automation_actions SET status = 'expired', decided_at = now() WHERE rule_id = ${ruleId} AND status = 'pending'`;
    await tx`UPDATE automation_actions SET rule_id = NULL WHERE rule_id = ${ruleId}`;
    await tx`DELETE FROM automation_rules WHERE id = ${ruleId} AND is_custom`;
  });
}

const randomKey = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
