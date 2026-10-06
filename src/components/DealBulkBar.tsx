"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { bulkDealsAction } from "@/app/actions/deals";

type Opt = { value: string; label: string };
const CHECKS = "input.bulk-check";

const selectedIds = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>(CHECKS)).filter((c) => c.checked).map((c) => c.value);

/** Casilla de la cabecera: marca o desmarca todos los deals de la lista. */
export function BulkSelectAll() {
  const [state, setState] = useState<"none" | "some" | "all">("none");
  useEffect(() => {
    const sync = () => {
      const all = document.querySelectorAll<HTMLInputElement>(CHECKS);
      const n = Array.from(all).filter((c) => c.checked).length;
      setState(n === 0 ? "none" : n === all.length ? "all" : "some");
    };
    document.addEventListener("change", sync);
    sync();
    return () => document.removeEventListener("change", sync);
  }, []);
  return (
    <input type="checkbox" aria-label="Seleccionar todos" checked={state === "all"}
           ref={(el) => { if (el) el.indeterminate = state === "some"; }}
           onChange={(e) => {
             document.querySelectorAll<HTMLInputElement>(CHECKS).forEach((c) => { c.checked = e.target.checked; });
             document.dispatchEvent(new Event("change"));
           }} />
  );
}

/** Barra que aparece al marcar deals: cambiar responsable, fase, ganar/perder o crear una actividad para todos. */
export function DealBulkBar({ users, stages, reasons, types, sequences = [] }: { users: Opt[]; stages: Opt[]; reasons: Opt[]; types: Opt[]; sequences?: Opt[] }) {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [op, setOp] = useState("");
  const [result, setResult] = useState<{ error?: string; message?: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const sync = () => setCount(selectedIds().length);
    document.addEventListener("change", sync);
    sync();
    return () => document.removeEventListener("change", sync);
  }, []);

  if (count === 0 && !result) return null;

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = Object.fromEntries(Array.from(new FormData(e.currentTarget).entries()).map(([k, v]) => [k, String(v)]));
    const ids = selectedIds();
    start(async () => {
      const r = await bulkDealsAction(ids, data);
      setResult(r);
      if (!r.error) {
        document.querySelectorAll<HTMLInputElement>(CHECKS).forEach((c) => { c.checked = false; });
        document.dispatchEvent(new Event("change"));
        setOp("");
        router.refresh();
      }
    });
  };

  return (
    <div className="bulk-bar" role="region" aria-label="Acciones en bloque">
      {count > 0 ? (
        <form onSubmit={submit} className="bulk-form">
          <strong>{count} seleccionado{count === 1 ? "" : "s"}</strong>
          <select name="op" aria-label="Acción" value={op} onChange={(e) => { setOp(e.target.value); setResult(null); }} required>
            <option value="">Elegir acción…</option>
            <option value="owner">Cambiar responsable</option>
            <option value="stage">Mover a otra fase</option>
            <option value="activity">Programar una actividad</option>
            {sequences.length > 0 && <option value="sequence">Añadir a una secuencia</option>}
            <option value="won">Marcar como ganados</option>
            <option value="lost">Marcar como perdidos</option>
          </select>
          {op === "owner" && (
            <select name="owner_id" aria-label="Nuevo responsable" defaultValue="">
              <option value="">Sin responsable</option>
              {users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          )}
          {op === "stage" && (
            <select name="stage_id" aria-label="Fase" required defaultValue="">
              <option value="" disabled>Fase…</option>
              {stages.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          )}
          {op === "sequence" && (
            <select name="sequence_id" aria-label="Secuencia" required defaultValue="">
              <option value="" disabled>Secuencia…</option>
              {sequences.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
            </select>
          )}
          {op === "lost" && (
            <>
              <select name="lost_reason_id" aria-label="Motivo de pérdida" required defaultValue="">
                <option value="" disabled>Motivo…</option>
                {reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <input name="lost_note" aria-label="Nota" placeholder="Nota (opcional)" />
            </>
          )}
          {op === "activity" && (
            <>
              <select name="type" aria-label="Tipo de actividad" defaultValue={types.find((t) => t.value === "task")?.value ?? types[0]?.value}>
                {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <input name="subject" aria-label="Asunto" placeholder="Asunto" required />
              <input name="due_date" type="date" aria-label="Fecha" required defaultValue={new Date().toISOString().slice(0, 10)} />
            </>
          )}
          <button type="submit" className="btn small" disabled={!op || pending}>{pending ? "Aplicando…" : "Aplicar"}</button>
          <button type="button" className="btn small secondary" onClick={() => {
            document.querySelectorAll<HTMLInputElement>(CHECKS).forEach((c) => { c.checked = false; });
            document.dispatchEvent(new Event("change"));
            setResult(null);
          }}>Quitar selección</button>
        </form>
      ) : null}
      {result && (
        <p className={result.error ? "form-error" : "bulk-result"} role={result.error ? "alert" : "status"}>
          {result.error ?? result.message}
          {" "}<button type="button" className="link-btn" onClick={() => setResult(null)}>Cerrar</button>
        </p>
      )}
    </div>
  );
}
