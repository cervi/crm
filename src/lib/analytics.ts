import { z } from "zod";
import type postgres from "postgres";
import { sql } from "./db";
import { UserError } from "./errors";
import { listFieldDefinitions } from "./custom-fields";
import { activityLabel, outcomeLabel, STATUS_LABELS } from "./format";
import { UUID_RE } from "./validation";

// =====================================================================
// Catálogo de lo que se puede medir. Todo lo que llega del usuario se
// valida contra esta lista: nunca se interpola texto libre en el SQL.
// =====================================================================

export type Source = "deals" | "leads" | "activities";
export type Format = "number" | "money" | "percent" | "days";

type MetricDef = { label: string; format: Format };
type GroupDef = { label: string; time?: "week" | "month" | "quarter" };

export const CATALOG = {
  deals: {
    label: "Deals",
    metrics: {
      count: { label: "Número de deals", format: "number" },
      sum_value: { label: "Importe total", format: "money" },
      avg_value: { label: "Importe medio", format: "money" },
      win_rate: { label: "Tasa de cierre (ganados / cerrados)", format: "percent" },
      avg_days_to_close: { label: "Días medios hasta ganar", format: "days" },
    } as Record<string, MetricDef>,
    groups: {
      none: { label: "Sin agrupar (un número)" },
      stage: { label: "Fase" },
      pipeline: { label: "Pipeline" },
      owner: { label: "Responsable" },
      status: { label: "Estado" },
      source: { label: "Origen" },
      lost_reason: { label: "Motivo de pérdida" },
      organization: { label: "Empresa" },
      week: { label: "Semana", time: "week" },
      month: { label: "Mes", time: "month" },
      quarter: { label: "Trimestre", time: "quarter" },
    } as Record<string, GroupDef>,
    dates: { created_at: "Fecha de alta", won_at: "Fecha de ganado", lost_at: "Fecha de perdido", expected_close_date: "Cierre previsto" } as Record<string, string>,
  },
  leads: {
    label: "Leads",
    metrics: {
      count: { label: "Número de leads", format: "number" },
      conversion_rate: { label: "Conversión a deal", format: "percent" },
    } as Record<string, MetricDef>,
    groups: {
      none: { label: "Sin agrupar (un número)" },
      source: { label: "Origen" },
      source_detail: { label: "Contenido de origen" },
      funnel_stage: { label: "Etapa del funnel" },
      status: { label: "Estado" },
      owner: { label: "Responsable" },
      week: { label: "Semana", time: "week" },
      month: { label: "Mes", time: "month" },
      quarter: { label: "Trimestre", time: "quarter" },
    } as Record<string, GroupDef>,
    dates: { created_at: "Fecha de entrada", converted_at: "Fecha de conversión" } as Record<string, string>,
  },
  activities: {
    label: "Actividades",
    metrics: {
      count: { label: "Número de actividades", format: "number" },
      completion_rate: { label: "Porcentaje completadas", format: "percent" },
      no_show_rate: { label: "Porcentaje de ausencias", format: "percent" },
    } as Record<string, MetricDef>,
    groups: {
      none: { label: "Sin agrupar (un número)" },
      type: { label: "Tipo" },
      outcome: { label: "Resultado" },
      owner: { label: "Responsable" },
      week: { label: "Semana", time: "week" },
      month: { label: "Mes", time: "month" },
    } as Record<string, GroupDef>,
    dates: { created_at: "Fecha de creación", due_at: "Fecha prevista", done_at: "Fecha de realización" } as Record<string, string>,
  },
} as const;

export const PERIODS: Record<string, string> = {
  "7d": "Últimos 7 días",
  "30d": "Últimos 30 días",
  "90d": "Últimos 90 días",
  "12m": "Últimos 12 meses",
  this_month: "Este mes",
  last_month: "Mes pasado",
  this_quarter: "Este trimestre",
  this_year: "Este año",
  all: "Todo el histórico",
};

export const CHARTS: Record<string, string> = { number: "Número", bar: "Barras", line: "Línea en el tiempo", table: "Tabla" };

