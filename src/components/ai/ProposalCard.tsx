import Link from "next/link";
import { actionLabel, isUndoable, type InboxItem } from "@/lib/automations";
import { dateTime } from "@/lib/format";
import { approveAction, dismissActionAction, undoActionAction } from "@/app/actions/automations";
import { ActionForm } from "../ActionForm";
import { Icon } from "../Icon";
import { EmailDraftFields } from "./EmailDraftFields";

const APPROVE_LABEL: Record<string, string> = {
  create_task: "Crear tarea",
  draft_email: "Marcar como enviado",
  add_note: "Añadir nota",
  move_stage: "Mover",
  update_deal: "Aplicar cambios",
  notify: "Entendido",
};

const s = (v: unknown) => (typeof v === "string" ? v : "");

/** Quién propone: una regla del asistente o un agente externo. */
export const proposer = (i: InboxItem) =>
  i.actor === "external" ? (i.agent_name ?? "Agente externo") : (i.rule_name ?? "Asistente");

/** Propuesta pendiente en la bandeja de decisiones (o en el panel del deal). */
export function ProposalCard({ item, showDeal = true }: { item: InboxItem; showDeal?: boolean }) {
  const p = item.payload;
  return (
    <article className="proposal" aria-label={item.title}>
      <div className="proposal-head">
        <span className="badge ai"><Icon name="spark" />{actionLabel(item.action_type)}</span>
        <span className="meta">{proposer(item)} · {dateTime(item.created_at)}</span>
        <ActionForm action={dismissActionAction.bind(null, item.id)} submitLabel="Descartar" pendingLabel="…" secondary className="form inline proposal-dismiss" />
      </div>
      <h3>{item.title}</h3>
      <p className="muted proposal-reason">
        {item.reason}
        {showDeal && item.deal_id && (
          <> · <Link href={`/deals/${item.deal_id}`}>{item.deal_title}</Link>{item.organization_name && <span className="meta"> ({item.organization_name})</span>}</>
        )}
      </p>
      <ActionForm action={approveAction.bind(null, item.id)} submitLabel={APPROVE_LABEL[item.action_type] ?? "Aprobar"} pendingLabel="…" good>
        {item.action_type === "draft_email" && <EmailDraftFields to={s(p.to)} subject={s(p.subject)} body={s(p.body)} />}
        {item.action_type === "create_task" && (
          <>
            <label className="field"><span className="label">Tarea</span><input name="subject" defaultValue={s(p.subject)} required /></label>
            {s(p.note) && (
              <details className="proposal-note">
                <summary className="meta">Ver y editar la descripción</summary>
                <textarea name="note" rows={s(p.note).split("\n").length + 1} defaultValue={s(p.note)} aria-label="Descripción" />
              </details>
            )}
          </>
        )}
        {item.action_type === "add_note" && <p className="note-body">{s(p.content)}</p>}
      </ActionForm>
    </article>
  );
}

const STATUS: Record<string, { label: string; tone: string }> = {
  dismissed: { label: "Descartada", tone: "" },
  expired: { label: "Caducada", tone: "" },
  failed: { label: "Falló", tone: "lost" },
  undone: { label: "Deshecha", tone: "warn" },
};

export function statusLabel(i: InboxItem) {
  if (i.status === "done") return i.mode === "auto" ? { label: "Hecha sola", tone: "ai" } : { label: "Aprobada", tone: "won" };
  return STATUS[i.status] ?? { label: i.status, tone: "" };
}

/** Fila del registro: lo que se hizo, con opción de deshacer. */
export function LogRow({ item }: { item: InboxItem }) {
  const st = statusLabel(item);
  return (
    <tr>
      <td className="nowrap meta">{dateTime(item.executed_at ?? item.decided_at ?? item.created_at)}</td>
      <td><span className={`badge ${st.tone}`}>{st.label}</span></td>
      <td>
        <strong>{item.title}</strong>
        <div className="meta">{proposer(item)} · {actionLabel(item.action_type)}{item.error && ` · ${item.error}`}</div>
      </td>
      <td>{item.deal_id ? <Link href={`/deals/${item.deal_id}`}>{item.deal_title}</Link> : "—"}</td>
      <td className="num">
        {isUndoable(item) && (
          <ActionForm action={undoActionAction.bind(null, item.id)} submitLabel="Deshacer" pendingLabel="…" secondary className="form inline" />
        )}
      </td>
    </tr>
  );
}
