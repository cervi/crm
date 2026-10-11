"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";
import type { ActionState } from "@/lib/errors";

export type EnrollmentRow = {
  id: string; person_id: string; person_name: string; email: string | null; organization_name: string | null; status: string;
  status_label: string; tone: string; reason: string | null; step_text: string; next_text: string | null; mailbox_email: string | null;
  sent: number; opened: number; replied: boolean; added: string; deal_id: string | null; deal_title: string | null;
};

type Props = {
  rows: EnrollmentRow[];
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  mailboxes: { id: string; label: string }[];
  steps: { index: number; label: string }[];
  canEdit: boolean;
};

const OPS = [
  { key: "pause", label: "Pausar" },
  { key: "resume", label: "Reanudar" },
  { key: "finish", label: "Marcar como terminados" },
  { key: "remove", label: "Quitar de la secuencia" },
  { key: "mailbox", label: "Cambiar el buzón" },
  { key: "step", label: "Mover a un paso" },
  { key: "retry", label: "Reintentar (los que fallaron)" },
] as const;

/** Contactos de la secuencia con selección y acciones en bloque (como la pestaña «Contacts» de Apollo). */
export function EnrollmentTable({ rows, action, mailboxes, steps, canEdit }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [op, setOp] = useState<string>("");
  const [state, formAction, pending] = useActionState(action, undefined);
  useEffect(() => { if (state?.ok) { setSelected(new Set()); setOp(""); } }, [state]);
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = useMemo(() => [...selected], [selected]);

  return (
    <form action={formAction} className="enroll-table">
      {ids.map((id) => <input key={id} type="hidden" name="ids" value={id} />)}
      {canEdit && (
        <div className={`seq-bulk${ids.length ? " on" : ""}`} role="region" aria-label="Acciones en bloque">
          <strong>{ids.length ? `${ids.length} seleccionado${ids.length === 1 ? "" : "s"}` : "Selecciona contactos para actuar en bloque"}</strong>
          {ids.length > 0 && (
            <>
              <select name="op" value={op} onChange={(e) => setOp(e.target.value)} aria-label="Acción" required>
                <option value="">Elige qué hacer…</option>
                {OPS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
              </select>
              {op === "pause" && <label className="inline-field">Reanudar el <input type="date" name="resume_at" min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} /> <span className="meta">(opcional)</span></label>}
              {op === "finish" && <input name="reason" placeholder="Motivo (p. ej. «No es el momento»)" maxLength={120} required aria-label="Motivo" />}
              {op === "mailbox" && (
                <select name="mailbox_id" required aria-label="Buzón" defaultValue="">
                  <option value="" disabled>Buzón…</option>
                  {mailboxes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              )}
              {op === "step" && (
                <select name="step" required aria-label="Paso" defaultValue="">
                  <option value="" disabled>Paso…</option>
                  {steps.map((s) => <option key={s.index} value={s.index}>{s.label}</option>)}
                </select>
              )}
              <button type="submit" className={op === "remove" || op === "finish" ? "btn danger small" : "btn small"} disabled={!op || pending}>
                {pending ? "Aplicando…" : "Aplicar"}</button>
              <button type="button" className="btn secondary small" onClick={() => setSelected(new Set())}>Quitar selección</button>
            </>
          )}
          {state?.error && <span className="form-error" role="alert">{state.error}</span>}
          {state?.ok && state.message && <span className="form-ok" role="status">{state.message}</span>}
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {canEdit && <th className="check-col"><input type="checkbox" checked={all} aria-label="Seleccionar todos"
                                onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} /></th>}
              <th>Contacto</th><th>Estado</th><th>Paso</th><th>Próximo</th><th>Buzón</th><th className="num">Enviados</th><th className="num">Abiertos</th><th>Añadido</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={selected.has(r.id) ? "row-selected" : undefined}>
                {canEdit && <td className="check-col"><input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Seleccionar a ${r.person_name}`} /></td>}
                <td><Link href={`/persons/${r.person_id}`}><strong>{r.person_name}</strong></Link>
                  <div className="meta">{[r.email ?? "sin email", r.organization_name].filter(Boolean).join(" · ")}</div>
                  {r.deal_id && <div className="meta"><Link href={`/deals/${r.deal_id}`}>{r.deal_title}</Link></div>}</td>
                <td><span className={`badge ${r.tone}`}>{r.status_label}</span>{r.replied && r.status !== "removed" && <span className="badge won" style={{ marginLeft: 4 }}>Respondió</span>}
                  {r.reason && <div className="meta">{r.reason}</div>}</td>
                <td className="nowrap">{r.step_text}</td>
                <td className="nowrap">{r.next_text ?? <span className="muted">—</span>}</td>
                <td className="meta">{r.mailbox_email ?? "—"}</td>
                <td className="num">{r.sent || "—"}</td>
                <td className="num">{r.opened || "—"}</td>
                <td className="nowrap meta">{r.added}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </form>
  );
}
