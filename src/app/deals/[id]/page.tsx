import Link from "next/link";
import { notFound } from "next/navigation";
import { dealParticipants, getDeal, listLostReasons, stageHistory } from "@/lib/deals";
import { listStages } from "@/lib/pipelines";
import { listActivitiesFor } from "@/lib/activities";
import { listNotesFor } from "@/lib/notes";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { timeline } from "@/lib/events";
import { listUsers } from "@/lib/users";
import { sql } from "@/lib/db";
import { activityLabel, date, dateTime, money, STATUS_LABELS } from "@/lib/format";
import { isId } from "@/lib/validation";
import {
  addParticipantAction, loseDealAction, moveDealFormAction, removeParticipantAction, reopenDealAction, winDealAction,
} from "@/app/actions/deals";
import { ActionForm } from "@/components/ActionForm";
import { ActivityPanel } from "@/components/ActivityPanel";
import { NotePanel } from "@/components/NotePanel";
import { CustomFieldValues } from "@/components/CustomFieldValues";
import { EntityPicker } from "@/components/EntityPicker";
import { Timeline } from "@/components/Timeline";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = isId(id) ? await getDeal(id) : null;
  return { title: d?.title ?? "Deal" };
}

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const deal = await getDeal(id);
  if (!deal) notFound();

  const [stages, participants, history, activities, notes, defs, users, reasons, events, [stageInfo], [lead]] = await Promise.all([
    listStages(deal.pipeline_id), dealParticipants(id), stageHistory(id), listActivitiesFor({ dealId: id }),
    listNotesFor({ dealId: id }), listFieldDefinitions("deal", true), listUsers(), listLostReasons(),
    timeline(sql, [{ type: "deal", id }], 60),
    sql<{ required_activity_type: string | null; has_upcoming_session: boolean }[]>`
      SELECT required_activity_type, has_upcoming_session FROM open_deals_status WHERE id = ${id}`,
    deal.lead_id
      ? sql<{ id: string; source: string | null; source_detail: string | null; funnel_stage: string | null }[]>`
          SELECT id, source, source_detail, funnel_stage FROM leads WHERE id = ${deal.lead_id}`
      : Promise.resolve([]),
  ]);
  const currentPos = stages.find((s) => s.id === deal.stage_id)?.position ?? 0;
  const isOpen = deal.status === "open";
  const rotten = isOpen && deal.rotten_after_days !== null && deal.days_in_stage > deal.rotten_after_days;
  const back = `/deals/${id}`;

  return (
    <main className="page">
      <div className="crumbs"><Link href={`/pipelines/${deal.pipeline_id}`}>{deal.pipeline_name}</Link></div>
      <div className="page-head">
        <h1>{deal.title}</h1>
        <span className={`badge ${deal.status}`}>{STATUS_LABELS[deal.status]}</span>
        <strong>{money(deal.value, deal.currency)}</strong>
        <span className="spacer" />
        {isOpen ? (
          <>
            <ActionForm action={winDealAction.bind(null, id)} submitLabel="Ganado" pendingLabel="…" good className="form inline" />
            <details className="lose">
              <summary className="btn danger" style={{ listStyle: "none" }}>Perdido</summary>
              <div className="panel popover">
                <ActionForm action={loseDealAction.bind(null, id)} submitLabel="Marcar como perdido" danger>
                  <label className="field"><span className="label">Motivo *</span>
                    <select name="lost_reason_id" required defaultValue="">
                      <option value="" disabled>Elige un motivo</option>
                      {reasons.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}{r.followup_days ? ` (seguimiento a ${r.followup_days} días)` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field"><span className="label">Comentario</span><textarea name="lost_note" rows={3} /></label>
                </ActionForm>
              </div>
            </details>
          </>
        ) : (
          <ActionForm action={reopenDealAction.bind(null, id)} submitLabel="Reabrir" secondary className="form inline" />
        )}
        <Link href={`/deals/${id}/edit`} className="btn secondary">Editar</Link>
      </div>

      <nav className="stagebar" aria-label="Fases">
        {stages.map((s) => {
          const state = s.id === deal.stage_id ? "current" : s.position < currentPos ? "done" : "";
          return (
            <form key={s.id} action={moveDealFormAction.bind(null, id, s.id)}>
              <button className={state} disabled={!isOpen || s.id === deal.stage_id} title={s.name}
                      aria-current={s.id === deal.stage_id ? "step" : undefined}>{s.name}</button>
            </form>
          );
        })}
      </nav>

      {deal.status === "won" && <p className="callout good">Ganado el {date(deal.won_at)}.</p>}
      {deal.status === "lost" && (
        <p className="callout bad">Perdido el {date(deal.lost_at)} · {deal.lost_reason ?? "sin motivo"}{deal.lost_note && ` — ${deal.lost_note}`}</p>
      )}
      {rotten && (
        <p className="callout">
          Lleva {deal.days_in_stage} días en «{deal.stage_name}» (el límite es {deal.rotten_after_days}).
          {stageInfo && !stageInfo.has_upcoming_session &&
            ` No tiene ${stageInfo.required_activity_type ? activityLabel(stageInfo.required_activity_type).toLowerCase() : "ninguna sesión"} agendada.`}
        </p>
      )}

      <div className="split" style={{ marginTop: 16 }}>
        <div className="stack">
          <section className="panel">
            <h2>Datos</h2>
            <dl className="dl">
              <div className="dl-row"><dt>Empresa</dt><dd>{deal.organization_id ? <Link href={`/organizations/${deal.organization_id}`}>{deal.organization_name}</Link> : "—"}</dd></div>
              <div className="dl-row"><dt>Fase</dt><dd>{deal.stage_name} · {deal.days_in_stage} días</dd></div>
              <div className="dl-row"><dt>Cierre previsto</dt><dd>{date(deal.expected_close_date)}</dd></div>
              <div className="dl-row"><dt>Responsable</dt><dd>{deal.owner_name ?? "—"}</dd></div>
              <div className="dl-row"><dt>Origen</dt><dd>{deal.source ?? "—"}</dd></div>
              {lead && (
                <div className="dl-row"><dt>Lead de origen</dt><dd>
                  <Link href={`/leads/${lead.id}`}>{[lead.source, lead.source_detail].filter(Boolean).join(" · ") || "Ver lead"}</Link>
                </dd></div>
              )}
              <div className="dl-row"><dt>Creado</dt><dd>{dateTime(deal.created_at)}</dd></div>
              <CustomFieldValues defs={defs} values={deal.custom} users={users} />
            </dl>
          </section>

          <section className="panel stack">
            <h2>Contactos del deal</h2>
            {participants.length === 0 && <p className="muted">Sin contactos asociados.</p>}
            <ul className="items">
              {participants.map((p) => (
                <li key={p.person_id} className="item">
                  <div className="item-head">
                    <Link href={`/persons/${p.person_id}`}><strong>{p.full_name}</strong></Link>
                    {p.is_primary && <span className="badge open">Principal</span>}
                    {p.role && <span className="badge">{p.role}</span>}
                    <span className="spacer" />
                    <form action={removeParticipantAction.bind(null, id, p.person_id)}>
                      <button className="link" type="submit">Quitar</button>
                    </form>
                  </div>
                  <div className="meta">{[p.job_title, p.organization_name, p.email].filter(Boolean).join(" · ")}</div>
                </li>
              ))}
            </ul>
            <details>
              <summary>+ Añadir contacto</summary>
              <ActionForm action={addParticipantAction.bind(null, id)} submitLabel="Añadir" resetOnSuccess>
                <EntityPicker name="person_id" type="persons" label="Contacto" required />
                <label className="field"><span className="label">Rol</span><input name="role" placeholder="decisor, usuario, técnico…" /></label>
              </ActionForm>
            </details>
          </section>

          <section className="panel">
            <h2>Recorrido por fases</h2>
            <ol className="timeline">
              {history.map((h, i) => (
                <li key={i}>
                  <strong>{h.stage_name}</strong> <span className="muted">· {h.pipeline_name}</span>
                  <div className="meta">{dateTime(h.changed_at)} · {h.days} días</div>
                </li>
              ))}
            </ol>
          </section>

          <section className="panel"><h2>Historial</h2><Timeline events={events} /></section>
        </div>

        <div className="stack">
          <ActivityPanel activities={activities} back={back} users={users}
                         refs={{ deal_id: id, person_id: participants.find((p) => p.is_primary)?.person_id }} />
          <NotePanel notes={notes} refs={{ deal_id: id }} back={back} />
        </div>
      </div>
    </main>
  );
}
