import { sql } from "./db";
import { DEAL_TYPE_LABEL, ORIGIN_LABEL } from "./deal-types";
import { activityLabel } from "./format";
import { activityTypes } from "./activity-types";
import { zonedToUtc } from "./slots";

// ===========================================================================
// Análisis de ventas por periodo (mes o trimestre) y segmento: lo que un equipo
// comercial mira cada semana — ganado, nuevo pipeline, tasa de cierre, ticket
// medio, ciclo de venta, motivos de pérdida y actividad.
// ===========================================================================

export type Grain = "day" | "week" | "month" | "quarter";
export type Segment = "none" | "owner" | "source" | "pipeline" | "type" | "origin" | "industry";

export const SEGMENTS: Record<Segment, string> = {
  none: "Sin segmentar",
  owner: "Responsable",
  source: "Origen",
  pipeline: "Pipeline",
  type: "Tipo de deal",
  origin: "Quién lo trajo",
  industry: "Sector",
};

/** Hasta 6 segmentos con nombre; el resto se agrupa en «Otros» (nunca más de 7 colores). */
const MAX_SEGMENTS = 6;

export type Series = { key: string; label: string; values: number[] };
export type SalesAnalytics = {
  grain: Grain;
  periods: { key: string; label: string; short: string }[];
  segments: string[];
  wonValue: Series[];
  createdValue: Series[];
  wonCount: number[];
  lostCount: number[];
  createdCount: number[];
  winRate: (number | null)[];
  avgDeal: (number | null)[];
  cycleDays: (number | null)[];
  bySegment: { label: string; won: number; wonCount: number; lost: number; open: number; winRate: number | null }[];
  lostReasons: { label: string; n: number; value: number }[];
  activities: Series[];
  totals: { won: number; wonCount: number; created: number; winRate: number | null; avgDeal: number | null; cycle: number | null; prevWon: number };
};

const TZ = () => process.env.TZ || "Europe/Madrid";

function segExpr(seg: Segment) {
  switch (seg) {
    case "owner": return sql`coalesce(u.name, 'Sin responsable')`;
    case "source": return sql`coalesce(nullif(trim(d.source), ''), 'Sin origen')`;
    case "pipeline": return sql`coalesce(p.name, 'Sin pipeline')`;
    case "type": return sql`d.deal_type::text`;
    case "origin": return sql`d.origin::text`;
    case "industry": return sql`coalesce(nullif(trim(o.industry), ''), 'Sin sector')`;
    default: return sql`'Total'`;
  }
}

function segLabel(seg: Segment, raw: string): string {
  if (seg === "type") return (DEAL_TYPE_LABEL as Record<string, string>)[raw] ?? raw;
  if (seg === "origin") return (ORIGIN_LABEL as Record<string, string>)[raw] ?? raw;
  return raw;
}