const optStr = z.string().trim().max(200).optional().transform((v) => (v ? v : undefined));

export const widgetConfigSchema = z.object({
  source: z.enum(["deals", "leads", "activities"]),
  metric: z.string(),
  group_by: z.string(),
  date_field: z.string(),
  period: z.string().refine((p) => p in PERIODS, "Periodo no válido"),
  chart: z.enum(["number", "bar", "line", "table"]),
  limit: z.coerce.number().int().min(3).max(30).optional(),
  filters: z.object({
    pipeline_id: optStr,
    status: optStr,
    owner_id: optStr,
    source: optStr,
    funnel_stage: optStr,
    type: optStr,
  }).prefault({}),
});
export type WidgetConfig = z.infer<typeof widgetConfigSchema>;

/** Valida una configuración y la deja coherente (p. ej. «línea» exige agrupar por tiempo). */
export async function normalizeConfig(input: unknown): Promise<WidgetConfig> {
  const parsed = widgetConfigSchema.safeParse(input);
  if (!parsed.success) throw new UserError(parsed.error.issues[0]?.message ?? "Configuración no válida");
  const c = parsed.data;
  const cat = CATALOG[c.source];
  if (!(c.metric in cat.metrics)) throw new UserError("Métrica no válida para esta fuente.");
  if (!(c.date_field in cat.dates)) throw new UserError("Campo de fecha no válido.");
  const custom = c.group_by.startsWith("custom:");
  if (custom) {
    const key = c.group_by.slice(7);
    const entity = c.source === "deals" ? "deal" : c.source === "leads" ? "lead" : null;
    const defs = entity ? await listFieldDefinitions(entity) : [];
    if (!defs.some((d) => d.key === key && (d.field_type === "single_option" || d.field_type === "boolean" || d.field_type === "text"))) {
      throw new UserError("Campo personalizado no válido para agrupar.");
    }
  } else if (!(c.group_by in cat.groups)) {
    throw new UserError("Agrupación no válida para esta fuente.");
  }
  for (const k of ["pipeline_id", "owner_id"] as const) {
    if (c.filters[k] && !UUID_RE.test(c.filters[k]!)) throw new UserError("Filtro no válido.");
  }
  const isTime = !custom && Boolean((cat.groups as Record<string, GroupDef>)[c.group_by]?.time);
  // Coherencia entre agrupación y tipo de gráfico.
  if (c.group_by === "none") c.chart = "number";
  else if (c.chart === "number") c.chart = isTime ? "line" : "bar";
  else if (c.chart === "line" && !isTime) c.chart = "bar";
  return c;
}

// =====================================================================
// Ejecución

export type WidgetPoint = { key: string; label: string; value: number | null };
export type WidgetResult =
  | { kind: "single"; value: number | null; previous: number | null; format: Format; periodLabel: string; previousLabel: string | null }
  | { kind: "series"; points: WidgetPoint[]; format: Format; time: boolean; periodLabel: string; truncated: boolean };

type Range = { start: Date | null; end: Date | null };

function periodRange(period: string, now = new Date()): Range {
  const d = (y: number, m: number, day = 1) => new Date(y, m, day);
  const y = now.getFullYear(), m = now.getMonth();
  const daysAgo = (n: number) => { const s = new Date(now); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - n + 1); return s; };
  switch (period) {
    case "7d": return { start: daysAgo(7), end: null };
    case "30d": return { start: daysAgo(30), end: null };
    case "90d": return { start: daysAgo(90), end: null };
    case "12m": return { start: d(y, m - 11), end: null };
    case "this_month": return { start: d(y, m), end: d(y, m + 1) };
    case "last_month": return { start: d(y, m - 1), end: d(y, m) };
    case "this_quarter": return { start: d(y, m - (m % 3)), end: d(y, m - (m % 3) + 3) };
    case "this_year": return { start: d(y, 0), end: d(y + 1, 0) };
    default: return { start: null, end: null };
  }
}

