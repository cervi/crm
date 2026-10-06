import { sql } from "./db";
import { num, type Cell, type Separator } from "./csv";
import { listFieldDefinitions, type CustomEntity, type FieldDefinition } from "./custom-fields";
import { listUsers } from "./users";
import { getWidget, safeRun } from "./analytics";
import { activityLabel, outcomeLabel, STATUS_LABELS } from "./format";
import { actionLabel } from "./automations";
import { isId } from "./validation";
import { UserError } from "./errors";

// ===========================================================================
// Exportación a CSV: cada listado exporta lo que se ve, con sus filtros y con
// los campos personalizados como columnas.
// ===========================================================================

export type Table = { name: string; headers: string[]; rows: Cell[][] };

export async function getCsvSeparator(): Promise<Separator> {
  const [s] = await sql<{ csv_separator: string }[]>`SELECT csv_separator FROM app_settings`;
  return s?.csv_separator === "," ? "," : s?.csv_separator === "tab" ? "\t" : ";";
}

export async function setCsvSeparator(value: string) {
  if (![";", ",", "tab"].includes(value)) throw new UserError("Separador no válido.");
  await sql`UPDATE app_settings SET csv_separator = ${value}, updated_at = now()`;
}

/** Columnas de los campos personalizados de una entidad. */
async function customColumns(entity: CustomEntity) {
  const [defs, users] = await Promise.all([listFieldDefinitions(entity), listUsers()]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const value = (d: FieldDefinition, v: unknown): Cell => {
    if (v === null || v === undefined || v === "") return null;
    const label = (k: unknown) => d.options?.find((o) => o.key === k)?.label ?? String(k);
    switch (d.field_type) {
      case "multi_option": return (Array.isArray(v) ? v : [v]).map(label);
      case "single_option": return label(v);
      case "user": return userName.get(String(v)) ?? String(v);
      case "boolean": return Boolean(v);
      case "number": case "money": return Number(v);
      case "datetime": return new Date(String(v));
      default: return String(v);
    }
  };
  return {
    headers: defs.map((d) => d.label),
    values: (custom: Record<string, unknown> | null) => defs.map((d) => value(d, custom?.[d.key])),
  };
}

const opt = (p: URLSearchParams, k: string) => p.get(k)?.trim() || null;
const optId = (p: URLSearchParams, k: string) => (isId(p.get(k)) ? p.get(k)! : null);

// ---------------------------------------------------------------- Deals

async function deals(p: URLSearchParams): Promise<Table> {
  const pipeline = optId(p, "pipeline"), owner = optId(p, "owner"), org = optId(p, "organization");
  const status = ["open", "won", "lost"].includes(p.get("status") ?? "") ? p.get("status")! : "all";
  const [cf, rows] = await Promise.all([customColumns("deal"), sql<{
    id: string; title: string; organization: string | null; contact: string | null; email: string | null; pipeline: string; stage: string;
    status: string; value: string | null; currency: string; expected_close_date: string | null; owner: string | null; source: string | null;
    days_in_stage: number; rotten: boolean; next_at: Date | null; created_at: Date; won_at: Date | null; lost_at: Date | null;
    lost_reason: string | null; lost_note: string | null; custom: Record<string, unknown>;
  }[]>`
    SELECT d.id, d.title, o.name AS organization, pc.full_name AS contact, pc.email, pl.name AS pipeline, s.name AS stage,
           d.status, d.value::text, d.currency, d.expected_close_date::text, u.name AS owner, d.source,
           floor(extract(epoch FROM now() - d.stage_entered_at) / 86400)::int AS days_in_stage,
           (d.status = 'open' AND s.rotten_after_days IS NOT NULL AND now() - d.stage_entered_at > make_interval(days => s.rotten_after_days)) AS rotten,
           (SELECT min(a.due_at) FROM activities a WHERE a.deal_id = d.id AND NOT a.done AND a.due_at >= now()) AS next_at,
           d.created_at, d.won_at, d.lost_at, lr.label AS lost_reason, d.lost_note, d.custom
    FROM deals d
    JOIN pipelines pl ON pl.id = d.pipeline_id
    JOIN stages s ON s.id = d.stage_id
    LEFT JOIN organizations o ON o.id = d.organization_id
    LEFT JOIN users u ON u.id = d.owner_id
    LEFT JOIN lost_reasons lr ON lr.id = d.lost_reason_id
    LEFT JOIN LATERAL (
      SELECT pe.full_name, (SELECT email FROM person_emails WHERE person_id = pe.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email
      FROM deal_participants dp JOIN persons pe ON pe.id = dp.person_id WHERE dp.deal_id = d.id ORDER BY dp.is_primary DESC LIMIT 1
    ) pc ON true
    WHERE d.deleted_at IS NULL
      AND (${pipeline}::uuid IS NULL OR d.pipeline_id = ${pipeline}::uuid)
      AND (${owner}::uuid IS NULL OR d.owner_id = ${owner}::uuid)
      AND (${org}::uuid IS NULL OR d.organization_id = ${org}::uuid)
      AND (${status} = 'all' OR d.status = ${status})
    ORDER BY pl.name, s.position, d.title`]);
  return {
    name: "deals",
    headers: ["Deal", "Empresa", "Contacto principal", "Email del contacto", "Pipeline", "Fase", "Estado", "Importe", "Moneda",
              "Cierre previsto", "Responsable", "Origen", "Días en la fase", "Parado", "Próxima actividad", "Creado", "Ganado el",
              "Perdido el", "Motivo de pérdida", "Comentario de pérdida", ...cf.headers, "Id"],
    rows: rows.map((r) => [r.title, r.organization, r.contact, r.email, r.pipeline, r.stage, STATUS_LABELS[r.status] ?? r.status,
                           num(r.value), r.currency, r.expected_close_date, r.owner, r.source, r.status === "open" ? r.days_in_stage : null,
                           r.status === "open" ? r.rotten : null, r.next_at, r.created_at, r.won_at, r.lost_at, r.lost_reason, r.lost_note,
                           ...cf.values(r.custom), r.id]),
  };
}

// ---------------------------------------------------------------- Leads

const FUNNEL: Record<string, string> = { tofu: "TOFU", mofu: "MOFU", bofu: "BOFU" };
const LEAD_STATUS: Record<string, string> = { open: "Abierto", converted: "Convertido", archived: "Archivado" };

async function leads(p: URLSearchParams): Promise<Table> {
  const status = ["open", "converted", "archived", "all"].includes(p.get("status") ?? "") ? p.get("status")! : "all";
  const source = opt(p, "source"), funnel = opt(p, "funnel");
  const q = (p.get("q") ?? "").trim().toLowerCase(), like = `%${q}%`;
  const [cf, rows] = await Promise.all([customColumns("lead"), sql<{
    id: string; title: string; person: string | null; email: string | null; organization: string | null; source: string | null;
    source_detail: string | null; funnel_stage: string | null; status: string; deal: string | null; owner: string | null;
    tags: string[]; created_at: Date; converted_at: Date | null; custom: Record<string, unknown>;
  }[]>`
    SELECT l.id, l.title, p.full_name AS person,
           (SELECT email FROM person_emails e WHERE e.person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           o.name AS organization, l.source, l.source_detail, l.funnel_stage, l.status, d.title AS deal, u.name AS owner,
           coalesce((SELECT array_agg(t.name ORDER BY t.name) FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = l.id), '{}') AS tags,
           l.created_at, l.converted_at, l.custom
    FROM leads l
    LEFT JOIN persons p ON p.id = l.person_id
    LEFT JOIN organizations o ON o.id = l.organization_id
    LEFT JOIN users u ON u.id = l.owner_id
    LEFT JOIN deals d ON d.id = l.converted_deal_id
    WHERE l.deleted_at IS NULL
      AND (${status} = 'all' OR l.status = ${status})
      AND (${source}::text IS NULL OR l.source = ${source}::text)
      AND (${funnel}::text IS NULL OR l.funnel_stage = ${funnel}::text)
      AND (${q === ""} OR lower(l.title) LIKE ${like} OR lower(coalesce(p.full_name, '')) LIKE ${like}
           OR lower(coalesce(o.name, '')) LIKE ${like}
           OR EXISTS (SELECT 1 FROM person_emails e WHERE e.person_id = p.id AND lower(e.email) LIKE ${like}))
    ORDER BY l.created_at DESC`]);
  return {
    name: "leads",
    headers: ["Lead", "Contacto", "Email", "Empresa", "Origen", "Detalle del origen", "Etapa", "Estado", "Deal", "Responsable",
              "Etiquetas", "Creado", "Convertido el", ...cf.headers, "Id"],
    rows: rows.map((r) => [r.title, r.person, r.email, r.organization, r.source, r.source_detail, r.funnel_stage ? FUNNEL[r.funnel_stage] : null,
                           LEAD_STATUS[r.status] ?? r.status, r.deal, r.owner, r.tags, r.created_at, r.converted_at, ...cf.values(r.custom), r.id]),
  };
}

// ---------------------------------------------------------------- Empresas y contactos

async function organizations(p: URLSearchParams): Promise<Table> {
  const q = (p.get("q") ?? "").trim().toLowerCase(), like = `%${q}%`;
  const [cf, rows] = await Promise.all([customColumns("organization"), sql<{
    id: string; name: string; domain: string | null; website: string | null; industry: string | null; employee_count: number | null;
    country: string | null; city: string | null; address: string | null; owner: string | null; cs_manager_name: string | null;
    cs_manager_email: string | null; contacts: number; open_deals: number; open_value: string; won_value: string; created_at: Date;
    custom: Record<string, unknown>;
  }[]>`
    SELECT o.id, o.name, o.domain, o.website, o.industry, o.employee_count, o.country, o.city, o.address, u.name AS owner,
           o.cs_manager_name, o.cs_manager_email,
           (SELECT count(*)::int FROM person_organizations po WHERE po.organization_id = o.id AND po.status = 'current') AS contacts,
           (SELECT count(*)::int FROM deals d WHERE d.organization_id = o.id AND d.status = 'open' AND d.deleted_at IS NULL) AS open_deals,
           (SELECT coalesce(sum(value), 0)::text FROM deals d WHERE d.organization_id = o.id AND d.status = 'open' AND d.deleted_at IS NULL) AS open_value,
           (SELECT coalesce(sum(value), 0)::text FROM deals d WHERE d.organization_id = o.id AND d.status = 'won' AND d.deleted_at IS NULL) AS won_value,
           o.created_at, o.custom
    FROM organizations o LEFT JOIN users u ON u.id = o.owner_id
    WHERE o.deleted_at IS NULL AND (${q === ""} OR lower(o.name) LIKE ${like} OR lower(coalesce(o.domain, '')) LIKE ${like})
    ORDER BY lower(o.name)`]);
  return {
    name: "empresas",
    headers: ["Empresa", "Dominio", "Web", "Sector", "Empleados", "País", "Ciudad", "Dirección", "Responsable",
              "Responsable de CS", "Email de CS", "Contactos actuales", "Deals abiertos", "Importe abierto", "Importe ganado", "Creada",
              ...cf.headers, "Id"],
    rows: rows.map((r) => [r.name, r.domain, r.website, r.industry, r.employee_count, r.country, r.city, r.address, r.owner,
                           r.cs_manager_name, r.cs_manager_email, r.contacts, r.open_deals, num(r.open_value), num(r.won_value), r.created_at,
                           ...cf.values(r.custom), r.id]),
  };
}

async function persons(p: URLSearchParams): Promise<Table> {
  const q = (p.get("q") ?? "").trim().toLowerCase(), like = `%${q}%`;
  const org = optId(p, "organization");
  const [cf, rows] = await Promise.all([customColumns("person"), sql<{
    id: string; full_name: string; first_name: string | null; last_name: string | null; emails: string[]; phones: string[];
    organization: string | null; job_title: string | null; owner: string | null; marketing_consent: boolean;
    unsubscribed_at: Date | null; created_at: Date; custom: Record<string, unknown>;
  }[]>`
    SELECT p.id, p.full_name, p.first_name, p.last_name,
           coalesce((SELECT array_agg(email ORDER BY is_primary DESC, created_at) FROM person_emails WHERE person_id = p.id), '{}') AS emails,
           coalesce((SELECT array_agg(phone ORDER BY is_primary DESC, created_at) FROM person_phones WHERE person_id = p.id), '{}') AS phones,
           cur.name AS organization, cur.job_title, u.name AS owner, p.marketing_consent, p.unsubscribed_at, p.created_at, p.custom
    FROM persons p
    LEFT JOIN users u ON u.id = p.owner_id
    LEFT JOIN LATERAL (
      SELECT o.id, o.name, po.job_title FROM person_organizations po JOIN organizations o ON o.id = po.organization_id
      WHERE po.person_id = p.id AND po.status = 'current' ORDER BY po.created_at DESC LIMIT 1
    ) cur ON true
    WHERE p.deleted_at IS NULL
      AND (${org}::uuid IS NULL OR cur.id = ${org}::uuid)
      AND (${q === ""} OR lower(p.full_name) LIKE ${like}
           OR EXISTS (SELECT 1 FROM person_emails e WHERE e.person_id = p.id AND lower(e.email) LIKE ${like}))
    ORDER BY lower(p.full_name)`]);
  return {
    name: "contactos",
    headers: ["Nombre completo", "Nombre", "Apellidos", "Email", "Otros emails", "Teléfono", "Otros teléfonos", "Empresa", "Cargo",
              "Responsable", "Consentimiento de marketing", "Baja", "Creado", ...cf.headers, "Id"],
    rows: rows.map((r) => [r.full_name, r.first_name, r.last_name, r.emails[0] ?? null, r.emails.slice(1), r.phones[0] ?? null, r.phones.slice(1),
                           r.organization, r.job_title, r.owner, r.marketing_consent, r.unsubscribed_at, r.created_at, ...cf.values(r.custom), r.id]),
  };
}

// ---------------------------------------------------------------- Actividades

type ActivityRow = {
  id: string; type: string; subject: string; due_at: Date | null; duration_minutes: number | null; done: boolean; done_at: Date | null;
  outcome: string | null; deal: string | null; person: string | null; organization: string | null; owner: string | null;
  note: string | null; summary: string | null; meeting_url: string | null;
};

const activitySelect = () => sql`
  SELECT a.id, a.type, a.subject, a.due_at, a.duration_minutes, a.done, a.done_at, a.outcome, d.title AS deal,
         p.full_name AS person, o.name AS organization, u.name AS owner, a.note, a.summary, a.meeting_url
  FROM activities a
  LEFT JOIN deals d ON d.id = a.deal_id
  LEFT JOIN persons p ON p.id = a.person_id
  LEFT JOIN organizations o ON o.id = a.organization_id
  LEFT JOIN users u ON u.id = a.owner_id`;

const activityHeaders = ["Tipo", "Asunto", "Fecha", "Duración (min)", "Hecha", "Hecha el", "Resultado", "Deal", "Contacto", "Empresa",
                         "Responsable", "Notas", "Resumen", "Enlace de la reunión", "Id"];
const activityRow = (r: ActivityRow): Cell[] => [activityLabel(r.type), r.subject, r.due_at, r.duration_minutes, r.done, r.done_at,
  r.outcome ? outcomeLabel(r.outcome) : null, r.deal, r.person, r.organization, r.owner, r.note, r.summary, r.meeting_url, r.id];

async function activities(p: URLSearchParams): Promise<Table> {
  const view = ["pending", "done"].includes(p.get("view") ?? "") ? p.get("view")! : "all";
  const owner = optId(p, "owner");
  const rows = await sql<ActivityRow[]>`
    ${activitySelect()}
    WHERE (${view} = 'all' OR a.done = ${view === "done"})
      AND (${owner}::uuid IS NULL OR a.owner_id = ${owner}::uuid)
    ORDER BY a.due_at DESC NULLS LAST`;
  return { name: view === "all" ? "actividades" : view === "done" ? "actividades-hechas" : "actividades-pendientes", headers: activityHeaders, rows: rows.map(activityRow) };
}

// ---------------------------------------------------------------- Historia de un deal

async function dealHistory(p: URLSearchParams): Promise<Table> {
  const dealId = optId(p, "deal");
  if (!dealId) throw new UserError("Falta el deal.");
  const [deal] = await sql<{ title: string }[]>`SELECT title FROM deals WHERE id = ${dealId}`;
  if (!deal) throw new UserError("El deal no existe.");
  const rows = await sql<{ at: Date | null; kind: string; title: string; detail: string | null; who: string | null; done: boolean | null; outcome: string | null }[]>`
    SELECT * FROM (
      SELECT coalesce(a.done_at, a.due_at, a.created_at) AS at, a.type AS kind, a.subject AS title,
             concat_ws(E'\n\n', a.note, a.summary) AS detail, u.name AS who, a.done, a.outcome
      FROM activities a LEFT JOIN users u ON u.id = a.owner_id WHERE a.deal_id = ${dealId}
      UNION ALL
      SELECT n.created_at, 'note', 'Nota', n.content, u.name, NULL, NULL FROM notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.deal_id = ${dealId}
      UNION ALL
      SELECT dd.created_at, 'document', dd.title, dd.url, u.name, NULL, NULL FROM deal_documents dd LEFT JOIN users u ON u.id = dd.added_by_id WHERE dd.deal_id = ${dealId}
    ) h ORDER BY at DESC NULLS LAST`;
  const kind = (k: string) => (k === "note" ? "Nota" : k === "document" ? "Documento" : activityLabel(k));
  return {
    name: `historia-${slug(deal.title)}`,
    headers: ["Fecha", "Tipo", "Título", "Detalle", "Quién", "Estado", "Resultado"],
    rows: rows.map((r) => [r.at, kind(r.kind), r.title, r.detail, r.who,
                           r.done === null ? null : r.done ? "Hecha" : "Pendiente", r.outcome ? outcomeLabel(r.outcome) : null]),
  };
}

// ---------------------------------------------------------------- Registro de la IA

const ACTION_STATUS: Record<string, string> = {
  pending: "Pendiente", done: "Hecha", dismissed: "Descartada", expired: "Caducada", failed: "Falló", undone: "Deshecha",
};

async function aiLog(): Promise<Table> {
  const rows = await sql<{ created_at: Date; executed_at: Date | null; status: string; mode: string; actor: string; agent_name: string | null;
                           rule: string | null; action_type: string; title: string; reason: string; deal: string | null; error: string | null; id: string }[]>`
    SELECT x.created_at, x.executed_at, x.status, x.mode, x.actor, x.agent_name, r.name AS rule, x.action_type, x.title, x.reason,
           d.title AS deal, x.error, x.id
    FROM automation_actions x LEFT JOIN automation_rules r ON r.id = x.rule_id LEFT JOIN deals d ON d.id = x.deal_id
    ORDER BY x.created_at DESC`;
  return {
    name: "registro-ia",
    headers: ["Propuesta el", "Ejecutada el", "Estado", "Modo", "Quién", "Acción", "Título", "Motivo", "Deal", "Error", "Id"],
    rows: rows.map((r) => [r.created_at, r.executed_at, ACTION_STATUS[r.status] ?? r.status, r.mode === "auto" ? "Sola" : "Preguntar",
                           r.actor === "external" ? (r.agent_name ?? "Agente externo") : (r.rule ?? "Asistente"), actionLabel(r.action_type),
                           r.title, r.reason, r.deal, r.error, r.id]),
  };
}

// ---------------------------------------------------------------- Widgets de dashboard

async function widget(p: URLSearchParams): Promise<Table> {
  const id = optId(p, "id");
  const w = id ? await getWidget(id) : null;
  if (!w) throw new UserError("El widget no existe.");
  const r = await safeRun(w.config);
  if (r.kind === "error") throw new UserError(r.message);
  if (r.kind === "single") {
    return {
      name: `widget-${slug(w.title)}`,
      headers: ["Periodo", "Valor", "Periodo anterior", "Valor anterior"],
      rows: [[r.periodLabel, r.value, r.previousLabel, r.previous]],
    };
  }
  return { name: `widget-${slug(w.title)}`, headers: [w.title, "Valor"], rows: r.points.map((pt) => [pt.label, pt.value]) };
}

// ---------------------------------------------------------------- Registro

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "datos";

export const DATASETS: Record<string, { label: string; run: (p: URLSearchParams) => Promise<Table>; full?: boolean }> = {
  deals: { label: "Deals", run: deals, full: true },
  leads: { label: "Leads", run: leads, full: true },
  organizations: { label: "Empresas", run: organizations, full: true },
  persons: { label: "Contactos", run: persons, full: true },
  activities: { label: "Actividades", run: activities, full: true },
  "ai-log": { label: "Registro de la IA", run: aiLog, full: true },
  "deal-history": { label: "Historia de un deal", run: dealHistory },
  widget: { label: "Widget", run: widget },
};

export function exportFilename(name: string) {
  return `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
}