type Ymd = { y: number; m: number; d: number };
const ymdOf = (date: Date): Ymd => {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit" }).format(date).split("-").map(Number);
  return { y, m, d };
};
const mk = (y: number, m: number, d: number): Ymd => { const t = new Date(Date.UTC(y, m - 1, d)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const iso = (p: Ymd) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
const parseIso = (s: string | undefined | null): Ymd | null => {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  return mk(y, m, d);
};
const days = (a: Ymd, b: Ymd) => Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);

/** Rangos de fechas como en Pipedrive: calendario, «últimos…» y personalizado. */
export const RANGE_PRESETS = [
  { group: "Calendario", items: [
    { key: "this_week", label: "Esta semana" }, { key: "last_week", label: "Semana pasada" },
    { key: "this_month", label: "Este mes" }, { key: "last_month", label: "Mes pasado" },
    { key: "this_quarter", label: "Este trimestre" }, { key: "last_quarter", label: "Trimestre pasado" },
    { key: "this_year", label: "Este año" }, { key: "last_year", label: "Año pasado" },
  ] },
  { group: "Últimos", items: [
    { key: "7d", label: "Últimos 7 días" }, { key: "30d", label: "Últimos 30 días" }, { key: "3m", label: "Últimos 3 meses" },
    { key: "6m", label: "Últimos 6 meses" }, { key: "12m", label: "Últimos 12 meses" }, { key: "24m", label: "Últimos 24 meses" },
  ] },
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number]["items"][number]["key"] | "custom";

export type ResolvedRange = { preset: RangePreset; from: Ymd; to: Ymd; /** exclusivo */ label: string; fromIso: string; toIso: string };

/** Convierte el preset (o las fechas personalizadas) en un rango [desde, hasta). */
export function resolveRange(preset: string | undefined, fromStr?: string, toStr?: string, now = new Date()): ResolvedRange {
  const t = ymdOf(now);
  const dow = (new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay() + 6) % 7;
  const q0 = Math.floor((t.m - 1) / 3) * 3 + 1;
  const tomorrow = mk(t.y, t.m, t.d + 1);
  const all: { key: string; label: string }[] = RANGE_PRESETS.flatMap((g): { key: string; label: string }[] => [...g.items]);
  const r = (key: RangePreset, from: Ymd, to: Ymd): ResolvedRange => {
    const fmt = (p: Ymd) => new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(p.y, p.m - 1, p.d)));
    const last = mk(to.y, to.m, to.d - 1);
    const label = key === "custom" ? `${fmt(from)} – ${fmt(last)}` : all.find((x) => x.key === key)?.label ?? "";
    return { preset: key, from, to, label, fromIso: iso(from), toIso: iso(last) };
  };
  if (preset === "custom") {
    const a = parseIso(fromStr), b = parseIso(toStr);
    if (a && b && days(a, b) >= 0) return r("custom", a, mk(b.y, b.m, b.d + 1));
  }
  switch (preset) {
    case "this_week": return r(preset, mk(t.y, t.m, t.d - dow), tomorrow);
    case "last_week": return r(preset, mk(t.y, t.m, t.d - dow - 7), mk(t.y, t.m, t.d - dow));
    case "this_month": return r(preset, mk(t.y, t.m, 1), tomorrow);
    case "last_month": return r(preset, mk(t.y, t.m - 1, 1), mk(t.y, t.m, 1));
    case "this_quarter": return r(preset, mk(t.y, q0, 1), tomorrow);
    case "last_quarter": return r(preset, mk(t.y, q0 - 3, 1), mk(t.y, q0, 1));
    case "this_year": return r(preset, mk(t.y, 1, 1), tomorrow);
    case "last_year": return r(preset, mk(t.y - 1, 1, 1), mk(t.y, 1, 1));
    case "7d": return r(preset, mk(t.y, t.m, t.d - 6), tomorrow);
    case "30d": return r(preset, mk(t.y, t.m, t.d - 29), tomorrow);
    case "3m": return r(preset, mk(t.y, t.m - 2, 1), tomorrow);
    case "6m": return r(preset, mk(t.y, t.m - 5, 1), tomorrow);
    case "24m": return r(preset, mk(t.y, t.m - 23, 1), tomorrow);
    default: return r("12m", mk(t.y, t.m - 11, 1), tomorrow);
  }
}

/** Agrupaciones que tienen sentido para la duración del rango, y la de por defecto. */
export function grainsFor(range: ResolvedRange): { allowed: Grain[]; auto: Grain } {
  const n = days(range.from, range.to);
  const allowed: Grain[] = [];
  if (n <= 62) allowed.push("day");
  if (n >= 7 && n <= 400) allowed.push("week");
  if (n >= 28) allowed.push("month");
  if (n >= 85) allowed.push("quarter");
  const auto: Grain = n <= 31 ? "day" : n <= 92 ? "week" : n <= 731 ? "month" : "quarter";
  return { allowed: allowed.length ? allowed : ["day"], auto };
}

/** Periodos del rango según la agrupación. */
function periodList(grain: Grain, range: ResolvedRange) {
  const out: { key: string; label: string; short: string }[] = [];
  const monthName = (mo: number, style: "long" | "short") =>
    new Intl.DateTimeFormat("es-ES", { month: style, timeZone: "UTC" }).format(new Date(Date.UTC(2000, mo - 1, 1))).replace(".", "");
  const { from, to } = range;
  const before = (p: Ymd) => Date.UTC(p.y, p.m - 1, p.d) < Date.UTC(to.y, to.m - 1, to.d);
  if (grain === "day" || grain === "week") {
    let cur = from;
    if (grain === "week") { const dow = (new Date(Date.UTC(from.y, from.m - 1, from.d)).getUTCDay() + 6) % 7; cur = mk(from.y, from.m, from.d - dow); }
    let first = true;
    while (before(cur)) {
      const short = `${cur.d} ${monthName(cur.m, "short")}`;
      out.push({ key: iso(cur), label: grain === "day" ? `${cur.d} de ${monthName(cur.m, "long")} de ${cur.y}` : `Semana del ${cur.d} de ${monthName(cur.m, "long")}`, short: first || (cur.d <= (grain === "day" ? 1 : 7)) ? short : grain === "day" ? String(cur.d) : short });
      cur = mk(cur.y, cur.m, cur.d + (grain === "day" ? 1 : 7));
      first = false;
    }
  } else if (grain === "month") {
    let cur = mk(from.y, from.m, 1), first = true;
    while (before(cur)) {
      const short = monthName(cur.m, "short");
      out.push({ key: `${cur.y}-${String(cur.m).padStart(2, "0")}`, label: `${monthName(cur.m, "long")} ${cur.y}`, short: cur.m === 1 || first ? `${short} ${String(cur.y).slice(2)}` : short });
      cur = mk(cur.y, cur.m + 1, 1); first = false;
    }
  } else {
    let cur = mk(from.y, Math.floor((from.m - 1) / 3) * 3 + 1, 1);
    while (before(cur)) {
      const q = Math.floor((cur.m - 1) / 3) + 1;
      out.push({ key: `${cur.y}-Q${q}`, label: `${q}.º trimestre ${cur.y}`, short: `Q${q} ${String(cur.y).slice(2)}` });
      cur = mk(cur.y, cur.m + 3, 1);
    }
  }
  return out;
}

