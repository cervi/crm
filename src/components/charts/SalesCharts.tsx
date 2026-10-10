"use client";

import { useMemo, useRef, useState } from "react";
import { DrillPanel, type DrillRequest } from "./DrillPanel";

// Gráficos ligeros en SVG para los informes: barras apiladas por periodo, líneas
// y barras horizontales. Colores por papel (series-1…8, ganado/perdido) definidos
// en globals.css para modo claro y oscuro.

export type Fmt = "money" | "number" | "percent" | "days";
type Period = { key: string; label: string; short: string };
type Series = { key: string; label: string; values: (number | null)[]; color?: string };
/** Qué abrir al pinchar: la métrica del detalle y los filtros actuales. */
export type Drill = {
  metric: string; params: Record<string, string>; title: string;
  /** Al pinchar un segmento, filtra por él (barras apiladas por segmento). */
  bySegment?: boolean;
  /** Métrica distinta según la serie (p. ej. ganados / perdidos). */
  seriesMetric?: Record<string, string>;
  /** La serie es un tipo de actividad. */
  seriesType?: boolean;
};

const eur0 = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0, useGrouping: "always" } as Intl.NumberFormatOptions);
const num0 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0, useGrouping: "always" } as Intl.NumberFormatOptions);
export function fmt(v: number | null | undefined, f: Fmt): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (f === "money") return eur0.format(v);
  if (f === "percent") return `${Math.round(v * 100)} %`;
  if (f === "days") return `${Math.round(v)} d`;
  return num0.format(v);
}
function short(v: number, f: Fmt): string {
  if (f === "percent") return `${Math.round(v * 100)} %`;
  if (f === "days") return `${Math.round(v)}`;
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(v / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 1 })} M` : a >= 1e3 ? `${(v / 1e3).toLocaleString("es-ES", { maximumFractionDigits: a < 1e4 ? 1 : 0 })} k` : Math.round(v).toLocaleString("es-ES");
  return f === "money" ? `${s} €` : s;
}
function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function useDrill(drill: Drill | undefined, periods: Period[]) {
  const [req, setReq] = useState<DrillRequest | null>(null);
  const open = (i: number, s?: Series | null) => {
    if (!drill) return;
    const metric = (s && drill.seriesMetric?.[s.key]) || drill.metric;
    const q: Record<string, string> = { ...drill.params, m: metric, p: periods[i].key };
    if (s && drill.bySegment && s.key !== "Total") q.sk = s.key;
    if (s && drill.seriesType && s.key !== "__otros") q.type = s.key;
    const what = s && (drill.bySegment || drill.seriesType || drill.seriesMetric) && s.key !== "Total" ? ` · ${s.label}` : "";
    setReq({ title: `${drill.title}${what}`, subtitle: periods[i].label, query: q });
  };
  const panel = <DrillPanel req={req} onClose={() => setReq(null)} />;
  return { open, panel, on: Boolean(drill) };
}

const every = (n: number) => Math.max(1, Math.ceil(n / 14));
const color = (s: Series, i: number) => s.color ?? `var(--series-${(i % 8) + 1})`;

const W = 640, H = 240, PAD = { l: 52, r: 12, t: 12, b: 28 };

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="chart-legend">
      {series.map((s, i) => <li key={s.key}><i style={{ background: color(s, i) }} />{s.label}</li>)}
    </ul>
  );
}

function Tip({ x, y, title, rows, f, note, hint }: { x: number; y: number; title: string; rows: { label: string; value: number | null; color?: string }[]; f: Fmt; note?: string | null; hint?: boolean }) {
  return (
    <div className="chart-tip sales-tip" style={{ left: `${(x / W) * 100}%`, top: `${(y / H) * 100}%` }}>
      <strong>{title}</strong>
      {rows.map((r) => (
        <span key={r.label} className="tip-row">{r.color && <i style={{ background: r.color }} />}<span>{r.label}</span><b>{fmt(r.value, f)}</b></span>
      ))}
      {note && <span className="tip-note">{note}</span>}
      {hint && <span className="tip-hint">Haz clic para ver el detalle</span>}
    </div>
  );
}

function Axis({ max, f }: { max: number; f: Fmt }) {
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  return (
    <g aria-hidden="true">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid" />
          <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" className="tick">{short(t, f)}</text>
        </g>
      ))}
    </g>
  );
}

/** Barras por periodo; con varias series, apiladas. */
export function StackedBars({ periods, series, f, total = true, drill, notes }: { periods: Period[]; series: Series[]; f: Fmt; total?: boolean; drill?: Drill; notes?: (string | null)[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const dr = useDrill(drill, periods);
  const sums = periods.map((_, i) => series.reduce((n, s) => n + (s.values[i] ?? 0), 0));
  const max = niceMax(Math.max(...sums, 0));
  const band = (W - PAD.l - PAD.r) / periods.length;
  const bw = Math.min(42, band * 0.62);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const empty = sums.every((v) => v === 0);
  return (
    <div className="sales-chart">
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${series.map((s) => s.label).join(", ")} por periodo`}>
          <Axis max={max} f={f} />
          {periods.map((p, i) => {
            let acc = 0;
            const x = PAD.l + band * i + (band - bw) / 2;
            return (
              <g key={p.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => sums[i] && dr.open(i, null)}
                 className={dr.on && sums[i] ? "clickable" : undefined}>
                <rect x={PAD.l + band * i} y={PAD.t} width={band} height={H - PAD.t - PAD.b} fill="transparent" />
                {series.map((s, si) => {
                  const v = s.values[i] ?? 0;
                  if (v <= 0) return null;
                  const y0 = y(acc), y1 = y(acc + v);
                  acc += v;
                  const top = series.slice(si + 1).every((t) => !(t.values[i] ?? 0));
                  const h = Math.max(1, y0 - y1 - (top ? 0 : 2));
                  return <path key={s.key} d={top ? roundTop(x, y1, bw, h, 4) : `M${x},${y1 + (y0 - y1 - h)}h${bw}v${h}h${-bw}z`} fill={color(s, si)} opacity={hover === null || hover === i ? 1 : 0.55}
                               onClick={(e) => { if (series.length > 1) { e.stopPropagation(); dr.open(i, s); } }} />;
                })}
                {i % every(periods.length) === 0 && <text x={PAD.l + band * i + band / 2} y={H - 8} textAnchor="middle" className="tick">{p.short}</text>}
              </g>
            );
          })}
          {empty && <text x={(W + PAD.l) / 2} y={H / 2} textAnchor="middle" className="tick">Sin datos en este periodo</text>}
        </svg>
        {hover !== null && (
          <Tip x={PAD.l + band * hover + band / 2} y={y(sums[hover])} title={periods[hover].label} f={f}
               rows={[...series.map((s, si) => ({ label: s.label, value: s.values[hover] ?? 0, color: color(s, si) })).filter((r) => r.value).reverse(),
                      ...(total && series.length > 1 ? [{ label: "Total", value: sums[hover] }] : [])]}
               note={[notes?.[hover], hover > 0 && sums[hover - 1] ? deltaTxt(sums[hover], sums[hover - 1]) : null].filter(Boolean).join(" · ") || null}
               hint={dr.on && sums[hover] > 0} />
        )}
      </div>
      <Legend series={series} />
      {dr.panel}
    </div>
  );
}

