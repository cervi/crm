"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { bulkRecordsAction } from "@/app/actions/contact";

type Opt = { value: string; label: string };
const CHECKS = "input.bulk-check";
const selectedIds = () => Array.from(document.querySelectorAll<HTMLInputElement>(CHECKS)).filter((c) => c.checked).map((c) => c.value);
const clear = () => {
  document.querySelectorAll<HTMLInputElement>(CHECKS).forEach((c) => { c.checked = false; });
  document.dispatchEvent(new Event("change"));
};

/** Barra de acciones en bloque para contactos o empresas. */
export function RecordBulkBar({ kind, users, types, sequences = [], tags = [] }: { kind: "person" | "organization"; users: Opt[]; types: Opt[]; sequences?: Opt[]; tags?: string[] }) {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [op, setOp] = useState("");
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<{ error?: string; message?: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    const sync = () => setCount(selectedIds().length);
    document.addEventListener("change", sync);
    sync();
    return () => document.removeEventListener("change", sync);
  }, []);
  if (count === 0 && !result) return null;

  const LABELS: Record<string, string> = { owner: "Cambiar responsable", tag: "Añadir etiqueta", untag: "Quitar etiqueta", activity: "Programar actividad", sequence: "Añadir a la secuencia", trash: "Mover a la papelera" };
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (op === "trash" && !armed) { setArmed(true); return; }
    setArmed(false);
    const data = Object.fromEntries(Array.from(new FormData(e.currentTarget).entries()).map(([k, v]) => [k, String(v)]));
    const ids = selectedIds();
    start(async () => {
      const r = await bulkRecordsAction(kind, ids, data);
      setResult(r);
      if (!r.error) { clear(); setOp(""); router.refresh(); }
    });
  };

  return (
    <div className="bulk-bar" role="region" aria-label="Acciones en bloque">
      {count > 0 && (
        <form onSubmit={submit} className="bulk-form">
          <strong>{count} seleccionado{count === 1 ? "" : "s"}</strong>
          <select name="op" aria-label="Acción" value={op} onChange={(e) => { setOp(e.target.value); setResult(null); setArmed(false); }} required>
            <option value="">Elegir acción…</option>
            <option value="owner">Cambiar responsable</option>
            <option value="tag">Añadir etiqueta</option>
            <option value="untag">Quitar etiqueta</option>
            <option value="activity">Programar una actividad</option>
            {kind === "person" && sequences.length > 0 && <option value="sequence">Añadir a una secuencia</option>}
            <option value="trash">Mover a la papelera</option>
          </select>
          {op === "owner" && (
            <select name="owner_id" aria-label="Nuevo responsable" defaultValue="">
              <option value="">Sin responsable</option>
              {users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          )}
          {(op === "tag" || op === "untag") && (
            <>
              <input name="tag" list="bulk-tags" aria-label="Etiqueta" placeholder="Etiqueta" required />
              <datalist id="bulk-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
            </>
          )}
          {op === "sequence" && (
            <select name="sequence_id" aria-label="Secuencia" required defaultValue="">
              <option value="" disabled>Secuencia…</option>
              {sequences.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
            </select>
          )}
          {op === "activity" && (
            <>
              <select name="type" aria-label="Tipo de actividad" defaultValue={types.find((t) => t.value === "call")?.value ?? types[0]?.value}>
                {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <input name="subject" aria-label="Asunto" placeholder="Asunto" required />
              <input name="due_date" type="date" aria-label="Fecha" required defaultValue={new Date().toISOString().slice(0, 10)} />
            </>
          )}
          {armed && <span className="confirm-inline">{`Se moverán ${count} a la papelera (se pueden recuperar durante un tiempo).`}</span>}
          <button type="submit" className={armed ? "btn small danger" : "btn small"} disabled={!op || pending}>
            {pending ? "Aplicando…" : !op ? "Aplicar" : armed ? `Sí, mover a la papelera (${count})` : `${LABELS[op]} (${count})`}
          </button>
          <button type="button" className="btn small secondary" onClick={() => { clear(); setResult(null); }}>Quitar selección</button>
        </form>
      )}
      {result && (
        <p className={result.error ? "form-error" : "bulk-result"} role={result.error ? "alert" : "status"}>
          {result.error ?? result.message} <button type="button" className="link-btn" onClick={() => setResult(null)}>Cerrar</button>
        </p>
      )}
    </div>
  );
}
