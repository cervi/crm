"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { bulkInboxAction } from "@/app/actions/automations";
import type { ActionState } from "@/lib/errors";
import { Icon, type IconName } from "../Icon";

export type InboxRow = {
  id: string; title: string; type: string; typeLabel: string; context: string | null; age: string; href: string; selected: boolean; bulkApprovable: boolean;
};

const TYPE_ICON: Record<string, IconName> = {
  draft_email: "mail", create_task: "check", add_note: "pencil", move_stage: "deals", update_deal: "pencil", notify: "bell", create_deal: "plus", webhook: "send",
};

/** Lista de propuestas: cada fila abre la propuesta a la derecha; con las casillas se aprueban o descartan varias. */
export function InboxList({ rows, canEdit }: { rows: InboxRow[]; canEdit: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(bulkInboxAction, undefined);
  const [, start] = useTransition();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { if (state?.ok) { setChecked(new Set()); setConfirm(false); } }, [state]);
  const all = rows.length > 0 && checked.size === rows.length;
  const toggle = (id: string) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const approvable = rows.filter((r) => checked.has(r.id) && r.bulkApprovable).length;
  const send = (op: "approve" | "dismiss") => {
    const data = new FormData();
    data.set("op", op);
    checked.forEach((id) => data.append("id", id));
    start(() => action(data));
  };

  return (
    <form ref={formRef} className="inbox-list" onSubmit={(e) => e.preventDefault()} aria-label="Propuestas">
      {canEdit && rows.length > 0 && (
        <div className="inbox-bulk">
          <label className="checkbox"><input type="checkbox" checked={all} onChange={() => setChecked(all ? new Set() : new Set(rows.map((r) => r.id)))} />
            {checked.size ? `${checked.size} marcada${checked.size === 1 ? "" : "s"}` : "Marcar todas"}</label>
          {checked.size > 0 && !confirm && (
            <span className="inbox-bulk-actions">
              <button type="button" className="btn secondary small" disabled={pending || approvable === 0} onClick={() => send("approve")}
                      title={approvable < checked.size ? "Los correos no se aprueban en bloque: revísalos uno a uno" : undefined}>
                Aprobar{approvable && approvable < checked.size ? ` ${approvable}` : ""}
              </button>
              <button type="button" className="btn secondary small" disabled={pending} onClick={() => setConfirm(true)}>Descartar</button>
            </span>
          )}
          {confirm && (
            <span className="inbox-bulk-actions" role="alert">
              <span className="meta">¿Descartar {checked.size}?</span>
              <button type="button" className="btn danger small" disabled={pending} onClick={() => send("dismiss")}>Sí, descartar</button>
              <button type="button" className="btn secondary small" onClick={() => setConfirm(false)}>Cancelar</button>
            </span>
          )}
        </div>
      )}
      {state?.error && <p className="form-error" role="alert">{state.error}</p>}
      {state?.ok && state.message && <p className="form-ok" role="status">{state.message}</p>}
      <ul>
        {rows.map((r) => (
          <li key={r.id} className={r.selected ? "on" : undefined}>
            {canEdit && <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Marcar «${r.title}»`} />}
            <Link href={r.href} aria-current={r.selected ? "true" : undefined} scroll={false}>
              <span className="inbox-row-top">
                <span className="inbox-type"><Icon name={TYPE_ICON[r.type] ?? "spark"} />{r.typeLabel}</span>
                <span className="meta">{r.age}</span>
              </span>
              <strong>{r.title}</strong>
              {r.context && <span className="meta inbox-ctx">{r.context}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </form>
  );
}
