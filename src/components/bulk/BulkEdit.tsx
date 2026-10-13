"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { bulkEditAction, bulkQuickAction } from "@/app/actions/bulk";
import type { BulkEntity, BulkField } from "@/lib/bulk-edit";
import { Icon } from "../Icon";

// Selección en las tablas: las casillas .bulk-check de DataTable (y su «seleccionar todo»).
const CHECKS = "input.bulk-check";
export const selectedIds = () => Array.from(document.querySelectorAll<HTMLInputElement>(CHECKS)).filter((c) => c.checked).map((c) => c.value);
export const clearSelection = () => {
  document.querySelectorAll<HTMLInputElement>(CHECKS).forEach((c) => { c.checked = false; });
  document.dispatchEvent(new Event("change"));
};
export function useSelectedCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const sync = () => setCount(selectedIds().length);
    document.addEventListener("change", sync);
    sync();
    return () => document.removeEventListener("change", sync);
  }, []);
  return count;
}

const NOUNS: Record<BulkEntity, [string, string]> = {
  activity: ["actividad", "actividades"], deal: ["deal", "deals"], person: ["contacto", "contactos"], organization: ["empresa", "empresas"], lead: ["lead", "leads"],
};
const many = (e: BulkEntity, n: number) => `${n} ${n === 1 ? NOUNS[e][0] : NOUNS[e][1]}`;

/**
 * «Editar en grupo» (como en Pipedrive): un panel lateral con los campos de la
 * tabla. Cada uno empieza en «Mantener el valor actual»; se cambian solo los que
 * se toquen, en todos los registros marcados.
 */
export function BulkEditPanel({ entity, fields, onDone }: { entity: BulkEntity; fields: BulkField[]; onDone: (msg: { error?: string; message?: string }) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [modes, setModes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const count = useSelectedCount();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const changed = Object.values(modes).filter((m) => m !== "keep").length;

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = Object.fromEntries(Array.from(new FormData(e.currentTarget).entries()).map(([k, v]) => [k, String(v)]));
    const ids = selectedIds();
    start(async () => {
      const r = await bulkEditAction(entity, ids, data);
      if (r.error) { setError(r.error); return; }
      setOpen(false); setModes({}); setError(null);
      clearSelection();
      onDone(r);
      router.refresh();
    });
  };

  return (
    <>
      <button type="button" className="btn small" onClick={() => { setOpen(true); setError(null); }} aria-haspopup="dialog">
        <Icon name="pencil" />Editar en grupo
      </button>
      <dialog ref={ref} className="drawer" aria-label="Edición en grupo" onClose={() => setOpen(false)}
              onClick={(e) => { if (e.target === ref.current) setOpen(false); }}>
        {open && (
          <form className="drawer-inner bulk-edit" onSubmit={submit}>
            <header className="drawer-head">
              <div>
                <h2>Edición en grupo <span className="count">{count} seleccionad{entity === "activity" || entity === "organization" ? "a" : "o"}{count === 1 ? "" : "s"}</span></h2>
                <p className="meta">Solo cambia lo que toques. El resto se queda como está en cada uno.</p>
              </div>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar" title="Cerrar"><Icon name="x" /></button>
            </header>
            <div className="drawer-body">
              {fields.map((f) => {
                const mode = modes[f.key] ?? "keep";
                return (
                  <div key={f.key} className={`bulk-field${mode !== "keep" ? " on" : ""}`}>
                    <label className="label" htmlFor={`m_${f.key}`}>{f.label}</label>
                    <select id={`m_${f.key}`} name={`m_${f.key}`} value={mode} onChange={(e) => setModes((m) => ({ ...m, [f.key]: e.target.value }))}>
                      <option value="keep">Mantener el valor actual</option>
                      <option value="set">{f.key === "postpone" ? "Mover…" : "Cambiar a…"}</option>
                      {f.clearable && <option value="clear">Dejar vacío</option>}
                    </select>
                    {mode === "set" && (
                      f.kind === "select" ? (
                        <select name={`v_${f.key}`} aria-label={`Nuevo valor de ${f.label}`} required defaultValue="">
                          <option value="" disabled>Elige…</option>
                          {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (
                        <input name={`v_${f.key}`} aria-label={`Nuevo valor de ${f.label}`} required autoFocus
                               type={f.kind === "date" ? "date" : f.kind === "time" ? "time" : f.kind === "number" ? "number" : "text"}
                               step={f.kind === "number" ? "any" : undefined} placeholder={f.key === "postpone" ? "p. ej. 3" : undefined} />
                      )
                    )}
                    {mode === "set" && f.help && <span className="meta">{f.help}</span>}
                  </div>
                );
              })}
            </div>
            <footer className="drawer-foot">
              {error && <p className="form-error" role="alert">{error}</p>}
              <button type="submit" className="btn" disabled={!changed || pending || !count}>
                {pending ? "Aplicando…" : changed ? `Editar ${many(entity, count)}` : "Elige qué cambiar"}
              </button>
              <button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancelar</button>
            </footer>
          </form>
        )}
      </dialog>
    </>
  );
}

export type QuickAction = { op: string; label: string; confirm?: string; danger?: boolean };

/** Barra de acciones en bloque para tablas sin barra propia (actividades, leads): acciones rápidas + editar en grupo. */
export function BulkBar({ entity, fields, quick = [] }: { entity: BulkEntity; fields: BulkField[]; quick?: QuickAction[] }) {
  const router = useRouter();
  const count = useSelectedCount();
  const [result, setResult] = useState<{ error?: string; message?: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (count === 0 && !result) return null;
  const run = (q: QuickAction) => {
    if (q.confirm && armed !== q.op) { setArmed(q.op); return; }
    setArmed(null);
    const ids = selectedIds();
    start(async () => {
      const r = await bulkQuickAction(entity, q.op, ids);
      setResult(r);
      if (!r.error) { clearSelection(); router.refresh(); }
    });
  };
  const armedQ = quick.find((q) => q.op === armed);
  return (
    <div className="bulk-bar" role="region" aria-label="Acciones en bloque">
      {count > 0 && (
        <div className="bulk-form">
          <strong>{many(entity, count)}</strong>
          <BulkEditPanel entity={entity} fields={fields} onDone={setResult} />
          {quick.map((q) => (
            <button key={q.op} type="button" className={`btn small ${armed === q.op ? "danger" : "secondary"}`} disabled={pending} onClick={() => run(q)}>
              {armed === q.op ? `Sí, ${q.label.toLowerCase()} (${count})` : q.label}
            </button>
          ))}
          {armedQ && <span className="confirm-inline">{armedQ.confirm} <button type="button" className="link-btn" onClick={() => setArmed(null)}>Cancelar</button></span>}
          <button type="button" className="btn small secondary" onClick={() => { clearSelection(); setResult(null); setArmed(null); }}>Quitar selección</button>
        </div>
      )}
      {result && (
        <p className={result.error ? "form-error" : "bulk-result"} role={result.error ? "alert" : "status"}>
          {result.error ?? result.message} <button type="button" className="link-btn" onClick={() => setResult(null)}>Cerrar</button>
        </p>
      )}
    </div>
  );
}
