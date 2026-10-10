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
  const all = RANGE_PRESETS.flatMap((g) => g.items) as readonly { key: string; label: string }[];
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
    wonCount, lostCount,
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
