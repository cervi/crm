import Link from "next/link";
import { dealParticipants, getDeal, listLostReasons, stageHistory } from "@/lib/deals";
import { listStages } from "@/lib/pipelines";
import { listActivitiesFor } from "@/lib/activities";
import { listNotesFor } from "@/lib/notes";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { eventLabel, timeline } from "@/lib/events";
import { listUsers } from "@/lib/users";
import { sql } from "@/lib/db";
import { listActions } from "@/lib/automations";
import { senderFor } from "@/lib/mailbox";
import { PROVIDERS } from "@/lib/integrations";
import { documentKind, listDocuments } from "@/lib/documents";
import { addDocumentAction, removeDocumentAction } from "@/app/actions/documents";
import { DrivePicker } from "./DrivePicker";
import { sendDealEmailAction } from "@/app/actions/mailbox";
import { ACTIVITY_TYPES, OUTCOMES, activityLabel, date, dateTime, money, outcomeLabel, STATUS_LABELS } from "@/lib/format";
import {
  addParticipantAction, loseDealAction, moveDealFormAction, removeParticipantAction, reopenDealAction, winDealAction,
} from "@/app/actions/deals";
import { completeActivityAction, createActivityAction, createNoteAction } from "@/app/actions/records";
import { ActionForm } from "../ActionForm";
import { Avatar } from "../Avatar";
import { CustomFieldValues } from "../CustomFieldValues";
import { EntityPicker } from "../EntityPicker";
import { ProposalCard } from "../ai/ProposalCard";
import { Icon } from "../Icon";
import { ComposerTabs, EmailBodyWithSlots, HistoryFeed, PanelControls, type HistoryItem } from "./DealClient";

type PanelNav = { closeHref: string; fullHref: string; prevHref: string | null; nextHref: string | null };

/**
 * Ficha de un deal. Se usa en la página completa y en el panel lateral del
 * tablero: arriba la fase, a la izquierda un resumen compacto y a la derecha
 * lo que se hace con el deal (notas, actividades, pendientes e historia).
 */
