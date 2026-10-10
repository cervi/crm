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

export type Grain = "month" | "quarter";
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

/** Lista de periodos (los últimos 12 meses o 8 trimestres, incluido el actual). */
function periodList(grain: Grain, now = new Date()) {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), year: "numeric", month: "2-digit" }).format(now).split("-").map(Number);
  const out: { key: string; label: string; short: string }[] = [];
  const monthName = (mo: number, style: "long" | "short") =>
    new Intl.DateTimeFormat("es-ES", { month: style, timeZone: "UTC" }).format(new Date(Date.UTC(2000, mo - 1, 1))).replace(".", "");
  if (grain === "month") {
    for (let i = 11; i >= 0; i--) {
      const t = new Date(Date.UTC(y, m - 1 - i, 1));
      const yy = t.getUTCFullYear(), mm = t.getUTCMonth() + 1;
      const short = monthName(mm, "short");
      out.push({ key: `${yy}-${String(mm).padStart(2, "0")}`, label: `${monthName(mm, "long")} ${yy}`, short: mm === 1 || i === 11 ? `${short} ${String(yy).slice(2)}` : short });
    }
  } else {
    const q0 = Math.floor((m - 1) / 3);
    for (let i = 7; i >= 0; i--) {
      const idx = y * 4 + q0 - i;
      const yy = Math.floor(idx / 4), q = (idx % 4) + 1;
      out.push({ key: `${yy}-Q${q}`, label: `${q}.º trimestre ${yy}`, short: `Q${q} ${String(yy).slice(2)}` });
    }
  }
  return out;
}

const periodKey = (grain: Grain, col: ReturnType<typeof sql>) => grain === "month"
  ? sql`to_char(${col} AT TIME ZONE ${TZ()}, 'YYYY-MM')`
  : sql`to_char(${col} AT TIME ZONE ${TZ()}, 'YYYY') || '-Q' || to_char(${col} AT TIME ZONE ${TZ()}, 'Q')`;

export async function salesAnalytics(opts: { grain: Grain; segment: Segment; pipelineId?: string | null; ownerId?: string | null }): Promise<SalesAnalytics> {
  const { grain, segment } = opts;
  const periods = periodList(grain);
  const idx = new Map(periods.map((p, i) => [p.key, i]));
  const months = grain === "month" ? 12 : 24;
  // Inicio del primer periodo (medianoche local del día 1).
  const [fy, fm] = periods[0].key.includes("Q")
    ? [Number(periods[0].key.slice(0, 4)), (Number(periods[0].key.slice(-1)) - 1) * 3 + 1]
    : periods[0].key.split("-").map(Number);
  const fromDate = zonedToUtc(fy, fm, 1, 0, 0, TZ());
  const prevDate = zonedToUtc(fy, fm - months, 1, 0, 0, TZ());
  const from = sql`${fromDate}::timestamptz`;
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
      ${joins} WHERE ${scope} AND d.status = 'won' AND d.won_at >= ${from} GROUP BY 1, 2`,
    sql<{ period: string; seg: string; value: number; n: number }[]>`
      SELECT ${periodKey(grain, sql`d.created_at`)} AS period, ${seg} AS seg, coalesce(sum(d.value), 0)::float8 AS value, count(*)::int AS n
      ${joins} WHERE ${scope} AND d.created_at >= ${from} GROUP BY 1, 2`,
    sql<{ period: string; seg: string; n: number }[]>`
      SELECT ${periodKey(grain, sql`d.lost_at`)} AS period, ${seg} AS seg, count(*)::int AS n
      ${joins} WHERE ${scope} AND d.status = 'lost' AND d.lost_at >= ${from} GROUP BY 1, 2`,
    sql<{ seg: string; won: number; won_n: number; lost_n: number; open: number }[]>`
      SELECT ${seg} AS seg,
             coalesce(sum(d.value) FILTER (WHERE d.status = 'won' AND d.won_at >= ${from}), 0)::float8 AS won,
             count(*) FILTER (WHERE d.status = 'won' AND d.won_at >= ${from})::int AS won_n,
             count(*) FILTER (WHERE d.status = 'lost' AND d.lost_at >= ${from})::int AS lost_n,
             coalesce(sum(d.value) FILTER (WHERE d.status = 'open'), 0)::float8 AS open
      ${joins} WHERE ${scope} GROUP BY 1`,
    sql<{ label: string; n: number; value: number }[]>`
      SELECT coalesce(r.label, 'Sin motivo') AS label, count(*)::int AS n, coalesce(sum(d.value), 0)::float8 AS value
      FROM deals d LEFT JOIN lost_reasons r ON r.id = d.lost_reason_id
      WHERE ${scope} AND d.status = 'lost' AND d.lost_at >= ${from}
      GROUP BY 1 ORDER BY n DESC LIMIT 8`,
    sql<{ period: string; type: string; n: number }[]>`
      SELECT ${periodKey(grain, sql`a.done_at`)} AS period, a.type, count(*)::int AS n
      FROM activities a LEFT JOIN deals d ON d.id = a.deal_id
      WHERE a.done AND a.done_at >= ${from}
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
