import Link from "next/link";
import { ExportLink } from "../ExportLink";
import { dealParticipants, getDeal, listLostReasons, stageHistory } from "@/lib/deals";
import { listStages } from "@/lib/pipelines";
import { listActivitiesFor } from "@/lib/activities";
import { listNotesFor } from "@/lib/notes";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { timeline } from "@/lib/events";
import { listUsers } from "@/lib/users";
import { sql } from "@/lib/db";
import { listActions } from "@/lib/automations";
import { connectionOf, senderFor } from "@/lib/mailbox";
import { PROVIDERS } from "@/lib/integrations";
import { documentKind, listDocuments } from "@/lib/documents";
import { getDealBrief } from "@/lib/briefs";
import { planNextStep } from "@/lib/next-step";
import { aiReady, getAiSettings } from "@/lib/ai";
import { regenerateBriefAction } from "@/app/actions/ai";
import { addDocumentAction, removeDocumentAction } from "@/app/actions/documents";
import { DrivePicker } from "./DrivePicker";
import { sendDealEmailAction } from "@/app/actions/mailbox";
import { OUTCOMES, activityLabel, date, dateTime, isSessionType, money, STATUS_LABELS } from "@/lib/format";
import { activeActivityTypes } from "@/lib/activity-types";
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
import { ComposerTabs, EmailComposerFields, PanelControls } from "./DealClient";
import { HistoryFeed } from "@/components/record/HistoryFeed";
import { CallForm, FilesPanel, FollowersBlock, TagsBlock } from "@/components/record/Blocks";
import { buildHistory } from "@/lib/history";
import { listFiles } from "@/lib/files";
import { listFollowers } from "@/lib/followers";
import { listTags, tagsOf } from "@/lib/contact-workspace";
import { listInstructions } from "@/lib/stage-agents";
import { listEmails, listTemplates, opensFor, templateVars } from "@/lib/emails";
import { getHealth, recomputeHealth } from "@/lib/health";
import { DEAL_TYPE_LABEL } from "@/lib/deal-types";
import { startOnboardingAction } from "@/app/actions/accounts";
import { getInsights } from "@/lib/deal-agent";
import { closePlanUrl, getClosePlan, SIDE_LABEL } from "@/lib/close-plan";
import {
  addPlanStepAction, decideDiscountAction, deletePlanStepAction, generatePlanAction, refreshPrepAction, saveInsightsAction,
  sharePlanAction, togglePlanStepAction,
} from "@/app/actions/deal-agent";
import { HealthBadge } from "../HealthBadge";
import { DEVICE_LABEL } from "@/lib/reader";
import { mergeTemplate } from "@/lib/merge";
import { htmlToText } from "@/lib/email-html";
import { signatureFor, signaturePreview } from "@/lib/signatures";
import { publicBase } from "@/lib/email-track";
import { requireUser } from "@/lib/auth";
import { cancelScheduledEmailAction } from "@/app/actions/mailbox";
import { trashAction } from "@/app/actions/trash";
import { listEnrollments, listSequences } from "@/lib/sequences";
import { enrollAction, stopEnrollmentAction } from "@/app/actions/sequences";
import { BILLING_LABELS, dealLines, listProducts } from "@/lib/products";
import { listProposals, proposalUrl, proposalViews } from "@/lib/proposals";
import { addLineAction, createProposalAction, markSentAction, removeLineAction, updateProposalAction } from "@/app/actions/products";

type PanelNav = { closeHref: string; fullHref: string; prevHref: string | null; nextHref: string | null };

/**
 * Ficha de un deal. Se usa en la página completa y en el panel lateral del
 * tablero: arriba la fase, a la izquierda un resumen compacto y a la derecha
 * lo que se hace con el deal (notas, actividades, pendientes e historia).
 */