/**
 * Periodo anterior comparable. En los periodos de calendario en curso (este
 * mes, trimestre o año) se compara hasta el mismo punto del periodo anterior,
 * para no enfrentar un periodo a medias con uno completo.
 */
function previousRange(period: string, r: Range, now = new Date()): Range | null {
  if (!r.start) return null;
  const shift = (months: number) => new Date(r.start!.getFullYear(), r.start!.getMonth() - months, r.start!.getDate());
  const calendar: Record<string, number> = { this_month: 1, last_month: 1, this_quarter: 3, this_year: 12 };
  if (period in calendar) {
    const start = shift(calendar[period]);
    const inProgress = r.end !== null && r.end > now;
    const end = inProgress ? new Date(start.getTime() + (now.getTime() - r.start.getTime())) : r.start;
    return { start, end };
  }
  const end = r.end ?? now;
  const span = end.getTime() - r.start.getTime();
  return { start: new Date(r.start.getTime() - span), end: r.start };
}

const PREVIOUS_LABEL: Record<string, string> = {
  "7d": "frente a los 7 días anteriores", "30d": "frente a los 30 días anteriores", "90d": "frente a los 90 días anteriores", "12m": "frente a los 12 meses anteriores",
  this_month: "frente al mismo punto del mes pasado", last_month: "frente al mes anterior", this_quarter: "frente al mismo punto del trimestre anterior", this_year: "frente al mismo punto del año pasado",
};

type Q = postgres.PendingQuery<postgres.Row[]>;

