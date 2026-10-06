import { sql } from "./db";
import { UserError, toUserMessage } from "./errors";
import { globalSearch } from "./search";
import { getDeal } from "./deals";
import { dealFacts, getDealBrief } from "./briefs";
import { capForMailbox, executeAction, listPermissions, type ExecutableAction } from "./automations";
import { hasActiveMailbox } from "./mailbox";
import { activityTypes } from "./activity-types";
import type { Agent } from "./agents";
import { isId } from "./validation";
import { getHealth } from "./health";
import { getInsights } from "./deal-agent";
import { addContacts, CAMPAIGN_STATUS, listCampaigns } from "./campaigns";
import { listAccounts, recordUsage } from "./accounts";

// ===========================================================================
// Servidor MCP para agentes externos (Grok Bot u otros): consultan el CRM y
// proponen acciones. Lo que proponen pasa por los permisos de «Agentes
// externos» (Ajustes → Automatizaciones): con «Sola» se hace, con «Preguntar»
// queda en la bandeja de la IA para que una persona lo apruebe.
// Protocolo: JSON-RPC 2.0 sobre HTTP (transporte «Streamable HTTP», sin SSE).
// ===========================================================================

type JsonSchema = Record<string, unknown>;
type Tool = { name: string; description: string; inputSchema: JsonSchema; write?: boolean; run: (args: Record<string, unknown>, agent: Agent) => Promise<unknown> };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const needDeal = async (v: unknown) => {
  const id = str(v);
  if (!isId(id)) throw new UserError("deal_id no válido (usa «buscar» o «listar_deals» para obtenerlo).");
  const d = await getDeal(id);
  if (!d) throw new UserError("Ese deal no existe.");
  return d;
};
const appUrl = (path: string) => `${(process.env.APP_URL ?? "").replace(/\/+$/, "")}${path}`;