export async function DealDetail({ dealId, back, panel }: { dealId: string; back: string; panel?: PanelNav }) {
  const deal = await getDeal(dealId);
  if (!deal) return <div className="empty">Este deal ya no existe.</div>;

  const [stages, participants, history, activities, notes, defs, users, reasons, events, [stageInfo], [lead], proposals, sender, documents, brief, ai, types] = await Promise.all([
    listStages(deal.pipeline_id), dealParticipants(dealId), stageHistory(dealId), listActivitiesFor({ dealId }),
    listNotesFor({ dealId }), listFieldDefinitions("deal", true), listUsers(), listLostReasons(),
    timeline(sql, [{ type: "deal", id: dealId }], 100),
    sql<{ required_activity_type: string | null; has_upcoming_session: boolean }[]>`
      SELECT required_activity_type, has_upcoming_session FROM open_deals_status WHERE id = ${dealId}`,
    deal.lead_id
      ? sql<{ id: string; source: string | null; source_detail: string | null }[]>`
          SELECT id, source, source_detail FROM leads WHERE id = ${deal.lead_id}`
      : Promise.resolve([]),
    listActions({ view: "pending", dealId, limit: 30 }),
    senderFor(deal.owner_id),
    listDocuments(dealId),
    deal.status === "open" ? getDealBrief(dealId) : Promise.resolve(null),
    getAiSettings(),
    activeActivityTypes(),
  ]);
  const me = await requireUser();
  const [emails, templates, vars, [appSettings], enrollments, allSequences] = await Promise.all([
    listEmails({ dealId }), listTemplates(me.id), templateVars(dealId),
    sql<{ email_tracking: boolean }[]>`SELECT email_tracking FROM app_settings LIMIT 1`,
    listEnrollments({ dealId }), listSequences(),
  ]);
  const [lines, catalog, proposals_] = await Promise.all([dealLines(dealId), listProducts(), listProposals(dealId)]);
  const [files, followers, tags, allTags, stageInstructions] = await Promise.all([listFiles({ deal_id: dealId }), listFollowers("deal", dealId), tagsOf("deal", dealId), listTags(),
    listInstructions({ stageId: deal.stage_id })]);
  const [insights, closePlan] = await Promise.all([getInsights(dealId), getClosePlan(dealId)]);
  const views = new Map(await Promise.all(proposals_.filter((p) => p.view_count > 0).map(async (p) => [p.id, await proposalViews(p.id)] as const)));
  const opens = await opensFor(emails.filter((e) => e.direction === "out" && e.open_count > 0).map((e) => e.id));
  // La salud se recalcula en cada revisión; si está vieja (o no existe), aquí mismo.
  let health = deal.status === "open" ? await getHealth(dealId) : null;
  if (deal.status === "open" && (!health || Date.now() - new Date(health.computed_at).getTime() > 15 * 60000)) {
    await recomputeHealth(dealId).catch((err) => console.error("[salud]", err));
    health = await getHealth(dealId);
  }
  const linesTotal = lines.reduce((n, l) => n + l.subtotal, 0);
  const sequences = allSequences.filter((q) => q.is_active && q.steps > 0);
  const composerTemplates = templates.map((t) => ({
    id: t.id, name: t.name, subject: mergeTemplate(t.subject, { ...vars, huecos: "{huecos}" }).text,
    body: mergeTemplate(t.format === "html" ? htmlToText(t.body) : t.body, { ...vars, huecos: "{huecos}" }).text,
  }));
  const canSend = sender !== null;
  // Firma de quien enviará desde aquí: tu buzón si lo tienes conectado; si no, el del responsable.
  const myConn = await connectionOf(me.id);
  const sendingConn = myConn?.status === "active" ? myConn : sender;
  const signatureHtml = sendingConn ? signaturePreview(await signatureFor(sendingConn), sendingConn) : "";
  const provider = sender ? PROVIDERS[sender.provider] : null;
  const reachable = participants.filter((p) => p.email);
  const firstContact = participants.find((p) => p.is_primary) ?? participants[0];
  const plan = brief ? await planNextStep(dealId, brief.signals, brief.step, { name: firstContact?.full_name ?? null, email: firstContact?.email ?? null }) : null;

  const isOpen = deal.status === "open";
  const currentPos = stages.find((s) => s.id === deal.stage_id)?.position ?? 0;
  const daysByStage = new Map<string, number>();
  for (const h of history) daysByStage.set(h.stage_id, (daysByStage.get(h.stage_id) ?? 0) + (h.days ?? 0));
  const rotten = isOpen && deal.rotten_after_days !== null && deal.days_in_stage > deal.rotten_after_days;
  const pending = activities.filter((a) => !a.done);
  const primary = participants.find((p) => p.is_primary);
  const humans = users.filter((u) => u.kind === "human");

  // Historia: notas, actividades hechas y cambios del deal, en un solo hilo.
  // Historia: notas, actividades, llamadas, archivos y cambios del deal, en un solo hilo (los correos van en su apartado).
  const items = buildHistory({ notes, activities, files, events });

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
              {deal.deal_type !== "new" && <span className="badge ai" title={deal.origin === "cs" ? "Lo lleva Customer Success" : undefined}>{DEAL_TYPE_LABEL[deal.deal_type]}</span>}
              <strong>{money(deal.value, deal.currency)}</strong>
              {health && <a href="#senales" className="health-link"><HealthBadge score={health.score} signals={health.signals} /></a>}
              {deal.organization_id && <Link href={`/organizations/${deal.organization_id}`}>{deal.organization_name}</Link>}
              {deal.owner_name && <span className="owner"><Avatar name={deal.owner_name} size="sm" />{deal.owner_name}</span>}
              {rotten && (
                <span className="badge warn" title={`Lleva ${deal.days_in_stage} días en «${deal.stage_name}» (el límite es ${deal.rotten_after_days}).${stageInfo && !stageInfo.has_upcoming_session ? ` No tiene ${stageInfo.required_activity_type ? activityLabel(stageInfo.required_activity_type).toLowerCase() : "ninguna sesión"} agendada.` : ""}`}>
                  Parado {deal.days_in_stage} d{stageInfo && !stageInfo.has_upcoming_session ? " · sin sesión" : ""}
                </span>
              )}
            </div>
            <TagsBlock entity="deal" id={dealId} tags={tags} all={allTags} back={back} />
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
            <ActionForm action={trashAction.bind(null, "deal", dealId)} submitLabel="Borrar" pendingLabel="…" secondary className="form inline deal-trash" />
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
        {deal.status === "won" && (
          <p className="callout good">
            Ganado el {date(deal.won_at)}.
            {deal.contract_id && deal.organization_id && <> <Link href={`/organizations/${deal.organization_id}`}>Ver el cliente y su contrato</Link>.</>}
          </p>
        )}
        {deal.status === "won" && deal.pipeline_kind === "sales" && deal.deal_type === "new" && !deal.contract_id && deal.organization_id && (
          <div className="callout">
            ¿Ya es cliente? Crea su contrato y su onboarding (con el plan de hitos y la ficha del kick-off).
            <ActionForm action={startOnboardingAction.bind(null, dealId, back)} submitLabel="Poner en marcha al cliente" pendingLabel="Creando…" secondary className="form inline" />
          </div>
        )}
        {deal.status === "lost" && (
          <p className="callout bad">Perdido el {date(deal.lost_at)}: {deal.lost_reason ?? "sin motivo"}{deal.lost_note && `. ${deal.lost_note}`}</p>
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

          <details className="side-section insights" aria-label="Lo que sabemos" open={!!insights}>
            <summary><h3>Lo que sabemos</h3>{!insights && <span className="meta">vacío</span>}</summary>
            {!insights ? <p className="meta">Se rellena solo con cada reunión (con notas o transcripción) o a mano.</p> : (
              <dl className="dl compact">
                {insights.needs.length > 0 && <div className="dl-row"><dt>Necesita</dt><dd>{insights.needs.join(" · ")}</dd></div>}
                {insights.decision_makers.length > 0 && <div className="dl-row"><dt>Decisores</dt><dd>{insights.decision_makers.map((d) => [d.nombre, d.cargo].filter(Boolean).join(", ")).join(" · ")}</dd></div>}
                {insights.budget && <div className="dl-row"><dt>Presupuesto</dt><dd>{insights.budget}</dd></div>}
                {insights.timeline && <div className="dl-row"><dt>Plazos</dt><dd>{insights.timeline}</dd></div>}
                {insights.objections.length > 0 && <div className="dl-row"><dt>Objeciones</dt><dd>{insights.objections.join(" · ")}</dd></div>}
                {insights.competitors.length > 0 && <div className="dl-row"><dt>Compite con</dt><dd>{insights.competitors.join(" · ")}</dd></div>}
              </dl>
            )}
            <details>
              <summary className="meta">{insights ? "Editar" : "+ Rellenar"}</summary>
              <ActionForm action={saveInsightsAction.bind(null, dealId, back)} submitLabel="Guardar" secondary>
                <label className="field"><span className="label">Necesidades (una por línea)</span><textarea name="needs" rows={3} defaultValue={insights?.needs.join("\n") ?? ""} /></label>
                <label className="field"><span className="label">Decisores (Nombre — cargo — rol)</span><textarea name="decision_makers" rows={2} defaultValue={insights?.decision_makers.map((d) => [d.nombre, d.cargo, d.rol].filter(Boolean).join(" — ")).join("\n") ?? ""} /></label>
                <label className="field"><span className="label">Presupuesto</span><input name="budget" defaultValue={insights?.budget ?? ""} /></label>
                <label className="field"><span className="label">Plazos</span><input name="timeline" defaultValue={insights?.timeline ?? ""} /></label>
                <label className="field"><span className="label">Objeciones (una por línea)</span><textarea name="objections" rows={2} defaultValue={insights?.objections.join("\n") ?? ""} /></label>
                <label className="field"><span className="label">Competidores (uno por línea)</span><textarea name="competitors" rows={2} defaultValue={insights?.competitors.join("\n") ?? ""} /></label>
              </ActionForm>
            </details>
          </details>

          {defs.length > 0 && (
            <details className="side-section">
              <summary><h3>Campos</h3><span className="meta">{defs.filter((d) => deal.custom[d.key] !== undefined).length}/{defs.length}</span></summary>
              <dl className="dl compact"><CustomFieldValues defs={defs} values={deal.custom} users={users} /></dl>
              <Link href={`/deals/${dealId}/edit`} className="meta">Rellenar campos</Link>
            </details>
          )}

          <details className="side-section" aria-label="Documentos" open={documents.length > 0}>
            <summary><h3>Documentos</h3><span className="meta">{documents.length}</span></summary>
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
          </details>

          <details className="side-section" aria-label="La IA en esta fase" open={stageInstructions.length > 0}>
            <summary><h3>La IA en esta fase</h3><span className="meta">{stageInstructions.length || "sin instrucciones"}</span></summary>
            <p className="meta" style={{ margin: "0 0 6px" }}><Link href={`/pipelines/${deal.pipeline_id}/agentes?fase=${deal.stage_id}#fase-${deal.stage_id}`}>{stageInstructions.length ? "Cambiar instrucciones" : "+ Decirle a la IA qué hacer aquí"}</Link></p>
            {stageInstructions.length === 0 ? <p className="meta" style={{ margin: 0 }}>Sin instrucciones: dile a la IA qué hacer con los deals de esta fase (escribir para agendar, moverlos si…).</p> : (
              <ul className="instr-mini">
                {stageInstructions.map((i) => (
                  <li key={i.id}><span className={`badge ${i.autonomy === "auto" ? "ai" : i.autonomy === "off" ? "" : "warn"}`}>{i.autonomy === "auto" ? "Sola" : i.autonomy === "off" ? "En pausa" : "Pregunta"}</span> {i.text}</li>
                ))}
              </ul>
            )}
          </details>

          <FollowersBlock type="deal" id={dealId} followers={followers} me={me.id} users={users.filter((u) => u.kind === "human")} back={back} />

          <details className="side-section deal-sequences" aria-label="Secuencias" open={enrollments.length > 0}>
            <summary><h3>Secuencias</h3><span className="meta">{enrollments.filter((e) => e.status === "active").length} activas</span></summary>
            {enrollments.length > 0 && (
              <ul>
                {enrollments.slice(0, 5).map((e) => (
                  <li key={e.id}>
                    <Link href={`/sequences/${e.sequence_id}`}>{e.sequence_name}</Link>
                    <span className="meta">
                      {e.person_name} · {e.status === "active"
                        ? `paso ${Math.min(e.next_step + 1, e.steps)} de ${e.steps}${e.next_run_at ? `, ${dateTime(e.next_run_at)}` : ""}`
                        : e.stopped_reason ?? (e.status === "completed" ? "terminada" : "con error")}
                    </span>
                    {e.status === "active" && (
                      <form action={stopEnrollmentAction.bind(null, e.id, back)}><button type="submit" className="link-btn">Parar</button></form>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {isOpen && sequences.length > 0 && participants.length > 0 && (
              <details>
                <summary className="meta">+ Añadir a una secuencia</summary>
                <ActionForm action={enrollAction.bind(null, dealId, back)} submitLabel="Añadir" resetOnSuccess secondary>
                  <label className="field"><span className="label">Secuencia</span>
                    <select name="sequence_id" required defaultValue="">
                      <option value="" disabled>Elige…</option>
                      {sequences.map((q) => <option key={q.id} value={q.id}>{q.name} ({q.steps} pasos)</option>)}
                    </select></label>
                  {participants.length > 1 && (
                    <label className="field"><span className="label">Contacto</span>
                      <select name="person_id" defaultValue={primary?.person_id ?? participants[0].person_id}>
                        {participants.map((p) => <option key={p.person_id} value={p.person_id}>{p.full_name}</option>)}
                      </select></label>
                  )}
                </ActionForm>
              </details>
            )}
          </details>
        </aside>

        <div className="deal-main">
          {brief && (
            <section className="brief" aria-label="Resumen del deal">
              <div className="brief-head">
                <h2><Icon name="spark" />Resumen</h2>
                <span className="meta">
                  {brief.source === "ai" ? `Redactado por la IA · ${dateTime(brief.generated_at)}${brief.stale ? " · hay novedades desde entonces" : ""}` : "Según la actividad del deal"}
                </span>
                <span className="spacer" />
                {aiReady(ai) && (
                  <ActionForm action={regenerateBriefAction.bind(null, dealId, back)} submitLabel={brief.source === "ai" ? "Actualizar" : "Redactar con IA"} pendingLabel="Redactando…" secondary className="form inline" />
                )}
              </div>
              <p>{brief.resumen}</p>
              <div className={`brief-next p${brief.prioridad}`} tabIndex={0} aria-describedby={plan ? "step-plan" : undefined}>
                <span className="label">Siguiente paso</span>
                <div className="brief-next-text"><strong>{brief.siguiente_paso}</strong></div>
                {plan && (
                  <>
                    <span className={`step-when who-${plan.who}`} title="Pasa el ratón para ver los detalles">
                      {plan.whenShort}<Icon name="info" />
                    </span>
                    <div className="step-plan" role="tooltip" id="step-plan">
                      {brief.source === "ai" && brief.step.text !== brief.siguiente_paso && (
                        <p className="meta" style={{ margin: "0 0 8px" }}>Según la actividad del deal: <strong>{brief.step.text}</strong></p>
                      )}
                      <dl>
                        <div><dt>Cuándo</dt><dd>{plan.when}</dd></div>
                        <div><dt>Quién</dt><dd><span className={`who-dot who-${plan.who}`} />{plan.whoText}</dd></div>
                        <div><dt>Cómo</dt><dd>{plan.how.length === 1 ? plan.how[0] : <ul>{plan.how.map((h) => <li key={h}>{h}</li>)}</ul>}</dd></div>
                        <div><dt>Por qué</dt><dd>{plan.why}</dd></div>
                      </dl>
                    </div>
                  </>
                )}
              </div>
              {brief.riesgos.length > 0 && (
                <details className="brief-why">
                  <summary>Por qué ({brief.riesgos.length})</summary>
                  <ul className="brief-risks">{brief.riesgos.map((r) => <li key={r}>{r}</li>)}</ul>
                </details>
              )}
            </section>
          )}

          {health && health.signals.length > 0 && (
            <details className="signals" id="senales" aria-label="Señales del deal">
              <summary className="section-title">
                <span>Salud del deal</span> <HealthBadge score={health.score} signals={health.signals} />
                <span className="meta" style={{ fontWeight: 400 }}>
                  {health.signals.filter((x) => x.tone === "risk").length} riesgos · {health.signals.filter((x) => x.tone === "good").length} a favor
                </span>
                <span className="signals-toggle meta">Ver detalle</span>
              </summary>
              <p className="meta" style={{ margin: "4px 0 12px" }}>Parte de 50: los riesgos restan y las señales positivas suman.</p>
              <div className="signal-cols">
                {(["risk", "good"] as const).map((tone) => {
                  const list = health!.signals.filter((x) => x.tone === tone);
                  return (
                    <div key={tone}>
                      <h3>{tone === "risk" ? "Riesgos" : "A favor"} <span className="muted">{list.length}</span></h3>
                      {list.length === 0 ? <p className="meta">{tone === "risk" ? "Ninguno a la vista." : "Todavía ninguna."}</p> : (
                        <ul className="signal-list">
                          {list.map((x) => (
                            <li key={x.key} className={`signal ${tone}`}>
                              <span className="signal-points">{x.points > 0 ? "+" : ""}{x.points}</span>
                              <span>{x.label}{x.detail && <span className="meta"> — {x.detail}</span>}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            </details>
          )}

          <ComposerTabs
            call={<CallForm refs={{ deal_id: dealId, ...(primary ? { person_id: primary.person_id } : {}) }} back={back} />}
            files={<FilesPanel refs={{ deal_id: dealId }} files={files} back={back} />}
            filesLabel={`Archivos${files.length ? ` (${files.length})` : ""}`}
            note={
              <ActionForm action={createNoteAction.bind(null, back)} submitLabel="Guardar nota" resetOnSuccess>
                <input type="hidden" name="deal_id" value={dealId} />
                <textarea name="content" rows={3} required placeholder="Escribe una nota… (con @Nombre avisas a alguien del equipo)" aria-label="Nota" />
              </ActionForm>
            }
            activity={
              <ActionForm action={createActivityAction.bind(null, back)} submitLabel="Programar" resetOnSuccess>
                <input type="hidden" name="deal_id" value={dealId} />
                {primary && <input type="hidden" name="person_id" value={primary.person_id} />}
                <div className="grid-2">
                  <label className="field"><span className="label">Tipo</span>
                    <select name="type" defaultValue={stageInfo?.required_activity_type ?? "call"}>
                      {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
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
                    </div>
                    <EmailComposerFields dealId={dealId} templates={composerTemplates}
                                         trackDefault={appSettings?.email_tracking ?? true} trackAvailable={publicBase() !== null}
                                         signatureHtml={signatureHtml} />
                  </ActionForm>
                )
              ) : (
                <p className="muted">Conecta tu cuenta de Microsoft 365 o Google en <Link href="/settings/mailbox">Ajustes → Correo, calendario y documentos</Link> para escribir desde aquí: saldrá desde tu correo y quedará en tus enviados.</p>
              )
            }
          />

          {(lines.length > 0 || catalog.length > 0) && (
            <section className="deal-products" id="productos" aria-label="Productos y propuestas">
              <h2 className="section-title">Productos <span className="muted">{lines.length}</span></h2>
              {lines.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Producto</th><th className="num">Cant.</th><th className="num">Precio</th><th className="num">Dto.</th><th className="num">Importe</th><th /></tr></thead>
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.id}>
                          <td>{l.name}<div className="meta">{BILLING_LABELS[l.billing]}</div></td>
                          <td className="num">{Number(l.quantity).toLocaleString("es-ES")}</td>
                          <td className="num">{money(l.unit_price, deal.currency)}</td>
                          <td className="num">{Number(l.discount_pct) ? `${Number(l.discount_pct)} %` : "—"}
                            {l.discount_status === "pending" && (
                              <div className="discount-pending">
                                <span className="badge warn" title={`Pedido por ${l.requested_by_name ?? "—"}; el límite sin aprobación es del ${Number(l.discount_limit)} %`}>Pendiente de aprobación</span>
                                {me.role === "admin" && (
                                  <span className="discount-actions">
                                    <ActionForm action={decideDiscountAction.bind(null, dealId, l.id, true, back)} submitLabel="Aprobar" pendingLabel="…" good className="form inline" />
                                    <ActionForm action={decideDiscountAction.bind(null, dealId, l.id, false, back)} submitLabel={`Dejar en ${Number(l.discount_limit)} %`} pendingLabel="…" secondary className="form inline" />
                                  </span>
                                )}
                              </div>
                            )}
                            {l.discount_status === "approved" && <div className="meta">Aprobado</div>}
                          </td>
                          <td className="num">{money(l.subtotal, deal.currency)}</td>
                          <td>{isOpen && <ActionForm action={removeLineAction.bind(null, dealId, l.id, back)} submitLabel="Quitar" pendingLabel="…" secondary className="form inline doc-remove" />}</td>
                        </tr>
                      ))}
                      <tr className="total-row"><td colSpan={4}>Total (es el importe del deal)</td><td className="num">{money(linesTotal, deal.currency)}</td><td /></tr>
                    </tbody>
                  </table>
                </div>
              )}
              {isOpen && catalog.length > 0 && (
                <details>
                  <summary className="meta">+ Añadir producto</summary>
                  <ActionForm action={addLineAction.bind(null, dealId, back)} submitLabel="Añadir" resetOnSuccess secondary className="form inline">
                    <label className="field"><span className="label">Producto</span>
                      <select name="product_id" required defaultValue="">
                        <option value="" disabled>Elige…</option>
                        {catalog.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.unit_price)}</option>)}
                      </select></label>
                    <label className="field"><span className="label">Cantidad</span><input name="quantity" type="number" min={0.01} step="any" defaultValue={1} required style={{ width: 90 }} /></label>
                    <label className="field"><span className="label">Precio (vacío: el del catálogo)</span><input name="unit_price" type="number" min={0} step="0.01" style={{ width: 130 }} /></label>
                    <label className="field"><span className="label">Dto. %</span><input name="discount_pct" type="number" min={0} max={100} step="any" style={{ width: 80 }} /></label>
                  </ActionForm>
                </details>
              )}

              <h2 className="section-title" style={{ marginTop: 14 }}>Propuestas <span className="muted">{proposals_.length}</span></h2>
              {proposals_.map((p) => (
                <div key={p.id} className="proposal-item">
                  <div className="feed-title">
                    <strong><a href={proposalUrl(p)} target="_blank" rel="noreferrer">{p.title}</a></strong>
                    <span className="meta">{money(p.total, p.currency)} · {dateTime(p.created_at)}{p.ai ? " · redactada por la IA" : ""}</span>
                  </div>
                  <div className="email-badges" style={{ marginLeft: 0, justifyContent: "flex-start" }}>
                    <span className={`badge ${p.status === "accepted" ? "won" : p.status === "declined" ? "lost" : ""}`}>
                      {{ draft: "Borrador", sent: "Enviada", accepted: `Aceptada por ${p.decided_name}`, declined: "Rechazada" }[p.status]}
                    </span>
                    {p.view_count > 0 ? <span className="badge won" title={`Primera vez: ${dateTime(p.first_viewed_at)} · última: ${dateTime(p.last_viewed_at)}`}>Abierta{p.view_count > 1 ? ` ×${p.view_count}` : ""}</span>
                      : <span className="badge">Sin abrir</span>}
                  </div>
                  {(views.get(p.id)?.length ?? 0) > 0 && (
                    <details className="open-log">
                      <summary className="meta">Visitas del cliente ({views.get(p.id)!.length})</summary>
                      <ol>
                        {views.get(p.id)!.slice(0, 15).map((v, i) => (
                          <li key={i}>{dateTime(v.at)}<span className="meta">{[v.device && v.device !== "unknown" ? ` · ${DEVICE_LABEL[v.device as keyof typeof DEVICE_LABEL]}` : "", v.place ? ` · ${v.place}` : ""].join("")}</span></li>
                        ))}
                      </ol>
                    </details>
                  )}
                  <p className="meta" style={{ margin: 0 }}>Enlace para el cliente: <code>{proposalUrl(p)}</code></p>
                  {(p.status === "draft" || p.status === "sent") && (
                    <details>
                      <summary className="meta">Revisar el texto</summary>
                      <ActionForm action={updateProposalAction.bind(null, p.id, back)} submitLabel="Guardar" secondary>
                        <label className="field"><span className="label">Título</span><input name="title" required defaultValue={p.title} /></label>
                        <label className="field"><span className="label">Texto</span><textarea name="intro" rows={8} defaultValue={p.intro} /></label>
                        <label className="field"><span className="label">Válida hasta</span><input name="valid_until" type="date" defaultValue={p.valid_until ?? ""} /></label>
                      </ActionForm>
                      {p.status === "draft" && <ActionForm action={markSentAction.bind(null, p.id, back)} submitLabel="Marcar como enviada" secondary className="form inline" />}
                    </details>
                  )}
                </div>
              ))}
              {isOpen && lines.length > 0 && (
                <ActionForm action={createProposalAction.bind(null, dealId, back)} submitLabel={ai && aiReady(ai) ? "Crear propuesta con IA" : "Crear propuesta"}
                            pendingLabel="Preparando…" secondary className="form inline" />
              )}
              {isOpen && lines.length === 0 && <p className="meta">Añade productos para preparar una propuesta.</p>}
            </section>
          )}

          {(isOpen || closePlan) && (
            <section className="close-plan" aria-label="Plan de cierre">
              <h2 className="section-title">{deal.deal_type === "onboarding" ? "Plan de onboarding" : "Plan de cierre"}
                {closePlan && closePlan.steps.length > 0 && <span className="muted">{closePlan.steps.filter((x) => x.done).length}/{closePlan.steps.length}</span>}
                <span className="spacer" />
                {closePlan && closePlan.steps.length > 0 && (closePlan.shared
                  ? <form action={sharePlanAction.bind(null, dealId, false, back)}><button className="link-btn" type="submit">Dejar de compartir</button></form>
                  : <form action={sharePlanAction.bind(null, dealId, true, back)}><button className="link-btn" type="submit">Compartir con el cliente</button></form>)}
              </h2>
              {closePlan?.shared && <p className="meta" style={{ marginTop: 0 }}>El cliente lo ve (sin poder cambiarlo) en <code>{closePlanUrl(closePlan.token)}</code></p>}
              {(!closePlan || closePlan.steps.length === 0) && (
                <div className="next-prompt">
                  <p><strong>¿Qué falta para la firma?</strong> <span className="muted">Pasos con fecha y responsable, acordados con el cliente: así nada se para en compras o en legal.</span></p>
                  {isOpen && <ActionForm action={generatePlanAction.bind(null, dealId, back)} submitLabel="Crear un plan de partida" pendingLabel="Creando…" secondary className="form inline" />}
                </div>
              )}
              {closePlan && closePlan.steps.length > 0 && (
                <ol className="plan-steps">
                  {closePlan.steps.map((st) => (
                    <li key={st.id} className={[st.done && "done", st.overdue && "overdue"].filter(Boolean).join(" ")}>
                      <form action={togglePlanStepAction.bind(null, dealId, st.id, back)}>
                        <button type="submit" className="plan-check" aria-label={st.done ? `Marcar «${st.title}» como pendiente` : `Marcar «${st.title}» como hecho`}>{st.done ? "✓" : ""}</button>
                      </form>
                      <span className="plan-title">{st.title}</span>
                      <span className="meta">{SIDE_LABEL[st.side]}{st.owner_name ? ` · ${st.owner_name}` : ""}</span>
                      <span className={st.overdue ? "meta tone-bad" : "meta"}>{st.due_date ? date(st.due_date) : "sin fecha"}</span>
                      <form action={deletePlanStepAction.bind(null, dealId, st.id, back)}><button type="submit" className="link-btn meta" aria-label={`Quitar «${st.title}»`}>Quitar</button></form>
                    </li>
                  ))}
                </ol>
              )}
              {isOpen && (
                <details>
                  <summary className="meta">+ Añadir paso</summary>
                  <ActionForm action={addPlanStepAction.bind(null, dealId, back)} submitLabel="Añadir" resetOnSuccess secondary className="form inline">
                    <label className="field" style={{ flex: 1 }}><span className="label">Paso</span><input name="title" required placeholder="Validación de seguridad" /></label>
                    <label className="field"><span className="label">Quién</span>
                      <select name="side" defaultValue="client"><option value="us">Nosotros</option><option value="client">Cliente</option><option value="both">Ambos</option></select></label>
                    <label className="field"><span className="label">Persona</span><input name="owner_name" style={{ width: 140 }} /></label>
                    <label className="field"><span className="label">Fecha</span><input name="due_date" type="date" /></label>
                  </ActionForm>
                </details>
              )}
            </section>
          )}

          {emails.length > 0 && (
            <section className="deal-emails" aria-label="Correos">
              <h2 className="section-title"><Icon name="inbox" />Correos <span className="muted">{emails.length}</span></h2>
              <ol className="email-thread">
                {emails.map((e) => (
                  <li key={e.id} className={`email-item ${e.direction}${e.status === "scheduled" ? " scheduled" : ""}`}>
                    <details>
                      <summary>
                        <span className="email-dir" aria-hidden="true">{e.direction === "in" ? "←" : "→"}</span>
                        <span className="email-main">
                          <strong>{e.subject || "(sin asunto)"}</strong>
                          <span className="meta">
                            {e.direction === "in" ? `De ${e.person_name ?? e.from_email}` : `Para ${e.to_name ?? e.person_name ?? e.to_email}`}
                            {" · "}{e.status === "scheduled" ? `se enviará el ${dateTime(e.scheduled_at)}` : dateTime(e.at)}
                            {e.direction === "out" && e.user_name && ` · desde el correo de ${e.user_name}`}
                          </span>
                        </span>
                        <span className="email-badges">
                          {e.status === "scheduled" && <span className="badge">Programado</span>}
                          {e.status === "failed" && <span className="badge lost" title={e.error ?? undefined}>No se envió</span>}
                          {e.status === "sending" && <span className="badge">Enviando…</span>}
                          {e.direction === "out" && e.status === "sent" && e.track && (
                            e.open_count > 0
                              ? <span className="badge won" title={`Primera apertura: ${dateTime(e.first_opened_at)} · última: ${dateTime(e.last_opened_at)}`}>
                                  Abierto{e.open_count > 1 ? ` ×${e.open_count}` : ""}
                                </span>
                              : <span className="badge">Sin abrir</span>
                          )}
                          {e.click_count > 0 && <span className="badge won">{e.click_count} clic{e.click_count === 1 ? "" : "s"}</span>}
                        </span>
                      </summary>
                      {(opens.get(e.id)?.length ?? 0) > 0 && (
                        <div className="open-log">
                          <strong>Aperturas</strong>
                          <ol>
                            {opens.get(e.id)!.slice(0, 12).map((o, i) => (
                              <li key={i}>{dateTime(o.at)}<span className="meta"> · {[o.device && o.device !== "unknown" ? DEVICE_LABEL[o.device] : null, o.client, o.place].filter(Boolean).join(" · ") || "sin datos del dispositivo"}</span></li>
                            ))}
                          </ol>
                          <Link href={`/emails/${e.id}`} className="meta">Ver el detalle completo</Link>
                        </div>
                      )}
                      <p className="note-body">{e.body}</p>
                      {e.status === "failed" && e.error && <p className="meta tone-bad">{e.error}</p>}
                      {e.status === "scheduled" && (
                        <form action={cancelScheduledEmailAction.bind(null, e.id, back)}>
                          <button type="submit" className="btn secondary small">Cancelar el envío</button>
                        </form>
                      )}
                    </details>
                  </li>
                ))}
              </ol>
              {emails.some((e) => e.track) && <p className="meta">Las aperturas son orientativas: algunos programas de correo abren las imágenes solos o las bloquean.</p>}
            </section>
          )}

          {proposals.length > 0 && (
            <section className="deal-proposals" aria-label="Propuestas de la IA">
              <h2 className="section-title"><Icon name="spark" />Propuestas de la IA <span className="muted">{proposals.length}</span></h2>
              <div className="proposals">{proposals.map((p) => <ProposalCard key={p.id} item={p} showDeal={false} canSend={canSend} />)}</div>
            </section>
          )}

          <section>
            <h2 className="section-title">Enfoque <span className="muted">{pending.length}</span></h2>
            {pending.length === 0 && (isOpen ? (
              <div className="next-prompt" role="region" aria-label="Siguiente actividad">
                <p><strong>¿Qué es lo siguiente?</strong> <span className="muted">Este deal no tiene nada programado: déjalo planificado para que no se quede parado.</span></p>
                <ActionForm action={createActivityAction.bind(null, back)} submitLabel="Programar" resetOnSuccess className="form inline">
                  <input type="hidden" name="deal_id" value={dealId} />
                  {primary && <input type="hidden" name="person_id" value={primary.person_id} />}
                  <label className="field"><span className="label">Tipo</span>
                    <select name="type" defaultValue={stageInfo?.required_activity_type ?? "call"}>
                      {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select></label>
                  <label className="field" style={{ flex: 1 }}><span className="label">Asunto</span><input name="subject" required placeholder="Llamada de seguimiento" /></label>
                  <label className="field"><span className="label">Cuándo</span><input type="datetime-local" name="due_at" required /></label>
                </ActionForm>
              </div>
            ) : <p className="muted">No hay nada pendiente.</p>)}
            <ul className="items">
              {pending.map((a) => (
                <li key={a.id} id={`act-${a.id}`} className={a.is_overdue ? "item overdue" : "item"}>
                  <div className="item-head">
                    <span className="badge">{activityLabel(a.type)}</span>
                    <strong>{a.subject}</strong>
                    {a.is_overdue && <span className="badge lost">Vencida</span>}
                    <span className="spacer" />
                    <span className="meta">{a.due_at ? dateTime(a.due_at) : "Sin fecha"}{a.owner_name && ` · ${a.owner_name}`}</span>
                  </div>
                  {a.note && <p className="note-body">{a.note}</p>}
                  {isSessionType(a.type) && !a.is_overdue && (
                    <details className="prep" open={Boolean(a.prep) && a.due_at !== null && new Date(a.due_at).getTime() - Date.now() < 86400000}>
                      <summary className="meta"><Icon name="spark" />{a.prep ? `Ficha de preparación · ${dateTime(a.prep_at)}` : "Preparar esta reunión"}</summary>
                      {a.prep && <p className="note-body">{a.prep}</p>}
                      <ActionForm action={refreshPrepAction.bind(null, a.id, back)} submitLabel={a.prep ? "Rehacer la ficha" : "Preparar ahora"} pendingLabel="Preparando…" secondary className="form inline" />
                    </details>
                  )}
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
                      {isSessionType(a.type) && (
                        <label className="field" style={{ flexBasis: "100%" }}>
                          <span className="label">Notas o transcripción de la reunión (opcional)</span>
                          <textarea name="transcript" rows={3} placeholder="Pega aquí la transcripción o tus notas: la IA preparará el resumen y los próximos pasos para el cliente." />
                        </label>
                      )}
                    </ActionForm>
                  </details>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="section-title">Historia <span className="spacer" /><ExportLink dataset="deal-history" params={{ deal: dealId }} label="Exportar CSV" small /></h2>
            <HistoryFeed items={items} back={back} />
          </section>
        </div>
      </div>
    </div>
  );
}