const periodKey = (grain: Grain, col: ReturnType<typeof sql>) => {
  const local = sql`(${col} AT TIME ZONE ${TZ()})`;
  if (grain === "day") return sql`to_char(${local}, 'YYYY-MM-DD')`;
  if (grain === "week") return sql`to_char(date_trunc('week', ${local}), 'YYYY-MM-DD')`;
  if (grain === "month") return sql`to_char(${local}, 'YYYY-MM')`;
  return sql`to_char(${local}, 'YYYY') || '-Q' || to_char(${local}, 'Q')`;
};

export async function salesAnalytics(opts: { grain: Grain; segment: Segment; range: ResolvedRange; pipelineId?: string | null; ownerId?: string | null }): Promise<SalesAnalytics> {
  const { grain, segment, range } = opts;
  const periods = periodList(grain, range);
  const idx = new Map(periods.map((p, i) => [p.key, i]));
  const len = days(range.from, range.to);
  const fromDate = zonedToUtc(range.from.y, range.from.m, range.from.d, 0, 0, TZ());
  const toDate = zonedToUtc(range.to.y, range.to.m, range.to.d, 0, 0, TZ());
  // El periodo anterior de la misma duración, para comparar.
  const prevDate = zonedToUtc(range.from.y, range.from.m, range.from.d - len, 0, 0, TZ());
  const from = sql`${fromDate}::timestamptz`;
  const to = sql`${toDate}::timestamptz`;
  const scope = sql`d.deleted_at IS NULL
    AND (${opts.pipelineId ?? null}::uuid IS NULL OR d.pipeline_id = ${opts.pipelineId ?? null}::uuid)
    AND (${opts.ownerId ?? null}::uuid IS NULL OR d.owner_id = ${opts.ownerId ?? null}::uuid)`;
  const joins = sql`FROM deals d LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN pipelines p ON p.id = d.pipeline_id
                    LEFT JOIN organizations o ON o.id = d.organization_id`;
  const seg = segExpr(segment);

  const [won, created, lost, segTotals, reasons, acts, prev] = await Promise.all([
    sql<{ period: string; seg: string; value: number; n: number; days: number | null }[]>`
      SELECT ${periodKey(grain, sql`d.won_at`)} AS period, ${seg} AS seg, coalesce(sum(d.value), 0)::float8 AS value, count(*)::int AS n,
             avg(extract(epoch FROM d.won_at - d.created_at) / 86400)::float8 AS days
      ${joins} WHERE ${scope} AND d.status = 'won' AND d.won_at >= ${from} AND d.won_at < ${to} GROUP BY 1, 2`,
    sql<{ period: string; seg: string; value: number; n: number }[]>`
      SELECT ${periodKey(grain, sql`d.created_at`)} AS period, ${seg} AS seg, coalesce(sum(d.value), 0)::float8 AS value, count(*)::int AS n
      ${joins} WHERE ${scope} AND d.created_at >= ${from} AND d.created_at < ${to} GROUP BY 1, 2`,
    sql<{ period: string; seg: string; n: number }[]>`
      SELECT ${periodKey(grain, sql`d.lost_at`)} AS period, ${seg} AS seg, count(*)::int AS n
      ${joins} WHERE ${scope} AND d.status = 'lost' AND d.lost_at >= ${from} AND d.lost_at < ${to} GROUP BY 1, 2`,
    sql<{ seg: string; won: number; won_n: number; lost_n: number; open: number }[]>`
      SELECT ${seg} AS seg,
             coalesce(sum(d.value) FILTER (WHERE d.status = 'won' AND d.won_at >= ${from} AND d.won_at < ${to}), 0)::float8 AS won,
             count(*) FILTER (WHERE d.status = 'won' AND d.won_at >= ${from} AND d.won_at < ${to})::int AS won_n,
             count(*) FILTER (WHERE d.status = 'lost' AND d.lost_at >= ${from} AND d.lost_at < ${to})::int AS lost_n,
             coalesce(sum(d.value) FILTER (WHERE d.status = 'open'), 0)::float8 AS open
      ${joins} WHERE ${scope} GROUP BY 1`,
    sql<{ label: string; n: number; value: number }[]>`
      SELECT coalesce(r.label, 'Sin motivo') AS label, count(*)::int AS n, coalesce(sum(d.value), 0)::float8 AS value
      FROM deals d LEFT JOIN lost_reasons r ON r.id = d.lost_reason_id
      WHERE ${scope} AND d.status = 'lost' AND d.lost_at >= ${from} AND d.lost_at < ${to}
      GROUP BY 1 ORDER BY n DESC LIMIT 8`,
    sql<{ period: string; type: string; n: number }[]>`
      SELECT ${periodKey(grain, sql`a.done_at`)} AS period, a.type, count(*)::int AS n
      FROM activities a LEFT JOIN deals d ON d.id = a.deal_id
      WHERE a.done AND a.done_at >= ${from} AND a.done_at < ${to}
        AND (${opts.ownerId ?? null}::uuid IS NULL OR a.owner_id = ${opts.ownerId ?? null}::uuid)
        AND (${opts.pipelineId ?? null}::uuid IS NULL OR d.pipeline_id = ${opts.pipelineId ?? null}::uuid)
      GROUP BY 1, 2`,
    // El mismo tramo justo antes, para comparar el total ganado.
    sql<{ value: number }[]>`
      SELECT coalesce(sum(d.value), 0)::float8 AS value FROM deals d
      WHERE ${scope} AND d.status = 'won' AND d.won_at >= ${prevDate}::timestamptz AND d.won_at < ${from}`,
  ]);

  // Segmentos: los de más importe (ganado + abierto) y el resto en «Otros».
  const ranked = [...segTotals].filter((r) => r.won || r.open || r.won_n || r.lost_n || segment === "none")
    .sort((a, b) => (b.won + b.open) - (a.won + a.open));
  const keep = new Set(ranked.slice(0, segment === "none" ? 1 : MAX_SEGMENTS).map((r) => r.seg));
  const bucket = (raw: string) => (keep.has(raw) ? raw : "__otros");
  const segKeys = [...ranked.filter((r) => keep.has(r.seg)).map((r) => r.seg), ...(ranked.length > keep.size ? ["__otros"] : [])];
  const label = (k: string) => (k === "__otros" ? "Otros" : segLabel(segment, k));

  const toSeries = (rows: { period: string; seg: string; value: number }[]): Series[] => segKeys.map((k) => {
    const values = periods.map(() => 0);
    for (const r of rows) if (bucket(r.seg) === k && idx.has(r.period)) values[idx.get(r.period)!] += r.value;
    return { key: k, label: label(k), values };
  });
  const perPeriod = (rows: { period: string; n: number }[]) => {
    const v = periods.map(() => 0);
    for (const r of rows) if (idx.has(r.period)) v[idx.get(r.period)!] += r.n;
    return v;
  };

  const wonCount = perPeriod(won);
  const lostCount = perPeriod(lost);
  const wonValueTotal = periods.map((_, i) => won.filter((r) => idx.get(r.period) === i).reduce((n, r) => n + r.value, 0));
  const cycleDays = periods.map((_, i) => {
    const rs = won.filter((r) => idx.get(r.period) === i && r.days !== null);
    const n = rs.reduce((a, r) => a + r.n, 0);
    return n ? rs.reduce((a, r) => a + r.days! * r.n, 0) / n : null;
  });

  // Actividad hecha por tipo (los 5 tipos más usados + «Otros»).
  const types = await activityTypes();
  const typeTotals = new Map<string, number>();
  for (const a of acts) typeTotals.set(a.type, (typeTotals.get(a.type) ?? 0) + a.n);
  const topTypes = [...typeTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
  const actKeys = [...topTypes, ...(typeTotals.size > topTypes.length ? ["__otros"] : [])];
  const activities: Series[] = actKeys.map((k) => {
    const values = periods.map(() => 0);
    for (const a of acts) if ((topTypes.includes(a.type) ? a.type : "__otros") === k && idx.has(a.period)) values[idx.get(a.period)!] += a.n;
    return { key: k, label: k === "__otros" ? "Otros" : types.find((t) => t.key === k)?.label ?? activityLabel(k), values };
  });

  const totalWon = wonValueTotal.reduce((a, b) => a + b, 0);
  const totalWonN = wonCount.reduce((a, b) => a + b, 0);
  const totalLostN = lostCount.reduce((a, b) => a + b, 0);
  const allDays = won.filter((r) => r.days !== null);
  const daysN = allDays.reduce((a, r) => a + r.n, 0);

  return {
    grain, periods, segments: segKeys.map(label),
    wonValue: toSeries(won),
    createdValue: toSeries(created),
    wonCount, lostCount, createdCount: perPeriod(created),
    winRate: periods.map((_, i) => (wonCount[i] + lostCount[i] ? wonCount[i] / (wonCount[i] + lostCount[i]) : null)),
    avgDeal: periods.map((_, i) => (wonCount[i] ? wonValueTotal[i] / wonCount[i] : null)),
    cycleDays,
    bySegment: segKeys.map((k) => {
      const rs = segTotals.filter((r) => bucket(r.seg) === k);
      const w = rs.reduce((a, r) => a + r.won_n, 0), l = rs.reduce((a, r) => a + r.lost_n, 0);
      return { label: label(k), won: rs.reduce((a, r) => a + r.won, 0), wonCount: w, lost: l, open: rs.reduce((a, r) => a + r.open, 0), winRate: w + l ? w / (w + l) : null };
    }),
    lostReasons: reasons,
    activities,
    totals: {
      won: totalWon, wonCount: totalWonN,
      created: created.reduce((a, r) => a + r.value, 0),
      winRate: totalWonN + totalLostN ? totalWonN / (totalWonN + totalLostN) : null,
      avgDeal: totalWonN ? totalWon / totalWonN : null,
      cycle: daysN ? allDays.reduce((a, r) => a + r.days! * r.n, 0) / daysN : null,
      prevWon: prev[0]?.value ?? 0,
    },
  };
}


// ---------------------------------------------------------------------------
// Detalle de una barra (qué deals o actividades hay detrás) y explicación de
// cada gráfico en lenguaje claro.
// ---------------------------------------------------------------------------

/** Límites [desde, hasta) de un periodo a partir de su clave. */
export function periodBounds(grain: Grain, key: string): { from: Date; to: Date } | null {
  const tz = TZ();
  if ((grain === "day" || grain === "week") && /^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const [y, m, d] = key.split("-").map(Number);
    return { from: zonedToUtc(y, m, d, 0, 0, tz), to: zonedToUtc(y, m, d + (grain === "day" ? 1 : 7), 0, 0, tz) };
  }
  if (grain === "month" && /^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split("-").map(Number);
    return { from: zonedToUtc(y, m, 1, 0, 0, tz), to: zonedToUtc(y, m + 1, 1, 0, 0, tz) };
  }
  const q = key.match(/^(\d{4})-Q([1-4])$/);
  if (grain === "quarter" && q) {
    const y = Number(q[1]), m = (Number(q[2]) - 1) * 3 + 1;
    return { from: zonedToUtc(y, m, 1, 0, 0, tz), to: zonedToUtc(y, m + 3, 1, 0, 0, tz) };
  }
  return null;
}

export type DrillMetric = "won" | "created" | "lost" | "closed" | "activities";
export type DrillRow = { id: string; href: string; title: string; who: string | null; owner: string | null; value: number | null; currency: string | null; date: Date; detail: string | null };

export async function drillDown(opts: { metric: DrillMetric; grain: Grain; key: string; segment: Segment; segKey?: string | null; type?: string | null; pipelineId?: string | null; ownerId?: string | null }): Promise<DrillRow[]> {
  const b = periodBounds(opts.grain, opts.key);
  if (!b) return [];
  const owner = opts.ownerId ?? null, pipe = opts.pipelineId ?? null;
  if (opts.metric === "activities") {
    return sql<DrillRow[]>`
      SELECT a.id, CASE WHEN a.deal_id IS NOT NULL THEN '/deals/' || a.deal_id WHEN a.person_id IS NOT NULL THEN '/persons/' || a.person_id ELSE '/activities' END AS href,
             a.subject AS title, coalesce(d.title, pe.full_name) AS who, u.name AS owner, NULL::float8 AS value, NULL AS currency, a.done_at AS date, a.type AS detail
      FROM activities a LEFT JOIN deals d ON d.id = a.deal_id LEFT JOIN persons pe ON pe.id = a.person_id LEFT JOIN users u ON u.id = a.owner_id
      WHERE a.done AND a.done_at >= ${b.from} AND a.done_at < ${b.to}
        AND (${owner}::uuid IS NULL OR a.owner_id = ${owner}::uuid)
        AND (${pipe}::uuid IS NULL OR d.pipeline_id = ${pipe}::uuid)
        AND (${opts.type ?? null}::text IS NULL OR a.type = ${opts.type ?? null})
      ORDER BY a.done_at DESC LIMIT 300`;
  }
  const col = opts.metric === "won" ? sql`d.won_at` : opts.metric === "lost" ? sql`d.lost_at` : opts.metric === "created" ? sql`d.created_at` : sql`coalesce(d.won_at, d.lost_at)`;
  const status = opts.metric === "won" ? sql`d.status = 'won'` : opts.metric === "lost" ? sql`d.status = 'lost'` : opts.metric === "closed" ? sql`d.status IN ('won', 'lost')` : sql`true`;
  const segFilter = opts.segment !== "none" && opts.segKey && opts.segKey !== "__otros" ? sql`AND ${segExpr(opts.segment)} = ${opts.segKey}` : sql``;
  return sql<DrillRow[]>`
    SELECT d.id, '/deals/' || d.id AS href, d.title, o.name AS who, u.name AS owner, d.value::float8 AS value, d.currency, ${col} AS date,
           CASE WHEN d.status = 'lost' THEN coalesce(r.label, 'Perdido') WHEN d.status = 'won' THEN 'Ganado' ELSE s.name END AS detail
    FROM deals d LEFT JOIN users u ON u.id = d.owner_id LEFT JOIN pipelines p ON p.id = d.pipeline_id
         LEFT JOIN organizations o ON o.id = d.organization_id LEFT JOIN stages s ON s.id = d.stage_id
         LEFT JOIN lost_reasons r ON r.id = d.lost_reason_id
    WHERE d.deleted_at IS NULL AND ${status} AND ${col} >= ${b.from} AND ${col} < ${b.to}
      AND (${pipe}::uuid IS NULL OR d.pipeline_id = ${pipe}::uuid)
      AND (${owner}::uuid IS NULL OR d.owner_id = ${owner}::uuid)
      ${segFilter}
    ORDER BY d.value DESC NULLS LAST, ${col} DESC LIMIT 300`;
}

const eur = (n: number) => `${Math.round(n).toLocaleString("es-ES", { useGrouping: true })} €`;
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const pctTxt = (n: number) => `${Math.round(n * 100)} %`;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Explicaciones en lenguaje claro de cada gráfico: qué ha pasado y por qué puede ser. */
export function chartInsights(sa: SalesAnalytics): Record<"won" | "created" | "winloss" | "winrate" | "avg" | "cycle" | "activities" | "lost", string[]> {
  const P = sa.periods;
  const unit = { day: "día", week: "semana", month: "mes", quarter: "trimestre" }[sa.grain];
  const won = P.map((_, i) => sa.wonValue.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const created = P.map((_, i) => sa.createdValue.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const acts = P.map((_, i) => sa.activities.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const n = P.length;
  // El último periodo puede estar a medias: se compara el último completo.
  const last = n >= 2 ? n - 2 : n - 1, prev = last - 1;
  const out = { won: [] as string[], created: [] as string[], winloss: [] as string[], winrate: [] as string[], avg: [] as string[], cycle: [] as string[], activities: [] as string[], lost: [] as string[] };
  const change = (a: number, b: number) => (b ? (a - b) / b : null);
  const best = (xs: number[]) => xs.reduce((bi, v, i) => (v > xs[bi] ? i : bi), 0);

  // Ganado
  const totalWon = won.reduce((a, b) => a + b, 0);
  if (totalWon === 0) out.won.push("No se ha ganado ningún deal en este periodo.");
  else {
    const bi = best(won);
    out.won.push(`En total se han ganado ${eur(totalWon)} en ${sa.totals.wonCount} deals; el mejor ${unit} fue ${P[bi].label} (${eur(won[bi])}${sa.wonCount[bi] ? `, ${sa.wonCount[bi]} deals` : ""}).`);
    const zero = won.filter((v) => v === 0).length;
    if (zero >= Math.max(2, n / 3)) out.won.push(`Hay ${zero} ${unit === "mes" ? "meses" : unit + "s"} sin ninguna venta: los ingresos dependen de pocos cierres y son irregulares.`);
    const top = Math.max(...sa.wonValue.flatMap((s) => s.values.map((v) => v ?? 0)));
    if (sa.totals.wonCount >= 3 && top > totalWon * 0.4) out.won.push("Un solo periodo concentra buena parte de lo ganado: conviene no tomarlo como ritmo normal.");
    if (prev >= 0) {
      const c = change(won[last], avg(won.slice(0, last)));
      if (c !== null && c < -0.3) {
        const why: string[] = [];
        const cr = change(avg(created.slice(Math.max(0, last - 2), last + 1)), avg(created.slice(0, Math.max(1, last - 2))));
        if (cr !== null && cr < -0.2) why.push(`se ha creado menos pipeline en los últimos ${unit === "mes" ? "meses" : "periodos"} (${pctTxt(-cr)} menos que antes)`);
        const wr = sa.winRate[last], wrAvg = sa.totals.winRate;
        if (wr !== null && wrAvg !== null && wr < wrAvg - 0.1) why.push(`la tasa de cierre bajó al ${pctTxt(wr)} (la media es ${pctTxt(wrAvg)})`);
        const ac = change(acts[last], avg(acts.slice(0, last)));
        if (ac !== null && ac < -0.3) why.push(`hubo menos actividad comercial (${pctTxt(-ac)} menos llamadas, reuniones y correos)`);
        if (sa.wonCount[last] <= 1 && sa.totals.avgDeal) why.push("se cerraron muy pocos deals");
        out.won.push(`${cap(P[last].label)} quedó un ${pctTxt(-c)} por debajo de la media${why.length ? `; seguramente porque ${why.join(", ")}` : ""}.`);
      } else if (c !== null && c > 0.3) {
        out.won.push(`${cap(P[last].label)} quedó un ${pctTxt(c)} por encima de la media${sa.wonCount[last] ? ` gracias a ${sa.wonCount[last]} cierre${sa.wonCount[last] === 1 ? "" : "s"}` : ""}.`);
      }
    }
    if (sa.wonValue.length > 1) {
      const shares = sa.wonValue.map((s) => ({ l: s.label, v: s.values.reduce((a: number, b) => a + (b ?? 0), 0) })).sort((a, b) => b.v - a.v);
      if (shares[0].v > 0) out.won.push(`${shares[0].l} aporta el ${pctTxt(shares[0].v / totalWon)} de lo ganado.`);
    }
  }

  // Pipeline creado
  const totalCreated = created.reduce((a, b) => a + b, 0);
  if (totalCreated === 0) out.created.push("No se ha creado pipeline nuevo en este periodo.");
  else {
    out.created.push(`Se han creado ${sa.createdCount.reduce((a, b) => a + b, 0)} deals por ${eur(totalCreated)}. El pipeline de hoy son las ventas de dentro de ${sa.totals.cycle ? Math.round(sa.totals.cycle) : "unos"} días (vuestro ciclo de venta).`);
    const c = prev >= 0 ? change(avg(created.slice(Math.max(0, last - 1), last + 1)), avg(created.slice(0, Math.max(1, last - 1)))) : null;
    if (c !== null && c < -0.25) out.created.push(`Últimamente entra un ${pctTxt(-c)} menos que antes: si no se recupera, se notará en lo ganado más adelante.`);
    else if (c !== null && c > 0.25) out.created.push(`Últimamente entra un ${pctTxt(c)} más que antes: buena señal para los próximos cierres.`);
    const ratio = sa.totals.won && totalCreated ? sa.totals.won / totalCreated : null;
    if (ratio !== null) out.created.push(`Por cada 100 € de pipeline creado se han ganado ${Math.round(ratio * 100)} €.`);
  }

  // Ganados y perdidos / tasa de cierre
  const tw = sa.wonCount.reduce((a, b) => a + b, 0), tl = sa.lostCount.reduce((a, b) => a + b, 0);
  if (tw + tl === 0) out.winloss.push("No se ha cerrado ningún deal (ni ganado ni perdido) en este periodo.");
  else {
    out.winloss.push(`Se han cerrado ${tw + tl} deals: ${tw} ganados y ${tl} perdidos.`);
    if (tl > tw * 3) out.winloss.push("Se pierden muchos más de los que se ganan: revisa los motivos de pérdida (abajo) y si los deals entran bien cualificados.");
    const many = sa.lostCount.findIndex((v, i) => v > 0 && v >= 3 * Math.max(1, avg(sa.lostCount.filter((_, j) => j !== i))));
    if (many >= 0) out.winloss.push(`En ${P[many].label} se perdieron ${sa.lostCount[many]} deals de golpe: suele ser una limpieza del pipeline más que un mal ${unit}.`);
  }
  const wrs = sa.winRate.filter((v): v is number => v !== null);
  if (wrs.length === 0) out.winrate.push("Sin cierres no se puede calcular la tasa de cierre.");
  else {
    out.winrate.push(`De cada 10 deals cerrados se ganan ${Math.round((sa.totals.winRate ?? 0) * 10)}. Una tasa por debajo del 20 % suele indicar que entran deals poco cualificados o que se tarda en dar por perdidos los que no avanzan.`);
    const lw = sa.winRate[last], pw = prev >= 0 ? sa.winRate[prev] : null;
    if (lw !== null && pw !== null && Math.abs(lw - pw) >= 0.15) out.winrate.push(`En ${P[last].label} ${lw > pw ? "subió" : "bajó"} del ${pctTxt(pw)} al ${pctTxt(lw)}.`);
  }

  // Ticket medio
  if (sa.totals.avgDeal) {
    out.avg.push(`El deal ganado medio es de ${eur(sa.totals.avgDeal)}.`);
    const vals = sa.avgDeal.filter((v): v is number => v !== null);
    const hi = Math.max(...vals);
    if (vals.length > 2 && hi > sa.totals.avgDeal * 2) {
      const i = sa.avgDeal.indexOf(hi);
      out.avg.push(`El pico de ${P[i].label} (${eur(hi)}) se debe a uno o pocos deals grandes; no es la norma.`);
    }
  } else out.avg.push("Sin deals ganados no hay ticket medio.");

  // Ciclo
  if (sa.totals.cycle) {
    out.cycle.push(`De media pasan ${Math.round(sa.totals.cycle)} días desde que se crea un deal hasta que se gana.`);
    const cs = sa.cycleDays;
    if (cs[last] !== null && sa.totals.cycle && cs[last]! > sa.totals.cycle * 1.4) out.cycle.push(`En ${P[last].label} los cierres tardaron más (${Math.round(cs[last]!)} días): puede que se hayan cerrado deals antiguos que estaban parados.`);
  } else out.cycle.push("Sin deals ganados no se puede calcular el ciclo de venta.");

  // Actividad
  const ta = acts.reduce((a, b) => a + b, 0);
  if (ta === 0) out.activities.push("No hay actividades marcadas como hechas en este periodo. Si se registran fuera del CRM, aquí no se ven.");
  else {
    out.activities.push(`Se han completado ${ta} actividades (${Math.round(ta / n)} por ${unit} de media).`);
    const c = prev >= 0 ? change(acts[last], avg(acts.slice(0, last))) : null;
    if (c !== null && Math.abs(c) > 0.3) out.activities.push(`${cap(P[last].label)} tuvo un ${pctTxt(Math.abs(c))} ${c > 0 ? "más" : "menos"} de actividad que la media${c < 0 ? ": menos actividad suele traducirse en menos cierres unas semanas después" : ""}.`);
    if (sa.activities[0]) out.activities.push(`Lo más frecuente: ${sa.activities[0].label.toLowerCase()}.`);
  }

  // Motivos de pérdida
  const tr = sa.lostReasons.reduce((a, r) => a + r.n, 0);
  if (tr === 0) out.lost.push("No se ha perdido ningún deal en este periodo.");
  else {
    const top = sa.lostReasons[0];
    out.lost.push(`«${top.label}» explica el ${pctTxt(top.n / tr)} de los deals perdidos (${eur(top.value)}).`);
    if (/repl|respuesta|contest/i.test(top.label)) out.lost.push("Perder por falta de respuesta suele mejorar con un seguimiento más constante: una secuencia o una instrucción a la IA en esa fase.");
    if (/budget|presupuesto|precio|price/i.test(top.label)) out.lost.push("Si el presupuesto es el principal motivo, conviene cualificarlo antes (en la primera reunión).");
    const nr = sa.lostReasons.find((r) => /sin motivo/i.test(r.label));
    if (nr && nr.n / tr > 0.2) out.lost.push(`El ${pctTxt(nr.n / tr)} se perdió sin indicar motivo: pedirlo siempre hace este análisis más fiable.`);
  }
  return out;
}