function deltaTxt(a: number, b: number) {
  const c = (a - b) / b;
  return `${c >= 0 ? "▲" : "▼"} ${Math.abs(Math.round(c * 100))} % vs. el anterior`;
}

function roundTop(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}z`;
}

/** Barras agrupadas (una al lado de otra), p. ej. ganados frente a perdidos. */
export function GroupedBars({ periods, series, f, drill, notes }: { periods: Period[]; series: Series[]; f: Fmt; drill?: Drill; notes?: (string | null)[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const dr = useDrill(drill, periods);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const band = (W - PAD.l - PAD.r) / periods.length;
  const gw = Math.min(46, band * 0.7), bw = (gw - 2 * (series.length - 1)) / series.length;
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  return (
    <div className="sales-chart">
      <div className="chart-box">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.label).join(" y ")}>
          <Axis max={max} f={f} />
          {periods.map((p, i) => (
            <g key={p.key} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}
               onClick={() => series.some((s) => s.values[i]) && dr.open(i, null)} className={dr.on && series.some((s) => s.values[i]) ? "clickable" : undefined}>
              <rect x={PAD.l + band * i} y={PAD.t} width={band} height={H - PAD.t - PAD.b} fill="transparent" />
              {series.map((s, si) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                const x = PAD.l + band * i + (band - gw) / 2 + si * (bw + 2);
                return <path key={s.key} d={roundTop(x, y(v), bw, y(0) - y(v), 3)} fill={color(s, si)} opacity={hover === null || hover === i ? 1 : 0.55}
                             onClick={(e) => { e.stopPropagation(); dr.open(i, s); }} />;
              })}
              {i % every(periods.length) === 0 && <text x={PAD.l + band * i + band / 2} y={H - 8} textAnchor="middle" className="tick">{p.short}</text>}
            </g>
          ))}
        </svg>
        {hover !== null && (
          <Tip x={PAD.l + band * hover + band / 2} y={PAD.t + 10} title={periods[hover].label} f={f}
               rows={series.map((s, si) => ({ label: s.label, value: s.values[hover] ?? 0, color: color(s, si) }))}
               note={notes?.[hover] ?? null} hint={dr.on && series.some((s) => s.values[hover])} />
        )}
      </div>
      <Legend series={series} />
      {dr.panel}
    </div>
  );
}

/** Línea en el tiempo (una o pocas series), con cruz y ficha al pasar el ratón. */
export function Lines({ periods, series, f, maxValue, drill, notes }: { periods: Period[]; series: Series[]; f: Fmt; maxValue?: number; drill?: Drill; notes?: (string | null)[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const dr = useDrill(drill, periods);
  const ref = useRef<SVGSVGElement>(null);
  const max = maxValue ?? niceMax(Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0))));
  const step = (W - PAD.l - PAD.r) / Math.max(1, periods.length - 1);
  const x = (i: number) => PAD.l + step * i;
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);
  const paths = useMemo(() => series.map((s) => {
    let d = "", pen = false;
    s.values.forEach((v, i) => { if (v === null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i)},${y(v)}`; pen = true; });
    return d;
  }), [series, max]); // eslint-disable-line react-hooks/exhaustive-deps
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(periods.length - 1, Math.round((px - PAD.l) / step))));
  };
  const has = series.some((s) => s.values.some((v) => v !== null));
  return (
    <div className="sales-chart">
      <div className="chart-box">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.label).join(", ")} onMouseMove={onMove} onMouseLeave={() => setHover(null)}
             onClick={() => { if (hover !== null && series.some((s) => s.values[hover] !== null)) dr.open(hover, null); }} className={dr.on ? "clickable" : undefined}>
          <Axis max={max} f={f} />
          {periods.map((p, i) => i % every(periods.length) === 0 && <text key={p.key} x={x(i)} y={H - 8} textAnchor="middle" className="tick">{p.short}</text>)}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="crosshair" />}
          {series.map((s, si) => (
            <g key={s.key}>
              <path d={paths[si]} fill="none" stroke={color(s, si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.values.map((v, i) => v === null ? null : (
                <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 3} fill={color(s, si)} stroke="var(--panel)" strokeWidth={2} />
              ))}
            </g>
          ))}
          {!has && <text x={(W + PAD.l) / 2} y={H / 2} textAnchor="middle" className="tick">Sin datos en este periodo</text>}
        </svg>
        {hover !== null && has && (
          <Tip x={x(hover)} y={PAD.t + 10} title={periods[hover].label} f={f}
               rows={series.map((s, si) => ({ label: s.label, value: s.values[hover], color: series.length > 1 ? color(s, si) : undefined }))}
               note={notes?.[hover] ?? null} hint={dr.on && series.some((s) => s.values[hover] !== null)} />
        )}
      </div>
      <Legend series={series} />
      {dr.panel}
    </div>
  );
}

/** Barras horizontales para comparar categorías (segmentos, motivos…). */
export function HBars({ rows, f, sub }: { rows: { label: string; value: number; note?: string }[]; f: Fmt; sub?: Fmt }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="meta">Sin datos en este periodo.</p>;
  void sub;
  return (
    <ul className="hbars">
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${fmt(r.value, f)}${r.note ? ` · ${r.note}` : ""}`}>
          <span className="hbar-label">{r.label}</span>
          <span className="hbar-track"><i style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="hbar-value">{fmt(r.value, f)}{r.note && <span className="meta"> · {r.note}</span>}</span>
        </li>
      ))}
    </ul>
  );
}
