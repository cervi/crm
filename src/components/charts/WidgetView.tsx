"use client";

import { useEffect, useRef, useState } from "react";
import { formatValue, niceTicks, type Format } from "@/lib/chart-format";

export type Point = { key: string; label: string; value: number | null };
export type Result =
  | { kind: "single"; value: number | null; previous: number | null; format: Format; periodLabel: string; previousLabel: string | null }
  | { kind: "series"; points: Point[]; format: Format; time: boolean; periodLabel: string; truncated: boolean }
  | { kind: "error"; message: string };

/** Dibuja el resultado de un widget con el tipo de gráfico elegido. */
export function WidgetView({ result, chart, higherIsBetter = true }: { result: Result; chart: string; higherIsBetter?: boolean }) {
  const [showTable, setShowTable] = useState(chart === "table");
  if (result.kind === "error") return <p className="widget-empty">{result.message}</p>;
  if (result.kind === "single") return <StatTile r={result} higherIsBetter={higherIsBetter} />;

  const hasData = result.points.some((p) => p.value !== null && p.value !== 0);
  if (!hasData) return <p className="widget-empty">Todavía no hay datos en este periodo.</p>;

  return (
    <div className="widget-body">
      {showTable || chart === "table"
        ? <DataTable points={result.points} format={result.format} />
        : chart === "line" ? <LineChart points={result.points} format={result.format} />
        : <BarChart points={result.points} format={result.format} />}
      <div className="widget-foot">
        {result.truncated && <span className="meta">Se muestran los {result.points.length} primeros.</span>}
        {chart !== "table" && (
          <button type="button" className="link meta" onClick={() => setShowTable((v) => !v)}>
            {showTable ? "Ver gráfico" : "Ver tabla"}
          </button>
        )}
      </div>
    </div>
  );
}

function StatTile({ r, higherIsBetter }: { r: Extract<Result, { kind: "single" }>; higherIsBetter: boolean }) {
  // Las tasas se comparan en puntos porcentuales; el resto, en variación relativa.
  let change: { text: string; dir: number } | null = null;
  if (r.value !== null && r.previous !== null) {
    if (r.format === "percent") {
      const pp = Math.round((r.value - r.previous) * 100);
      change = { text: `${Math.abs(pp)} pp`, dir: Math.sign(pp) };
    } else if (r.previous !== 0) {
      const pct = Math.round(((r.value - r.previous) / Math.abs(r.previous)) * 100);
      change = { text: `${Math.abs(pct)} %`, dir: Math.sign(pct) };
    }
  }
  const tone = !change || change.dir === 0 ? "" : (change.dir > 0) === higherIsBetter ? "good" : "bad";
  return (
    <div className="stat">
      <div className="stat-value">{formatValue(r.value, r.format)}</div>
      {r.previousLabel && (
        <div className="stat-delta">
          {change && (
            <span className={`delta ${tone}`}>
              {change.dir > 0 ? "▲" : change.dir < 0 ? "▼" : "="} {change.dir === 0 ? "sin cambios" : change.text}
            </span>
          )}
          <span className="meta">{change ? " " : ""}frente a {r.previousLabel}: {formatValue(r.previous, r.format)}</span>
        </div>
      )}
    </div>
  );
}

function DataTable({ points, format }: { points: Point[]; format: Format }) {
  return (
    <div className="widget-table">
      <table>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}><td>{p.label}</td><td className="num">{formatValue(p.value, format)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BarChart({ points, format }: { points: Point[]; format: Format }) {
  const max = Math.max(...points.map((p) => p.value ?? 0), format === "percent" ? 0.0001 : 0);
  const top = format === "percent" ? Math.max(1, max) : max || 1;
  return (
    <ul className="bars" role="list">
      {points.map((p) => (
        <li key={p.key} title={`${p.label}: ${formatValue(p.value, format)}`}>
          <span className="bar-label">{p.label}</span>
          <span className="bar-track">
            <span className="bar" style={{ width: `${Math.max(0, ((p.value ?? 0) / top) * 100)}%` }} />
            <span className="bar-value">{formatValue(p.value, format, true)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function LineChart({ points, format }: { points: Point[]; format: Format }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = 200, padL = 56, padR = 16, padT = 12, padB = 26;
  const values = points.map((p) => p.value ?? 0);
  const ticks = niceTicks(Math.max(...values, 0), format);
  const top = ticks[ticks.length - 1] || 1;
  const innerW = width - padL - padR, innerH = height - padT - padB;
  const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / top) * innerH;
  const defined = points.map((p, i) => ({ i, v: p.value })).filter((p) => p.v !== null) as { i: number; v: number }[];
  const line = defined.map((p, k) => `${k === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = defined.length
    ? `${line}L${x(defined[defined.length - 1].i).toFixed(1)},${y(0)}L${x(defined[0].i).toFixed(1)},${y(0)}Z` : "";
  const step = Math.ceil(points.length / Math.max(2, Math.floor(innerW / 70)));
  const last = defined[defined.length - 1];

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - padL) / innerW) * (points.length - 1));
    setHover(Math.min(points.length - 1, Math.max(0, i)));
  };

  return (
    <div className="linechart" ref={ref}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img"
           aria-label={`Evolución: ${points.map((p) => `${p.label} ${formatValue(p.value, format)}`).join(", ")}`}
           onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} className="grid" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" className="tick">{formatValue(t, format, true)}</text>
          </g>
        ))}
        {points.map((p, i) => i % step === 0 || i === points.length - 1 ? (
          <text key={p.key} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="tick">{p.label}</text>
        ) : null)}
        <path d={area} className="area" />
        <path d={line} className="line" />
        {last && hover === null && (
          <>
            <circle cx={x(last.i)} cy={y(last.v)} r={4.5} className="dot" />
            <text x={Math.min(x(last.i), width - padR)} y={y(last.v) - 10} textAnchor="end" className="end-label">{formatValue(last.v, format, true)}</text>
          </>
        )}
        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} className="crosshair" />
            {points[hover].value !== null && <circle cx={x(hover)} cy={y(points[hover].value!)} r={4.5} className="dot" />}
          </>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: `${(x(hover) / width) * 100}%` }}>
          <strong>{formatValue(points[hover].value, format)}</strong>
          <span>{points[hover].label}</span>
        </div>
      )}
    </div>
  );
}