function sourceParts(c: WidgetConfig) {
  // Tabla, joins, columna de fecha, métrica y agrupación: todo desde listas fijas.
  if (c.source === "deals") {
    const date = { created_at: sql`d.created_at`, won_at: sql`d.won_at`, lost_at: sql`d.lost_at`,
                   expected_close_date: sql`d.expected_close_date::timestamptz` }[c.date_field]!;
    const metric = {
      count: sql`count(*)::float8`,
      sum_value: sql`coalesce(sum(d.value), 0)::float8`,
      avg_value: sql`avg(d.value)::float8`,
      win_rate: sql`(count(*) FILTER (WHERE d.status = 'won'))::float8 / nullif(count(*) FILTER (WHERE d.status IN ('won', 'lost')), 0)`,
      avg_days_to_close: sql`avg(extract(epoch FROM d.won_at - d.created_at) / 86400) FILTER (WHERE d.status = 'won')`,
    }[c.metric]!;
    const groups: Record<string, { key: Q; label: Q; order?: Q }> = {
      // Sin filtro de pipeline, la fase lleva el nombre de su pipeline para no confundir fases homónimas.
      stage: { key: sql`s.id::text`, label: c.filters.pipeline_id ? sql`s.name` : sql`s.name || ' (' || p.name || ')'`,
               order: sql`min(p.position * 1000 + s.position)` },
      pipeline: { key: sql`p.id::text`, label: sql`p.name`, order: sql`min(p.position)` },
      owner: { key: sql`coalesce(u.id::text, '-')`, label: sql`coalesce(u.name, 'Sin responsable')` },
      status: { key: sql`d.status`, label: sql`d.status` },
      source: { key: sql`coalesce(d.source, '-')`, label: sql`coalesce(nullif(d.source, ''), 'Sin origen')` },
      lost_reason: { key: sql`coalesce(lr.id::text, '-')`, label: sql`coalesce(lr.label, 'Sin motivo')` },
      organization: { key: sql`coalesce(o.id::text, '-')`, label: sql`coalesce(o.name, 'Sin empresa')` },
    };
    const where = [sql`d.deleted_at IS NULL`];
    if (c.filters.pipeline_id) where.push(sql`d.pipeline_id = ${c.filters.pipeline_id}::uuid`);
    if (c.filters.status && ["open", "won", "lost"].includes(c.filters.status)) where.push(sql`d.status = ${c.filters.status}`);
    if (c.filters.owner_id) where.push(sql`d.owner_id = ${c.filters.owner_id}::uuid`);
    if (c.filters.source) where.push(sql`d.source = ${c.filters.source}`);
    return {
      from: sql`deals d JOIN pipelines p ON p.id = d.pipeline_id JOIN stages s ON s.id = d.stage_id
                LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN lost_reasons lr ON lr.id = d.lost_reason_id
                LEFT JOIN organizations o ON o.id = d.organization_id`,
      date, metric, groups, where, custom: (key: string) => sql`d.custom->>${key}`,
    };
  }
  if (c.source === "leads") {
    const date = { created_at: sql`l.created_at`, converted_at: sql`l.converted_at` }[c.date_field]!;
    const metric = {
      count: sql`count(*)::float8`,
      conversion_rate: sql`(count(*) FILTER (WHERE l.status = 'converted'))::float8 / nullif(count(*), 0)`,
    }[c.metric]!;
    const groups: Record<string, { key: Q; label: Q; order?: Q }> = {
      source: { key: sql`coalesce(l.source, '-')`, label: sql`coalesce(nullif(l.source, ''), 'Sin origen')` },
      source_detail: { key: sql`coalesce(l.source_detail, '-')`, label: sql`coalesce(nullif(l.source_detail, ''), 'Sin detalle')` },
      funnel_stage: { key: sql`coalesce(l.funnel_stage, '-')`, label: sql`coalesce(upper(l.funnel_stage), 'Sin etapa')`,
                      order: sql`min(CASE l.funnel_stage WHEN 'tofu' THEN 1 WHEN 'mofu' THEN 2 WHEN 'bofu' THEN 3 ELSE 4 END)` },
      status: { key: sql`l.status`, label: sql`l.status` },
      owner: { key: sql`coalesce(u.id::text, '-')`, label: sql`coalesce(u.name, 'Sin responsable')` },
    };
    const where = [sql`l.deleted_at IS NULL`];
    if (c.filters.status && ["open", "converted", "archived"].includes(c.filters.status)) where.push(sql`l.status = ${c.filters.status}`);
    if (c.filters.source) where.push(sql`l.source = ${c.filters.source}`);
    if (c.filters.funnel_stage && ["tofu", "mofu", "bofu"].includes(c.filters.funnel_stage)) where.push(sql`l.funnel_stage = ${c.filters.funnel_stage}`);
    if (c.filters.owner_id) where.push(sql`l.owner_id = ${c.filters.owner_id}::uuid`);
    return { from: sql`leads l LEFT JOIN users u ON u.id = l.owner_id`, date, metric, groups, where,
             custom: (key: string) => sql`l.custom->>${key}` };
  }
  const date = { created_at: sql`a.created_at`, due_at: sql`a.due_at`, done_at: sql`a.done_at` }[c.date_field]!;
  const metric = {
    count: sql`count(*)::float8`,
    completion_rate: sql`(count(*) FILTER (WHERE a.done))::float8 / nullif(count(*), 0)`,
    no_show_rate: sql`(count(*) FILTER (WHERE a.outcome = 'no_show'))::float8 / nullif(count(*) FILTER (WHERE a.outcome IS NOT NULL), 0)`,
  }[c.metric]!;
  const groups: Record<string, { key: Q; label: Q; order?: Q }> = {
    type: { key: sql`a.type`, label: sql`a.type` },
    outcome: { key: sql`coalesce(a.outcome, '-')`, label: sql`coalesce(a.outcome, '-')` },
    owner: { key: sql`coalesce(u.id::text, '-')`, label: sql`coalesce(u.name, 'Sin responsable')` },
  };
  const where = [sql`true`];
  if (c.filters.type) where.push(sql`a.type = ${c.filters.type}`);
  if (c.filters.owner_id) where.push(sql`a.owner_id = ${c.filters.owner_id}::uuid`);
  if (c.filters.status === "done") where.push(sql`a.done`);
  if (c.filters.status === "pending") where.push(sql`NOT a.done`);
  return { from: sql`activities a LEFT JOIN users u ON u.id = a.owner_id`, date, metric, groups, where, custom: () => sql`NULL` };
}