export async function DealDetail({ dealId, back, panel }: { dealId: string; back: string; panel?: PanelNav }) {
  const deal = await getDeal(dealId);
  if (!deal) return <div className="empty">Este deal ya no existe.</div>;

  const [stages, participants, history, activities, notes, defs, users, reasons, events, [stageInfo], [lead], proposals, sender, documents] = await Promise.all([
    listStages(deal.pipeline_id), dealParticipants(dealId), stageHistory(dealId), listActivitiesFor({ dealId }),
    listNotesFor({ dealId }), listFieldDefinitions("deal", true), listUsers(), listLostReasons(),
    timeline(sql, [{ type: "deal", id: dealId }], 100),
    sql<{ required_activity_type: string | null; has_upcoming_session: boolean }[]>`
      SELECT required_activity_type, has_upcoming_session FROM open_deals_status WHERE id = ${dealId}`,
    deal.lead_id
      ? sql<{ id: string; source: string | null; source_detail: string | null }[]>`
          SELECT id, source, source_detail FROM leads WHERE id = ${deal.lead_id}`
      : Promise.resolve([]),
    listActions({ view: "pending", dealId, limit: 10 }),
    senderFor(deal.owner_id),
    listDocuments(dealId),
  ]);
  const canSend = sender !== null;
  const provider = sender ? PROVIDERS[sender.provider] : null;
  const reachable = participants.filter((p) => p.email);

  const isOpen = deal.status === "open";
  const currentPos = stages.find((s) => s.id === deal.stage_id)?.position ?? 0;
  const daysByStage = new Map<string, number>();
  for (const h of history) daysByStage.set(h.stage_id, (daysByStage.get(h.stage_id) ?? 0) + (h.days ?? 0));
  const rotten = isOpen && deal.rotten_after_days !== null && deal.days_in_stage > deal.rotten_after_days;
  const pending = activities.filter((a) => !a.done);
  const primary = participants.find((p) => p.is_primary);
  const humans = users.filter((u) => u.kind === "human");

  // Historia: notas, actividades hechas y cambios del deal, en un solo hilo.
  const items: HistoryItem[] = [
    ...notes.map((n) => ({ id: `n${n.id}`, kind: "note" as const, at: new Date(n.created_at).toISOString(), title: "Nota",
                          body: n.content, meta: `${dateTime(n.created_at)}${n.author_name ? ` · ${n.author_name}` : ""}` })),
    ...activities.filter((a) => a.done).map((a) => ({
      id: `a${a.id}`, kind: "activity" as const, at: new Date(a.done_at ?? a.due_at ?? 0).toISOString(),
      title: `${activityLabel(a.type)}: ${a.subject}${a.outcome ? ` — ${outcomeLabel(a.outcome).toLowerCase()}` : ""}`,
      body: a.note, meta: `${dateTime(a.done_at)}${a.owner_name ? ` · ${a.owner_name}` : ""}`,
      tone: a.outcome === "no_show" ? "bad" as const : null,
    })),
    ...events.filter((e) => !e.event_type.startsWith("activity.") && e.event_type !== "note.created").map((e) => {
      const p = e.payload as Record<string, unknown>;
      const detail = e.event_type === "deal.stage_changed" && p.from_stage ? `${p.from_stage} → ${p.to_stage}`
        : e.event_type === "deal.lost" ? [p.reason, p.note].filter(Boolean).join(" · ")
        : e.event_type.startsWith("deal.document_") ? String(p.title ?? "") : null;
      return {
        id: `e${e.id}`, kind: "change" as const, at: new Date(e.occurred_at).toISOString(),
        title: eventLabel(e.event_type), body: detail,
        meta: `${dateTime(e.occurred_at)} · ${e.actor_name ?? (e.actor_type === "ai_agent" ? "IA" : e.actor_type === "integration" ? "Integración" : "Usuario")}`,
        tone: e.event_type === "deal.won" ? "good" as const : e.event_type === "deal.lost" ? "bad" as const : null,
      };
    }),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className={panel ? "deal-view in-panel" : "deal-view"}>
      <header className="deal-header">
        {panel && <PanelControls {...panel} />}
        <div className="deal-title-row">
          <div className="deal-title-block">
            {!panel && <div className="crumbs"><Link href={`/pipelines/${deal.pipeline_id}`}>{deal.pipeline_name}</Link> → {deal.stage_name}</div>}
            <h1>{deal.title}</h1>
            <div className="deal-sub">
              <span className={`badge ${deal.status}`}>{STATUS_LABELS[deal.status]}</span>
              <strong>{money(deal.value, deal.currency)}</strong>
              {deal.organization_id && <Link href={`/organizations/${deal.organization_id}`}>{deal.organization_name}</Link>}
              {deal.owner_name && <span className="owner"><Avatar name={deal.owner_name} size="sm" />{deal.owner_name}</span>}
            </div>
          </div>
          <div className="deal-actions">
            {isOpen ? (
              <>
                <ActionForm action={winDealAction.bind(null, dealId)} submitLabel="Ganado" pendingLabel="…" good className="form inline" />
                <details className="lose">
                  <summary className="btn danger">Perdido</summary>
                  <div className="panel popover">
                    <ActionForm action={loseDealAction.bind(null, dealId)} submitLabel="Marcar como perdido" danger>
                      <label className="field"><span className="label">Motivo *</span>
                        <select name="lost_reason_id" required defaultValue="">
                          <option value="" disabled>Elige un motivo</option>
                          {reasons.map((r) => (
                            <option key={r.id} value={r.id}>{r.label}{r.followup_days ? ` (seguimiento a ${r.followup_days} días)` : ""}</option>
                          ))}
                        </select>
                      </label>
                      <label className="field"><span className="label">Comentario</span><textarea name="lost_note" rows={3} /></label>
                    </ActionForm>
                  </div>
                </details>
              </>
            ) : (
              <ActionForm action={reopenDealAction.bind(null, dealId)} submitLabel="Reabrir" secondary className="form inline" />
            )}
            <Link href={`/deals/${dealId}/edit`} className="btn secondary">Editar</Link>
          </div>
        </div>

        <nav className="stagebar" aria-label="Fases">
          {stages.map((s) => {
            const state = s.id === deal.stage_id ? "current" : s.position < currentPos ? "done" : "";
            const days = daysByStage.get(s.id);
            return (
              <form key={s.id} action={moveDealFormAction.bind(null, dealId, s.id)}>
                <button className={state} disabled={!isOpen || s.id === deal.stage_id} title={s.name}
                        aria-current={s.id === deal.stage_id ? "step" : undefined}>
                  {days !== undefined && <span className="stage-days">{days} d</span>}{s.name}
                </button>
              </form>
            );
          })}
        </nav>
        {deal.status === "won" && <p className="callout good">Ganado el {date(deal.won_at)}.</p>}
        {deal.status === "lost" && (
          <p className="callout bad">Perdido el {date(deal.lost_at)}: {deal.lost_reason ?? "sin motivo"}{deal.lost_note && `. ${deal.lost_note}`}</p>
        )}
        {rotten && (
          <p className="callout">
            Lleva {deal.days_in_stage} días en «{deal.stage_name}» (el límite es {deal.rotten_after_days}).
            {stageInfo && !stageInfo.has_upcoming_session &&
              ` No tiene ${stageInfo.required_activity_type ? activityLabel(stageInfo.required_activity_type).toLowerCase() : "ninguna sesión"} agendada.`}
          </p>
        )}
      </header>

      <div className="deal-layout">
        <aside className="deal-side">
          <section className="side-section">
            <h3>Resumen</h3>
            <dl className="dl compact">
              <div className="dl-row"><dt>Importe</dt><dd>{money(deal.value, deal.currency)}</dd></div>
              <div className="dl-row"><dt>Empresa</dt><dd>{deal.organization_id ? <Link href={`/organizations/${deal.organization_id}`}>{deal.organization_name}</Link> : "—"}</dd></div>
              <div className="dl-row"><dt>Contacto</dt><dd>{primary ? <Link href={`/persons/${primary.person_id}`}>{primary.full_name}</Link> : "—"}</dd></div>
              <div className="dl-row"><dt>Cierre previsto</dt><dd>{date(deal.expected_close_date)}</dd></div>
              <div className="dl-row"><dt>Origen</dt><dd>{deal.source ?? "—"}</dd></div>
              {lead && <div className="dl-row"><dt>Lead</dt><dd><Link href={`/leads/${lead.id}`}>{lead.source_detail ?? lead.source ?? "Ver lead"}</Link></dd></div>}
              <div className="dl-row"><dt>Creado</dt><dd>{date(deal.created_at)}</dd></div>
            </dl>
          </section>

          {defs.length > 0 && (
            <details className="side-section">
              <summary><h3>Campos</h3><span className="meta">{defs.filter((d) => deal.custom[d.key] !== undefined).length}/{defs.length}</span></summary>
              <dl className="dl compact"><CustomFieldValues defs={defs} values={deal.custom} users={users} /></dl>
              <Link href={`/deals/${dealId}/edit`} className="meta">Rellenar campos</Link>
            </details>
          )}

          <section className="side-section">
            <h3>Contactos <span className="muted">{participants.length}</span></h3>
            <ul className="mini-list">
              {participants.map((p) => (
                <li key={p.person_id}>
                  <Avatar name={p.full_name} size="sm" />
                  <div>
                    <Link href={`/persons/${p.person_id}`}>{p.full_name}</Link>
                    <div className="meta">{[p.role, p.job_title, p.email].filter(Boolean).join(" · ")}</div>
                  </div>
                  <form action={removeParticipantAction.bind(null, dealId, p.person_id)}>
                    <button className="link meta" type="submit" aria-label={`Quitar a ${p.full_name}`}>Quitar</button>
                  </form>
                </li>
              ))}
            </ul>
            <details>
              <summary className="meta">+ Añadir contacto</summary>
              <ActionForm action={addParticipantAction.bind(null, dealId)} submitLabel="Añadir" resetOnSuccess>
                <EntityPicker name="person_id" type="persons" label="Contacto" required />
                <label className="field"><span className="label">Rol</span><input name="role" placeholder="decisor, usuario…" /></label>
              </ActionForm>
            </details>
          </section>

          <section className="side-section" aria-label="Documentos">
            <h3>Documentos <span className="muted">{documents.length}</span></h3>
            {documents.length > 0 && (
              <ul className="doc-list">
                {documents.map((d) => (
                  <li key={d.id}>
                    <div>
                      <a className="doc-title" href={d.url} target="_blank" rel="noopener noreferrer" title={d.title}>{d.title}</a>
                      <div className="meta">{documentKind(d)}{d.source !== "link" && ` · ${PROVIDERS[d.source].drive.split(" /")[0]}`}</div>
                    </div>
                    <ActionForm action={removeDocumentAction.bind(null, d.id, back)} submitLabel="Quitar" pendingLabel="…" secondary className="form inline doc-remove" />
                  </li>
                ))}
              </ul>
            )}
            <details>
              <summary className="meta">+ Enlazar documento</summary>
              {provider && (
                <DrivePicker dealId={dealId} driveName={provider.drive} source={sender!.provider} action={addDocumentAction.bind(null, dealId, back)} />
              )}
              <ActionForm action={addDocumentAction.bind(null, dealId, back)} submitLabel="Enlazar" resetOnSuccess secondary>
                <label className="field"><span className="label">Enlace</span><input name="url" type="url" required placeholder="https://…" /></label>
                <label className="field"><span className="label">Título</span><input name="title" placeholder="Propuesta, presentación…" /></label>
              </ActionForm>
            </details>
          </section>
        </aside>

        <div className="deal-main">
          <ComposerTabs
            note={
              <ActionForm action={createNoteAction.bind(null, back)} submitLabel="Guardar nota" resetOnSuccess>
                <input type="hidden" name="deal_id" value={dealId} />
                <textarea name="content" rows={3} required placeholder="Escribe una nota…" aria-label="Nota" />
              </ActionForm>
            }
            activity={
              <ActionForm action={createActivityAction.bind(null, back)} submitLabel="Programar" resetOnSuccess>
                <input type="hidden" name="deal_id" value={dealId} />
                {primary && <input type="hidden" name="person_id" value={primary.person_id} />}
                <div className="grid-2">
                  <label className="field"><span className="label">Tipo</span>
                    <select name="type" defaultValue={stageInfo?.required_activity_type ?? "call"}>
                      {ACTIVITY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </label>
                  <label className="field"><span className="label">Asunto</span><input name="subject" required /></label>
                  <label className="field"><span className="label">Fecha y hora</span><input type="datetime-local" name="due_at" /></label>
                  <label className="field"><span className="label">Duración (min)</span><input type="number" name="duration_minutes" min={5} max={480} placeholder="30" /></label>
                  <label className="field"><span className="label">Responsable</span>
                    <select name="owner_id" defaultValue={deal.owner_id ?? ""}>
                      <option value="">—</option>
                      {humans.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </label>
                </div>
                {canSend && (
                  <label className="checkbox">
                    <input type="checkbox" name="add_to_calendar" />
                    Invitar {primary ? `a ${primary.full_name} ` : ""}desde mi {provider?.calendar} (con {provider?.meeting} si es videollamada o demo)
                  </label>
                )}
              </ActionForm>
            }
            email={
              canSend ? (
                reachable.length === 0 ? <p className="muted">Ningún contacto del deal tiene email.</p> : (
                  <ActionForm action={sendDealEmailAction.bind(null, dealId, back)} submitLabel={`Enviar desde ${provider?.mail ?? "mi correo"}`} pendingLabel="Enviando…" resetOnSuccess>
                    <div className="grid-2">
                      <label className="field"><span className="label">Para</span>
                        <select name="person_id" defaultValue={primary?.email ? primary.person_id : reachable[0].person_id}>
                          {reachable.map((p) => <option key={p.person_id} value={p.person_id}>{p.full_name} · {p.email}</option>)}
                        </select>
                      </label>
                      <label className="field"><span className="label">Asunto</span><input name="subject" required /></label>
                    </div>
                    <EmailBodyWithSlots dealId={dealId} />
                  </ActionForm>
                )
              ) : (
                <p className="muted">Conecta tu cuenta de Microsoft 365 o Google en <Link href="/settings/mailbox">Ajustes → Correo, calendario y documentos</Link> para escribir desde aquí: saldrá desde tu correo y quedará en tus enviados.</p>
              )
            }
          />

          {proposals.length > 0 && (
            <section className="deal-proposals" aria-label="Propuestas de la IA">
              <h2 className="section-title"><Icon name="spark" />Propuestas de la IA <span className="muted">{proposals.length}</span></h2>
              <div className="proposals">{proposals.map((p) => <ProposalCard key={p.id} item={p} showDeal={false} canSend={canSend} />)}</div>
            </section>
          )}

          <section>
            <h2 className="section-title">Enfoque <span className="muted">{pending.length}</span></h2>
            {pending.length === 0 && <p className="muted">No hay nada pendiente. Programa la siguiente actividad para que el deal no se quede parado.</p>}
            <ul className="items">
              {pending.map((a) => (
                <li key={a.id} className={a.is_overdue ? "item overdue" : "item"}>
                  <div className="item-head">
                    <span className="badge">{activityLabel(a.type)}</span>
                    <strong>{a.subject}</strong>
                    {a.is_overdue && <span className="badge lost">Vencida</span>}
                    <span className="spacer" />
                    <span className="meta">{a.due_at ? dateTime(a.due_at) : "Sin fecha"}{a.owner_name && ` · ${a.owner_name}`}</span>
                  </div>
                  {a.note && <p className="note-body">{a.note}</p>}
                  <details>
                    <summary className="meta">Marcar como hecha</summary>
                    <ActionForm action={completeActivityAction.bind(null, a.id, back)} submitLabel="Guardar" className="form inline">
                      <label className="field"><span className="label">Resultado</span>
                        <select name="outcome" defaultValue="">
                          <option value="">—</option>
                          {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                      <label className="field" style={{ flex: 1 }}><span className="label">Comentario</span><input name="note" /></label>
                    </ActionForm>
                  </details>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="section-title">Historia</h2>
            <HistoryFeed items={items} />
          </section>
        </div>
      </div>
    </div>
  );
}