/** Crea la acción como propuesta de un agente externo; si tiene permiso «Sola», la ejecuta. */
async function propose(agent: Agent, action: ExecutableAction, dealId: string, title: string, reason: string, payload: Record<string, unknown>) {
  if (!agent.can_write) throw new UserError("Esta clave es de solo lectura.");
  const [perms, mailbox] = await Promise.all([listPermissions(), hasActiveMailbox()]);
  const perm = perms.find((p) => p.actor === "external" && p.action_type === action);
  const level = capForMailbox(action, perm?.autonomy ?? "off", mailbox);
  if (level === "off") throw new UserError("Los agentes externos no tienen permiso para esto (Ajustes → Automatizaciones → Agentes externos).");
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO automation_actions ${sql({
      actor: "external", agent_name: agent.name, subject_type: "deal", subject_id: dealId, deal_id: dealId,
      action_type: action, title: title.slice(0, 300), reason: (reason || `Propuesto por ${agent.name}`).slice(0, 1000),
      payload: sql.json(payload as never), mode: level,
    } as unknown as Record<string, never>)}
    RETURNING id`;
  if (level === "ask") {
    return { estado: "pendiente", mensaje: "Queda en la bandeja de la IA para que una persona lo apruebe.", propuesta_id: row.id, enlace: appUrl("/inbox") };
  }
  await executeAction(row.id, { actor: { type: "integration", id: null } });
  const [done] = await sql<{ result: unknown }[]>`SELECT result FROM automation_actions WHERE id = ${row.id}`;
  return { estado: "hecho", propuesta_id: row.id, resultado: done?.result ?? null };
}

const TOOLS: Tool[] = [
  {
    name: "buscar",
    description: "Busca deals, contactos, empresas y leads por nombre, email o empresa. Devuelve sus ids.",
    inputSchema: { type: "object", properties: { texto: { type: "string", description: "Lo que buscar (mínimo 2 letras)" } }, required: ["texto"] },
    run: async (a) => (await globalSearch(str(a.texto), 8)).map((h) => ({ tipo: h.type, id: h.id, nombre: h.title, detalle: h.subtitle, enlace: appUrl(h.href + h.id) })),
  },
  {
    name: "listar_deals",
    description: "Lista deals con su fase, importe, responsable, días en la fase y próxima actividad. Filtros opcionales.",
    inputSchema: {
      type: "object",
      properties: {
        estado: { type: "string", enum: ["open", "won", "lost"], description: "Por defecto, abiertos" },
        pipeline: { type: "string", description: "Nombre del pipeline" },
        responsable: { type: "string", description: "Nombre o email del responsable" },
        parados: { type: "boolean", description: "Solo los que llevan demasiado tiempo en su fase" },
        limite: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    run: async (a) => {
      const estado = ["open", "won", "lost"].includes(str(a.estado)) ? str(a.estado) : "open";
      const limit = Math.min(100, Math.max(1, Math.round(num(a.limite)) || 25));
      const pipeline = str(a.pipeline) || null, owner = str(a.responsable) ? `%${str(a.responsable).toLowerCase()}%` : null;
      return sql`
        SELECT d.id, d.title AS titulo, p.name AS pipeline, s.name AS fase, d.value::float8 AS importe, d.status AS estado,
               u.name AS responsable, floor(extract(epoch FROM now() - d.stage_entered_at) / 86400)::int AS dias_en_fase,
               (d.status = 'open' AND s.rotten_after_days IS NOT NULL AND now() - d.stage_entered_at > make_interval(days => s.rotten_after_days)) AS parado,
               (SELECT min(due_at) FROM activities x WHERE x.deal_id = d.id AND NOT x.done) AS proxima_actividad,
               d.expected_close_date AS cierre_previsto
        FROM deals d JOIN pipelines p ON p.id = d.pipeline_id JOIN stages s ON s.id = d.stage_id LEFT JOIN users u ON u.id = d.owner_id
        WHERE d.deleted_at IS NULL AND d.status = ${estado}
          AND (${pipeline}::text IS NULL OR lower(p.name) = lower(${pipeline}::text))
          AND (${owner}::text IS NULL OR lower(u.name) LIKE ${owner}::text OR lower(coalesce(u.email, '')) LIKE ${owner}::text)
          AND (${a.parados === true} = false OR (s.rotten_after_days IS NOT NULL AND now() - d.stage_entered_at > make_interval(days => s.rotten_after_days)))
        ORDER BY d.updated_at DESC LIMIT ${limit}`;
    },
  },
  {
    name: "ver_deal",
    description: "Todo sobre un deal: datos, contactos, resumen y siguiente paso, actividades pendientes e historia reciente.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
    run: async (a) => {
      const d = await needDeal(a.deal_id);
      const [facts, brief, pending, stages] = await Promise.all([
        d.status === "open" ? dealFacts(d.id) : null,
        d.status === "open" ? getDealBrief(d.id) : null,
        sql`SELECT a.id, a.type AS tipo, a.subject AS asunto, a.due_at AS fecha FROM activities a WHERE a.deal_id = ${d.id} AND NOT a.done ORDER BY a.due_at NULLS LAST LIMIT 10`,
        sql`SELECT name FROM stages WHERE pipeline_id = ${d.pipeline_id} AND is_active ORDER BY position`,
      ]);
      return {
        id: d.id, titulo: d.title, estado: d.status, importe: d.value === null ? null : Number(d.value), moneda: d.currency,
        pipeline: d.pipeline_name, fase: d.stage_name, fases_del_pipeline: stages.map((s) => s.name), empresa: d.organization_name,
        responsable: d.owner_name, cierre_previsto: d.expected_close_date, enlace: appUrl(`/deals/${d.id}`),
        resumen: brief ? { texto: brief.resumen, siguiente_paso: brief.siguiente_paso, por_que: brief.por_que, riesgos: brief.riesgos } : null,
        contactos: facts?.contacts ?? undefined, historia_reciente: facts?.history?.slice(0, 10) ?? undefined, actividades_pendientes: pending,
        salud: await getHealth(d.id).then((h) => h && { puntuacion: h.score, senales: h.signals.map((x) => `${x.tone === "risk" ? "riesgo" : "a favor"}: ${x.label}`) }),
        lo_que_sabemos: await getInsights(d.id),
      };
    },
  },
  {
    name: "resumen_pipeline",
    description: "Cuántos deals e importe hay en cada fase de cada pipeline, y la previsión ponderada.",
    inputSchema: { type: "object", properties: {} },
    run: async () => sql`
      SELECT p.name AS pipeline, s.name AS fase, s.win_probability AS probabilidad, count(d.id)::int AS deals,
             coalesce(sum(d.value), 0)::float8 AS importe, coalesce(sum(d.value * coalesce(s.win_probability, 0) / 100.0), 0)::float8 AS ponderado
      FROM pipelines p JOIN stages s ON s.pipeline_id = p.id AND s.is_active
      LEFT JOIN deals d ON d.stage_id = s.id AND d.status = 'open' AND d.deleted_at IS NULL
      WHERE p.is_active GROUP BY p.id, p.name, p.position, s.id, s.name, s.position, s.win_probability
      ORDER BY p.position, s.position`,
  },
  {
    name: "bandeja",
    description: "Propuestas de la IA y de agentes pendientes de que una persona las apruebe.",
    inputSchema: { type: "object", properties: {} },
    run: async () => sql`
      SELECT x.id, x.title AS propuesta, x.reason AS motivo, x.action_type AS tipo, coalesce(x.agent_name, 'IA del CRM') AS quien,
             d.title AS deal, x.created_at AS fecha
      FROM automation_actions x LEFT JOIN deals d ON d.id = x.deal_id WHERE x.status = 'pending' ORDER BY x.created_at DESC LIMIT 50`,
  },
  {
    name: "proponer_tarea",
    write: true,
    description: "Crea (o propone, según los permisos) una tarea o actividad en un deal.",
    inputSchema: {
      type: "object",
      properties: {
        deal_id: { type: "string" }, asunto: { type: "string" }, tipo: { type: "string", description: "task, call, meeting, video_call, demo, email… (por defecto task)" },
        en_dias: { type: "integer", minimum: 0, maximum: 365, description: "Para dentro de cuántos días (0 = hoy)" }, nota: { type: "string" }, motivo: { type: "string" },
      },
      required: ["deal_id", "asunto"],
    },
    run: async (a, agent) => {
      const d = await needDeal(a.deal_id);
      const types = await activityTypes();
      const type = str(a.tipo) || "task";
      if (!types.some((t) => t.key === type && t.is_active)) throw new UserError(`Tipo de actividad no válido. Válidos: ${types.filter((t) => t.is_active).map((t) => t.key).join(", ")}`);
      const subject = str(a.asunto);
      if (!subject) throw new UserError("Falta el asunto.");
      return propose(agent, "create_task", d.id, `${subject}`, str(a.motivo), {
        type, subject: subject.slice(0, 300), note: str(a.nota) || null, due_in_days: Math.max(0, Math.round(num(a.en_dias)) || 0), owner_id: d.owner_id,
      });
    },
  },
  {
    name: "proponer_nota",
    write: true,
    description: "Añade (o propone) una nota en un deal.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" }, texto: { type: "string" }, motivo: { type: "string" } }, required: ["deal_id", "texto"] },
    run: async (a, agent) => {
      const d = await needDeal(a.deal_id);
      const text = str(a.texto);
      if (!text) throw new UserError("Falta el texto.");
      return propose(agent, "add_note", d.id, `Nota: ${text.slice(0, 120)}`, str(a.motivo), { content: text.slice(0, 20000) });
    },
  },
  {
    name: "proponer_mover_fase",
    write: true,
    description: "Mueve (o propone mover) un deal a otra fase de su pipeline.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" }, fase: { type: "string", description: "Nombre de la fase" }, motivo: { type: "string" } }, required: ["deal_id", "fase"] },
    run: async (a, agent) => {
      const d = await needDeal(a.deal_id);
      if (d.status !== "open") throw new UserError("El deal está cerrado.");
      const [st] = await sql<{ id: string; name: string }[]>`
        SELECT id, name FROM stages WHERE pipeline_id = ${d.pipeline_id} AND is_active AND lower(name) = lower(${str(a.fase)})`;
      if (!st) throw new UserError("Esa fase no existe en el pipeline del deal (mira «fases_del_pipeline» en ver_deal).");
      if (st.id === d.stage_id) throw new UserError("El deal ya está en esa fase.");
      return propose(agent, "move_stage", d.id, `Pasar «${d.title}» a «${st.name}»`, str(a.motivo), { stage_id: st.id, stage_name: st.name, from_stage_id: d.stage_id });
    },
  },
  {
    name: "proponer_correo",
    write: true,
    description: "Prepara (o envía, si tiene permiso y hay buzón conectado) un correo al contacto principal del deal.",
    inputSchema: {
      type: "object",
      properties: { deal_id: { type: "string" }, asunto: { type: "string" }, texto: { type: "string" }, para_email: { type: "string", description: "Por defecto, el contacto principal" }, motivo: { type: "string" } },
      required: ["deal_id", "asunto", "texto"],
    },
    run: async (a, agent) => {
      const d = await needDeal(a.deal_id);
      const [c] = await sql<{ person_id: string; full_name: string; email: string | null }[]>`
        SELECT p.id AS person_id, p.full_name,
               (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email
        FROM deal_participants dp JOIN persons p ON p.id = dp.person_id
        WHERE dp.deal_id = ${d.id} AND (${str(a.para_email) || null}::text IS NULL
              OR EXISTS (SELECT 1 FROM person_emails e WHERE e.person_id = p.id AND lower(e.email) = lower(${str(a.para_email)})))
        ORDER BY dp.is_primary DESC LIMIT 1`;
      if (!c?.email) throw new UserError("El deal no tiene un contacto con ese email.");
      return propose(agent, "draft_email", d.id, `Escribir a ${c.full_name}: ${str(a.asunto)}`, str(a.motivo), {
        to: c.email, to_name: c.full_name, person_id: c.person_id, subject: str(a.asunto).slice(0, 300), body: str(a.texto).slice(0, 20000),
      });
    },
  },
  {
    name: "proponer_cambio_deal",
    write: true,
    description: "Cambia (o propone cambiar) el título, el importe o la fecha de cierre prevista de un deal.",
    inputSchema: {
      type: "object",
      properties: { deal_id: { type: "string" }, titulo: { type: "string" }, importe: { type: "number" }, fecha_cierre: { type: "string", description: "AAAA-MM-DD" }, motivo: { type: "string" } },
      required: ["deal_id"],
    },
    run: async (a, agent) => {
      const d = await needDeal(a.deal_id);
      const changes: Record<string, unknown> = {};
      if (str(a.titulo)) changes.title = str(a.titulo).slice(0, 300);
      if (Number.isFinite(num(a.importe)) && num(a.importe) >= 0) changes.value = num(a.importe);
      if (/^\d{4}-\d{2}-\d{2}$/.test(str(a.fecha_cierre))) changes.expected_close_date = str(a.fecha_cierre);
      if (Object.keys(changes).length === 0) throw new UserError("No hay nada que cambiar.");
      const what = Object.entries(changes).map(([k, v]) => `${{ title: "título", value: "importe", expected_close_date: "cierre" }[k]}: ${v}`).join(", ");
      return propose(agent, "update_deal", d.id, `Cambiar «${d.title}» (${what})`, str(a.motivo), { changes });
    },
  },
  {
    name: "lectura_correos",
    description: "Correos enviados de un deal con su lectura: cuántas veces se abrió cada uno, cuándo (cada apertura), clics y si respondieron.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
    run: async (a) => {
      const d = await needDeal(a.deal_id);
      return sql`
        SELECT e.subject AS asunto, e.to_email AS para, e.sent_at AS enviado, e.open_count AS aperturas, e.click_count AS clics,
               (SELECT json_agg(json_build_object('cuando', o.at, 'dispositivo', o.device, 'programa', o.client, 'lugar', o.place) ORDER BY o.at)
                  FROM email_opens o WHERE o.email_id = e.id AND NOT o.automatic) AS cada_apertura,
               EXISTS (SELECT 1 FROM emails r WHERE r.direction = 'in' AND r.person_id = e.person_id AND r.sent_at > e.sent_at) AS respondio
        FROM emails e WHERE e.deal_id = ${d.id} AND e.direction = 'out' AND e.status = 'sent' ORDER BY e.sent_at DESC LIMIT 30`;
    },
  },
  {
    name: "deals_en_riesgo",
    description: "Deals abiertos con peor salud (0-100) y sus señales de riesgo.",
    inputSchema: { type: "object", properties: { limite: { type: "integer", minimum: 1, maximum: 50 } } },
    run: async (a) => {
      const limit = Math.min(50, Math.max(1, Math.round(num(a.limite)) || 10));
      return sql`
        SELECT d.id, d.title AS titulo, h.score AS salud, u.name AS responsable,
               (SELECT json_agg(x->>'label') FROM jsonb_array_elements(h.signals) x WHERE x->>'tone' = 'risk') AS riesgos
        FROM deal_health h JOIN deals d ON d.id = h.deal_id AND d.status = 'open' AND d.deleted_at IS NULL LEFT JOIN users u ON u.id = d.owner_id
        ORDER BY h.score LIMIT ${limit}`;
    },
  },
  {
    name: "listar_campanas",
    description: "Campañas de outbound con su estado y resultados (contactos, enviados, respuestas, interesados, deals).",
    inputSchema: { type: "object", properties: {} },
    run: async () => (await listCampaigns()).map((c) => ({
      id: c.id, nombre: c.name, estado: CAMPAIGN_STATUS[c.status], contactos: c.stats.contacts, enviados: c.stats.sent, respuestas: c.stats.replied,
      interesados: c.stats.interested, deals: c.stats.deals, enlace: appUrl(`/campaigns/${c.id}`),
    })),
  },
  {
    name: "anadir_contactos_campana",
    description: "Añade contactos a una campaña de outbound (p. ej. una lista que has preparado). Se verifican, se personalizan y una persona aprueba antes de enviar.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        campana_id: { type: "string" },
        contactos: {
          type: "array", maxItems: 500,
          items: { type: "object", properties: { email: { type: "string" }, nombre: { type: "string" }, empresa: { type: "string" }, cargo: { type: "string" }, dominio: { type: "string" } }, required: ["email"] },
        },
      },
      required: ["campana_id", "contactos"],
    },
    run: async (a, agent) => {
      if (!agent.can_write) throw new UserError("Esta clave es de solo lectura.");
      const id = str(a.campana_id);
      if (!isId(id)) throw new UserError("campana_id no válido (usa «listar_campanas»).");
      if (!Array.isArray(a.contactos) || a.contactos.length > 500) throw new UserError("«contactos» tiene que ser una lista de hasta 500.");
      const r = await addContacts({ type: "integration", id: null }, id, (a.contactos as Record<string, unknown>[]).map((c) => ({
        email: str(c?.email), full_name: str(c?.nombre) || undefined, company: str(c?.empresa) || undefined, job_title: str(c?.cargo) || undefined, domain: str(c?.dominio) || undefined,
      })), `mcp:${agent.name}`.slice(0, 60));
      return { anadidos: r.added, ya_estaban: r.existing, descartados: r.skipped, siguiente: "Se verifican y personalizan en la próxima revisión; una persona los aprueba antes de enviar.", enlace: appUrl(`/campaigns/${id}`) };
    },
  },
  {
    name: "cuentas",
    description: "Clientes (cuentas con contrato) con importe anual, salud 0-100 y sus señales, renovación, satisfacción y oportunidades de expansión abiertas.",
    inputSchema: { type: "object", properties: { filtro: { type: "string", enum: ["riesgo", "renuevan", "onboarding"], description: "Opcional" } } },
    run: async (a) => {
      const f = ({ riesgo: "risk", renuevan: "renewing", onboarding: "onboarding" } as Record<string, string>)[str(a.filtro)] ?? null;
      return (await listAccounts({ filter: f })).slice(0, 100).map((r) => ({
        id: r.id, cliente: r.name, importe_anual: r.arr, salud: r.health, senales: r.health_signals.map((x) => x.label), renovacion: r.renewal_date,
        dias_para_renovar: r.days_to_renewal, satisfaccion: r.nps, expansion_abierta: r.open_expansion, customer_success: r.cs_owner_name,
        enlace: appUrl(`/organizations/${r.id}`),
      }));
    },
  },
  {
    name: "registrar_uso",
    description: "Guarda un dato de uso del producto de un cliente (p. ej. usuarios_activos, licencias_en_uso, tickets_abiertos). Alimenta la salud de la cuenta y la detección de upselling.",
    write: true,
    inputSchema: { type: "object", properties: { dominio: { type: "string" }, organization_id: { type: "string" }, metrica: { type: "string" }, valor: { type: "number" } }, required: ["metrica", "valor"] },
    run: async (a, agent) => {
      if (!agent.can_write) throw new UserError("Esta clave es de solo lectura.");
      return recordUsage({ domain: str(a.dominio) || undefined, organization_id: str(a.organization_id) || undefined, metric: str(a.metrica), value: num(a.valor), source: `mcp:${agent.name}` });
    },
  },
  {
    name: "proponer_expansion",
    description: "Propone una oportunidad de upsell o cross-sell para un cliente (con su porqué). Según los permisos, se crea al momento o queda para aprobar.",
    write: true,
    inputSchema: {
      type: "object",
      properties: {
        organization_id: { type: "string" }, tipo: { type: "string", enum: ["upsell", "cross_sell"] }, titulo: { type: "string" },
        importe: { type: "number" }, motivo: { type: "string" },
      },
      required: ["organization_id", "tipo", "titulo", "motivo"],
    },
    run: async (a, agent) => {
      if (!agent.can_write) throw new UserError("Esta clave es de solo lectura.");
      const orgId = str(a.organization_id);
      if (!isId(orgId)) throw new UserError("organization_id no válido (usa «cuentas»).");
      const [o] = await sql<{ name: string }[]>`SELECT name FROM organizations WHERE id = ${orgId} AND deleted_at IS NULL`;
      if (!o) throw new UserError("Esa empresa no existe.");
      const [perms, mailbox] = await Promise.all([listPermissions(), hasActiveMailbox()]);
      const level = capForMailbox("create_deal", perms.find((p) => p.actor === "external" && p.action_type === "create_deal")?.autonomy ?? "off", mailbox);
      if (level === "off") throw new UserError("Los agentes externos no tienen permiso para crear deals (Ajustes → Automatizaciones).");
      const type = str(a.tipo) === "cross_sell" ? "cross_sell" : "upsell";
      const value = num(a.importe);
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO automation_actions ${sql({
          actor: "external", agent_name: agent.name, subject_type: "organization", subject_id: orgId, deal_id: null, action_type: "create_deal",
          title: `Oportunidad de ${type === "upsell" ? "upsell" : "cross-sell"}: ${str(a.titulo)}`.slice(0, 300), reason: str(a.motivo).slice(0, 1000) || `Propuesto por ${agent.name}`,
          payload: sql.json({ kind: "expansion", organization_id: orgId, type, title: str(a.titulo).slice(0, 300), value: Number.isFinite(value) ? value : null, note: str(a.motivo) } as never),
          mode: level,
        } as unknown as Record<string, never>)} RETURNING id`;
      if (level === "ask") return { estado: "pendiente", mensaje: "Queda en la bandeja para que una persona lo apruebe.", propuesta_id: row.id, enlace: appUrl("/inbox") };
      await executeAction(row.id, { actor: { type: "integration", id: null } });
      const [done] = await sql<{ result: unknown }[]>`SELECT result FROM automation_actions WHERE id = ${row.id}`;
      return { estado: "hecho", propuesta_id: row.id, resultado: done?.result ?? null };
    },
  },
];

const INSTRUCTIONS = "CRM comercial. Usa «buscar» o «listar_deals» para encontrar ids y «ver_deal» antes de actuar. Las herramientas «proponer_*» respetan los permisos del equipo: algunas se ejecutan al momento y otras quedan pendientes de aprobación en la bandeja; la respuesta lo indica. Escribe en español.";

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/** Atiende un mensaje JSON-RPC. Devuelve null para las notificaciones (sin respuesta). */
export async function handleRpc(agent: Agent, msg: RpcRequest): Promise<object | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (!msg || typeof msg.method !== "string") return fail(-32600, "Petición no válida");
  if (msg.id === undefined && msg.method.startsWith("notifications/")) return null;
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "crm", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOLS.filter((t) => agent.can_write || !t.write).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = str(msg.params?.name);
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return fail(-32602, `Herramienta desconocida: ${name}`);
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await tool.run(args, agent);
        return ok({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        return ok({ content: [{ type: "text", text: toUserMessage(err) }], isError: true });
      }
    }
    default:
      return msg.id === undefined ? null : fail(-32601, `Método no soportado: ${msg.method}`);
  }
}