const and = (parts: Q[]) => parts.reduce((acc, p, i) => (i === 0 ? sql`${p}` : sql`${acc} AND ${p}`));

function rangeWhere(date: Q, r: Range): Q[] {
  const out: Q[] = [];
  if (r.start) out.push(sql`${date} >= ${r.start}`);
  if (r.end) out.push(sql`${date} < ${r.end}`);
  return out;
}

async function single(c: WidgetConfig, r: Range): Promise<number | null> {
  const p = sourceParts(c);
  const [row] = await sql<{ v: number | null }[]>`
    SELECT ${p.metric} AS v FROM ${p.from} WHERE ${and([...p.where, ...rangeWhere(p.date, r)])}`;
  return row?.v ?? null;
}

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];

function timeLabel(d: Date, unit: "week" | "month" | "quarter") {
  if (unit === "month") return `${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  if (unit === "quarter") return `T${Math.floor(d.getMonth() / 3) + 1} ${String(d.getFullYear()).slice(2)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function bucketStart(d: Date, unit: "week" | "month" | "quarter") {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (unit === "month") return new Date(x.getFullYear(), x.getMonth(), 1);
  if (unit === "quarter") return new Date(x.getFullYear(), x.getMonth() - (x.getMonth() % 3), 1);
  const day = (x.getDay() + 6) % 7; // lunes = 0
  x.setDate(x.getDate() - day);
  return x;
}

function nextBucket(d: Date, unit: "week" | "month" | "quarter") {
  if (unit === "month") return new Date(d.getFullYear(), d.getMonth() + 1, 1);
  if (unit === "quarter") return new Date(d.getFullYear(), d.getMonth() + 3, 1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7);
}

const pgUnit = { week: "week", month: "month", quarter: "quarter" } as const;

/** Traduce claves internas a etiquetas legibles. */
function prettyLabel(c: WidgetConfig, label: string): string {
  if (c.group_by === "status") return STATUS_LABELS[label] ?? label;
  if (c.group_by === "type") return activityLabel(label);
  if (c.group_by === "outcome") return label === "-" ? "Sin resultado" : outcomeLabel(label);
  return label;
}

export async function runWidget(input: WidgetConfig): Promise<WidgetResult> {
  const c = input;
  const cat = CATALOG[c.source];
  const format = (cat.metrics as Record<string, MetricDef>)[c.metric].format;
  const range = periodRange(c.period);
  const periodLabel = PERIODS[c.period];
  const p = sourceParts(c);

  if (c.group_by === "none") {
    const prev = previousRange(c.period, range);
    const [value, previous] = await Promise.all([single(c, range), prev ? single(c, prev) : Promise.resolve(null)]);
    return { kind: "single", value, previous, format, periodLabel, previousLabel: prev ? PREVIOUS_LABEL[c.period] ?? null : null };
  }

  const groupDef = (cat.groups as Record<string, GroupDef>)[c.group_by];
  const unit = groupDef?.time;
  if (unit) {
    const rows = await sql<{ bucket: Date; v: number | null }[]>`
      SELECT date_trunc(${pgUnit[unit]}, ${p.date}) AS bucket, ${p.metric} AS v
      FROM ${p.from}
      WHERE ${and([...p.where, sql`${p.date} IS NOT NULL`, ...rangeWhere(p.date, range)])}
      GROUP BY 1 ORDER BY 1`;
    // Se rellenan los huecos con cero (o vacío en las tasas) para que el eje sea continuo.
    const byKey = new Map(rows.map((r) => [bucketStart(new Date(r.bucket), unit).getTime(), r.v]));
    const first = range.start ?? (rows[0] ? new Date(rows[0].bucket) : null);
    const points: WidgetPoint[] = [];
    if (first) {
      const last = bucketStart(range.end ? new Date(range.end.getTime() - 1) : new Date(), unit);
      for (let b = bucketStart(first, unit); b <= last && points.length < 120; b = nextBucket(b, unit)) {
        const v = byKey.get(b.getTime());
        points.push({ key: b.toISOString(), label: timeLabel(b, unit), value: v ?? (format === "percent" || format === "days" ? null : 0) });
      }
    }
    return { kind: "series", points, format, time: true, periodLabel, truncated: false };
  }

  const g = c.group_by.startsWith("custom:")
    ? (() => { const e = p.custom(c.group_by.slice(7)); return { key: sql`coalesce(${e}, '-')`, label: sql`coalesce(${e}, 'Sin valor')`, order: undefined }; })()
    : p.groups[c.group_by];
  if (!g) throw new UserError("Agrupación no válida.");
  const limit = c.limit ?? 10;
  const rows = await sql<{ k: string; label: string; v: number | null; n: number }[]>`
    SELECT ${g.key} AS k, min(${g.label}) AS label, ${p.metric} AS v, count(*)::int AS n
    FROM ${p.from}
    WHERE ${and([...p.where, ...rangeWhere(p.date, range)])}
    GROUP BY 1
    ORDER BY ${g.order ? sql`${g.order}` : sql`3 DESC NULLS LAST`}
    LIMIT ${limit + 1}`;

  let labels = new Map<string, string>();
  if (c.group_by.startsWith("custom:")) {
    const defs = await listFieldDefinitions(c.source === "deals" ? "deal" : "lead", true);
    const def = defs.find((d) => d.key === c.group_by.slice(7));
    labels = new Map((def?.options ?? []).map((o) => [o.key, o.label]));
    if (def?.field_type === "boolean") labels = new Map([["true", "Sí"], ["false", "No"]]);
  }
  const truncated = rows.length > limit;
  const points = rows.slice(0, limit).map((r) => ({
    key: r.k, label: labels.get(r.label) ?? prettyLabel(c, r.label), value: r.v,
  }));
  return { kind: "series", points, format, time: false, periodLabel, truncated };
}

/** Opciones de agrupación por campo personalizado (para el editor de widgets). */
export async function customGroupOptions() {
  const [deal, lead] = await Promise.all([listFieldDefinitions("deal"), listFieldDefinitions("lead")]);
  const pick = (defs: typeof deal) => defs
    .filter((d) => d.field_type === "single_option" || d.field_type === "boolean")
    .map((d) => ({ value: `custom:${d.key}`, label: `${d.label} (campo personalizado)` }));
  return { deals: pick(deal), leads: pick(lead), activities: [] as { value: string; label: string }[] };
}

// =====================================================================
// Dashboards y widgets

export type Dashboard = { id: string; name: string; position: number };
export type Widget = { id: string; dashboard_id: string; title: string; config: WidgetConfig; width: 1 | 2; position: number };

export async function listDashboards(): Promise<Dashboard[]> {
  return sql<Dashboard[]>`SELECT id, name, position FROM dashboards ORDER BY position, created_at`;
}

export async function listWidgets(dashboardId: string): Promise<Widget[]> {
  return sql<Widget[]>`
    SELECT id, dashboard_id, title, config, width, position FROM dashboard_widgets
    WHERE dashboard_id = ${dashboardId} ORDER BY position, created_at`;
}

export async function getWidget(id: string): Promise<Widget | null> {
  const [w] = await sql<Widget[]>`SELECT id, dashboard_id, title, config, width, position FROM dashboard_widgets WHERE id = ${id}`;
  return w ?? null;
}

/** Ejecuta un widget sin romper el dashboard si su configuración ya no es válida. */
export async function safeRun(config: unknown): Promise<WidgetResult | { kind: "error"; message: string }> {
  try {
    return await runWidget(await normalizeConfig(config));
  } catch (err) {
    return { kind: "error", message: err instanceof UserError ? err.message : "No se ha podido calcular este widget." };
  }
}

export function describeConfig(c: WidgetConfig): string {
  const cat = CATALOG[c.source];
  const metric = (cat.metrics as Record<string, MetricDef>)[c.metric]?.label ?? c.metric;
  return `${metric} · ${PERIODS[c.period] ?? c.period}`;
}
