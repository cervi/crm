"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";

export type DrillRequest = { title: string; subtitle?: string; query: Record<string, string> };
type Row = { id: string; href: string; title: string; who: string | null; owner: string | null; value: number | null; currency: string | null; date: string; detail: string | null };

const eur = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0, useGrouping: "always" } as Intl.NumberFormatOptions);
const day = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" });

/** Panel con lo que hay detrás de una barra: los deals (o actividades) de ese periodo. */
export function DrillPanel({ req, onClose }: { req: DrillRequest | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (req && !d.open) d.showModal();
    if (!req && d.open) d.close();
    if (!req) return;
    setRows(null); setError(null);
    const ctrl = new AbortController();
    fetch(`/api/reports/drill?${new URLSearchParams(req.query)}`, { signal: ctrl.signal })
      .then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error ?? "No se pudo cargar el detalle."); setRows(j.rows); })
      .catch((e) => { if (e.name !== "AbortError") setError(e.message || "No se pudo cargar el detalle."); });
    return () => ctrl.abort();
  }, [req]);

  const isActs = req?.query.m === "activities";
  const total = rows?.reduce((n, r) => n + (r.value ?? 0), 0) ?? 0;
  return (
    <dialog ref={ref} className="drawer" aria-label={req?.title ?? "Detalle"} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      {req && (
        <div className="drawer-inner">
          <header className="drawer-head">
            <div>
              <h2>{req.title}</h2>
              <p className="meta">{req.subtitle}{rows ? ` · ${rows.length}${rows.length >= 300 ? "+" : ""} ${isActs ? "actividades" : "deals"}${!isActs && total ? ` · ${eur.format(total)}` : ""}` : ""}</p>
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Cerrar" title="Cerrar"><Icon name="x" /></button>
          </header>
          <div className="drawer-body">
            {error && <p className="form-error" role="alert">{error}</p>}
            {!rows && !error && <p className="muted" role="status">Cargando el detalle…</p>}
            {rows && rows.length === 0 && <p className="muted">No hay nada en este periodo.</p>}
            {rows && rows.length > 0 && (
              <div className="table-wrap">
                <table className="drill-table">
                  <thead><tr><th>{isActs ? "Actividad" : "Deal"}</th><th>{isActs ? "Tipo" : "Situación"}</th>{!isActs && <th className="num">Importe</th>}<th>Fecha</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td><Link href={r.href}><strong>{r.title}</strong></Link>
                          <div className="meta">{[r.who, r.owner].filter(Boolean).join(" · ")}</div></td>
                        <td>{r.detail ?? "—"}</td>
                        {!isActs && <td className="num">{r.value !== null ? eur.format(r.value) : "—"}</td>}
                        <td className="nowrap">{day.format(new Date(r.date))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </dialog>
  );
}
