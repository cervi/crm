"use client";

import { useState } from "react";

// Embudo: una barra centrada por fase, de ancho proporcional a cuántos llegan,
// con la conversión entre fases y una ficha al pasar el ratón. Un solo color
// (series-1): aquí el color no distingue series, solo marca la cantidad.

/** `late`: fases que tardan (deal ganado…): no cuentan para la «mayor caída». */
export type FunnelStage = { key: string; label: string; value: number; note?: string; late?: boolean };

const num = new Intl.NumberFormat("es-ES");
const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)} %` : "—");

export function Funnel({ stages, onStage }: { stages: FunnelStage[]; onStage?: Record<string, string> }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = Math.max(1, stages[0]?.value ?? 0);
  // La caída más grande (en proporción) entre dos fases con gente: la que conviene mirar.
  let worst = -1, worstRate = 1;
  stages.forEach((s, i) => {
    if (i === 0 || s.late || stages[i - 1].value === 0) return;
    const r = s.value / stages[i - 1].value;
    if (r < worstRate) { worstRate = r; worst = i; }
  });
  return (
    <ol className="cfunnel" aria-label="Embudo de la campaña" onMouseLeave={() => setHover(null)}>
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1].value : null;
        const width = s.value > 0 ? Math.max(4, (s.value / top) * 100) : 0;
        const href = onStage?.[s.key];
        const body = (
          <>
            <span className="cfunnel-label">{s.label}</span>
            <span className="cfunnel-track">
              <span className={`cfunnel-bar${s.value === 0 ? " is-zero" : ""}`} style={{ width: `${width}%` }} />
            </span>
            <span className="cfunnel-value"><b>{num.format(s.value)}</b><span className="meta">{i === 0 ? "" : pct(s.value, top)}</span></span>
          </>
        );
        return (
          <li key={s.key} className={`${hover === i ? "on" : ""}${worst === i ? " worst" : ""}`}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
            {prev !== null && (
              <span className="cfunnel-step" aria-label={`De ${stages[i - 1].label.toLowerCase()} a ${s.label.toLowerCase()}: ${pct(s.value, prev)}`}>
                ↓ {pct(s.value, prev)}{worst === i && <span className="cfunnel-flag">mayor caída</span>}
              </span>
            )}
            {href ? <a className="cfunnel-row" href={href}>{body}</a> : <div className="cfunnel-row" tabIndex={0}>{body}</div>}
            {hover === i && (
              <div className="chart-tip cfunnel-tip" role="tooltip">
                <strong>{s.label}</strong>
                <span className="tip-row"><span>Contactos</span><b>{num.format(s.value)}</b></span>
                {i > 0 && <span className="tip-row"><span>Del total</span><b>{pct(s.value, top)}</b></span>}
                {prev !== null && <span className="tip-row"><span>De la fase anterior</span><b>{pct(s.value, prev)}</b></span>}
                {prev !== null && prev - s.value > 0 && <span className="tip-row"><span>Se quedan aquí</span><b>{num.format(prev - s.value)}</b></span>}
                {s.note && <span className="tip-note">{s.note}</span>}
                {href && <span className="tip-hint">Haz clic para ver quiénes son</span>}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
