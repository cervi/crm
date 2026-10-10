"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BulkSelectAll } from "./DealBulkBar";
import { Icon } from "./Icon";

export type DataColumn = {
  key: string;
  label: string;
  /** Cabecera propia (p. ej. un enlace para ordenar); si no, `label`. */
  header?: ReactNode;
  className?: string;
  /** Oculta al principio (se puede mostrar desde «Columnas»). */
  hidden?: boolean;
  /** Fijada a la izquierda al principio. */
  pinned?: boolean;
  /** No se puede ocultar (la columna principal). */
  required?: boolean;
};
export type DataRow = { id: string; className?: string; label?: string; cells: Record<string, ReactNode> };

type Prefs = { order: string[]; hidden: string[]; pinned: string[] };

const load = (key: string): Prefs | null => {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as Prefs : null; } catch { return null; }
};
const save = (key: string, p: Prefs | null) => {
  try { if (p) localStorage.setItem(key, JSON.stringify(p)); else localStorage.removeItem(key); } catch { /* sin almacenamiento */ }
};

/**
 * Tabla con columnas a elegir (mostrar, ocultar, ordenar) y columnas fijadas a la
 * izquierda que no se mueven al desplazarse en horizontal. La elección se guarda
 * en este navegador, por tabla.
 */
export function DataTable({ id, columns, rows, selectable, empty, colSettingsLabel = "Columnas" }: {
  id: string; columns: DataColumn[]; rows: DataRow[]; selectable?: boolean; empty?: ReactNode; colSettingsLabel?: string;
}) {
  const storageKey = `crm.table.${id}`;
  const defaults = useMemo<Prefs>(() => ({
    order: columns.map((c) => c.key),
    hidden: columns.filter((c) => c.hidden).map((c) => c.key),
    pinned: columns.filter((c) => c.pinned).map((c) => c.key),
  }), [columns]);
  const [prefs, setPrefs] = useState<Prefs>(defaults);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    const stored = load(storageKey);
    if (stored) { setPrefs(stored); setCustom(true); } else { setPrefs(defaults); setCustom(false); }
  }, [storageKey, defaults]);

  const update = (next: Prefs) => { setPrefs(next); setCustom(true); save(storageKey, next); };
  const reset = () => { setPrefs(defaults); setCustom(false); save(storageKey, null); };

  const byKey = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  // Orden efectivo: lo guardado (sin columnas que ya no existen) + columnas nuevas al final.
  const ordered = useMemo(() => {
    const known = prefs.order.filter((k) => byKey.has(k));
    return [...known, ...columns.map((c) => c.key).filter((k) => !known.includes(k))];
  }, [prefs.order, byKey, columns]);
  const isHidden = (k: string) => !byKey.get(k)?.required && prefs.hidden.includes(k);
  const isPinned = (k: string) => prefs.pinned.includes(k);
  const visible = [...ordered.filter((k) => isPinned(k) && !isHidden(k)), ...ordered.filter((k) => !isPinned(k) && !isHidden(k))];
  const pinnedVisible = visible.filter(isPinned);

  // Posición de las columnas fijadas: se mide el ancho real de cada cabecera.
  const headRefs = useRef(new Map<string, HTMLTableCellElement>());
  const checkRef = useRef<HTMLTableCellElement>(null);
  const [lefts, setLefts] = useState<Record<string, number>>({});
  const measure = useCallback(() => {
    let x = selectable ? checkRef.current?.offsetWidth ?? 0 : 0;
    const next: Record<string, number> = {};
    for (const k of pinnedVisible) { next[k] = x; x += headRefs.current.get(k)?.offsetWidth ?? 0; }
    setLefts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [pinnedVisible.join("|"), selectable]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    headRefs.current.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [measure]);

  const lastPinned = pinnedVisible[pinnedVisible.length - 1];
  const cellProps = (k: string, base?: string) => {
    const pin = isPinned(k);
    const cls = [base, pin && "pin", k === lastPinned && "pin-last"].filter(Boolean).join(" ") || undefined;
    return { className: cls, style: pin ? { left: lefts[k] ?? 0 } : undefined };
  };

  return (
    <div className="table-wrap data-table">
      <table>
        <thead>
          <tr>
            {selectable && <th ref={checkRef} className={`check-col${pinnedVisible.length ? " pin" : ""}`} style={pinnedVisible.length ? { left: 0 } : undefined}><BulkSelectAll /></th>}
            {visible.map((k) => {
              const c = byKey.get(k)!;
              return (
                <th key={k} ref={(el) => { if (el) headRefs.current.set(k, el); else headRefs.current.delete(k); }} {...cellProps(k, c.className)}>
                  {c.header ?? c.label}
                </th>
              );
            })}
            <th className="col-settings">
              <ColumnMenu label={colSettingsLabel} columns={ordered.map((k) => byKey.get(k)!)} isHidden={isHidden} isPinned={isPinned}
                          custom={custom} reset={reset}
                          toggleHidden={(k) => update({ ...prefs, order: ordered, hidden: isHidden(k) ? prefs.hidden.filter((x) => x !== k) : [...prefs.hidden, k] })}
                          togglePinned={(k) => update({ ...prefs, order: ordered, pinned: isPinned(k) ? prefs.pinned.filter((x) => x !== k) : [...prefs.pinned, k], hidden: prefs.hidden.filter((x) => x !== k) })}
                          move={(k, dir) => {
                            const o = [...ordered]; const i = o.indexOf(k); const j = i + dir;
                            if (j < 0 || j >= o.length) return;
                            [o[i], o[j]] = [o[j], o[i]];
                            update({ ...prefs, order: o });
                          }} />
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={visible.length + (selectable ? 2 : 1)} className="empty-row">{empty ?? "Sin resultados."}</td></tr>}
          {rows.map((r) => (
            <tr key={r.id} className={r.className}>
              {selectable && (
                <td className={`check-col${pinnedVisible.length ? " pin" : ""}`} style={pinnedVisible.length ? { left: 0 } : undefined}>
                  <input type="checkbox" className="bulk-check" value={r.id} aria-label={`Seleccionar ${r.label ?? ""}`.trim()} />
                </td>
              )}
              {visible.map((k) => <td key={k} {...cellProps(k, byKey.get(k)!.className)}>{r.cells[k] ?? <span className="muted">—</span>}</td>)}
              <td className="col-settings" />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ColumnMenu({ label, columns, isHidden, isPinned, toggleHidden, togglePinned, move, reset, custom }: {
  label: string; columns: DataColumn[]; isHidden: (k: string) => boolean; isPinned: (k: string) => boolean;
  toggleHidden: (k: string) => void; togglePinned: (k: string) => void; move: (k: string, dir: -1 | 1) => void;
  reset: () => void; custom: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const shown = columns.filter((c) => c.label.toLowerCase().includes(q.trim().toLowerCase()));
  const hiddenCount = columns.filter((c) => isHidden(c.key)).length;

  return (
    <div className="col-menu" ref={ref}>
      <button type="button" className="col-menu-btn" aria-haspopup="dialog" aria-expanded={open} title={`${label}: elegir, ordenar y fijar`}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
                setOpen((o) => !o);
              }}>
        <Icon name="settings" /><span className="sr-only">{label}</span>
      </button>
      {open && pos && (
        <div className="col-pop" role="dialog" aria-label={label} style={{ top: pos.top, right: pos.right }}>
          <div className="col-pop-head">
            <strong>{label}</strong>
            <span className="meta">{columns.length - hiddenCount} de {columns.length} visibles</span>
          </div>
          {columns.length > 10 && <input className="col-search" placeholder="Buscar columna…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar columna" autoFocus />}
          <ul>
            {shown.map((c) => {
              const i = columns.indexOf(c);
              return (
                <li key={c.key} className={isHidden(c.key) ? "off" : undefined}>
                  <label className="checkbox">
                    <input type="checkbox" checked={!isHidden(c.key)} disabled={c.required} onChange={() => toggleHidden(c.key)} />
                    <span>{c.label}</span>
                  </label>
                  <span className="col-tools">
                    <button type="button" className={isPinned(c.key) ? "on" : undefined} aria-pressed={isPinned(c.key)}
                            title={isPinned(c.key) ? "Soltar (deja de estar fija a la izquierda)" : "Fijar a la izquierda: no se mueve al desplazarte"}
                            onClick={() => togglePinned(c.key)}><Icon name="pin" /></button>
                    <button type="button" title="Subir" disabled={i === 0 || !!q} onClick={() => move(c.key, -1)}><Icon name="up" /></button>
                    <button type="button" title="Bajar" disabled={i === columns.length - 1 || !!q} onClick={() => move(c.key, 1)}><Icon name="chevron" /></button>
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="col-pop-foot">
            <span className="meta">Se guarda en este navegador.</span>
            {custom && <button type="button" className="link-btn meta" onClick={reset}>Restablecer</button>}
          </div>
        </div>
      )}
    </div>
  );
}
