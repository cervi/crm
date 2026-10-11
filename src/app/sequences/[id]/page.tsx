import Link from "next/link";
import { exampleCampaign, isExample } from "@/lib/sequence-example";
import { notFound } from "next/navigation";
import { ConfirmButton } from "@/components/ConfirmButton";
import {
  archiveSequenceAction, bulkEnrollmentsAction, deleteSequenceAction, deleteStepAction, duplicateSequenceAction, moveStepAction, saveStepAction,
  saveVariantAction, setSequenceActiveAction, removeExampleAction, stepActiveAction, updateSequenceSettingsAction, variantAction,
} from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { EmailEditor, type CustomVar } from "@/components/EmailEditor";
import { Icon } from "@/components/Icon";
import { StepForm } from "@/components/sequences/StepForm";
import { EnrollmentTable, type EnrollmentRow } from "@/components/sequences/EnrollmentTable";
import { activeActivityTypes } from "@/lib/activity-types";
import { dateTime } from "@/lib/format";
import { getSequence, listEnrollments, sequenceStats, type Enrollment, type SequenceStep, type VariantStats } from "@/lib/sequences";
import { sequenceEmails, sequenceReport } from "@/lib/sequence-reports";
import { listQueue } from "@/lib/sequence-tasks";
import { describeSchedule, getSchedule, listSchedules } from "@/lib/send-schedule";
import { STEP_KINDS, isEmailKind, PRIORITIES } from "@/lib/step-kinds";
import { listTemplates } from "@/lib/emails";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { aiReady, getAiSettings } from "@/lib/ai";
import { requireUser } from "@/lib/auth";
import { listConnections, listOutboundMailboxes } from "@/lib/mailbox";
import { sql } from "@/lib/db";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = isId(id) ? await getSequence(id) : null;
  return { title: s ? `Secuencia · ${s.name}` : "Secuencia" };
}

const TABS = [
  { key: "resumen", label: "Resumen" },
  { key: "pasos", label: "Pasos" },
  { key: "contactos", label: "Contactos" },
  { key: "correos", label: "Correos" },
  { key: "tareas", label: "Tareas" },
  { key: "ajustes", label: "Ajustes" },
] as const;
type Tab = (typeof TABS)[number]["key"];

const STATUS_FILTERS = [
  { key: "todos", label: "Todos" },
  { key: "active", label: "Activos" },
  { key: "paused", label: "En pausa" },
  { key: "finished", label: "Terminados" },
  { key: "bounced", label: "Rebotados" },
  { key: "failed", label: "No enviados" },
  { key: "removed", label: "Quitados" },
] as const;

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** Las variables se enseñan legibles: {{nombre_completo}} → [nombre completo]. */
const vars = (t: string) => t.replace(/\{\{\s*([\w.]+)(?:\|[^}]*)?\s*\}\}/g, (_, k: string) => `[${k.replace(/_/g, " ")}]`);

function statusOf(e: Enrollment): { label: string; tone: string } {
  if (e.status === "active") return { label: e.waiting_activity_id ? "Esperando tarea" : "Activo", tone: "open" };
  if (e.status === "paused") return { label: "En pausa", tone: "warn" };
  if (e.status === "failed") return { label: "No enviado", tone: "lost" };
  if (e.status === "removed") return { label: "Quitado", tone: "" };
  if (e.stopped_reason?.toLowerCase().includes("rebot")) return { label: "Rebotado", tone: "lost" };
  return { label: "Terminado", tone: "" };
}

function StatsTable({ step, stats }: { step: SequenceStep; stats: VariantStats[] }) {
  const rows = stats.filter((s) => s.step_id === step.id);
  if (!rows.length) return null;
  const multi = rows.length > 1 || step.variants.length > 0;
  const best = multi ? [...rows].filter((r) => r.sent >= 5).sort((a, b) => b.replied / b.sent - a.replied / a.sent || b.opened / b.sent - a.opened / a.sent)[0] : null;
  return (
    <table className="ee-stats" aria-label={`Resultados del paso ${step.position}`}>
      <thead><tr>{multi && <th>Variante</th>}<th className="num">Enviados</th><th className="num">Abiertos</th><th className="num">Clics</th><th className="num">Respuestas</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.variant}>
            {multi && <td>{r.variant}{best?.variant === r.variant && <span className="badge won" style={{ marginLeft: 6 }}>Va ganando</span>}</td>}
            <td className="num">{r.sent}</td><td className="num">{pct(r.opened, r.sent)}</td><td className="num">{pct(r.clicked, r.sent)}</td><td className="num">{pct(r.replied, r.sent)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function SequencePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; estado?: string; q?: string; ver?: string; filtro?: string; anadidos?: string; saltados?: string }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!isId(id)) notFound();
  const user = await requireUser();
  const [seq, example, exCampaign] = await Promise.all([getSequence(id), isExample(id), exampleCampaign(id)]);
  if (!seq) notFound();
  const tab: Tab = TABS.find((t) => t.key === sp.tab)?.key ?? (seq.steps.length === 0 ? "pasos" : "resumen");
  const canEdit = user.role !== "viewer";
  const [report, enrollments] = await Promise.all([sequenceReport(id), listEnrollments({ sequenceId: id })]);
  const schedule = await getSchedule(seq.schedule_id);
  const waitingTasks = enrollments.filter((e) => e.status === "active" && e.waiting_activity_id).length;
  const counts = { todos: enrollments.length, active: report.status.active, paused: report.status.paused, finished: report.status.finished,
                   bounced: report.status.bounced, failed: report.status.failed, removed: report.status.removed } as Record<string, number>;

  return (
    <main className="page">
      <div className="crumbs"><Link href="/sequences">Secuencias</Link>{seq.folder ? <> · <Link href={`/sequences?carpeta=${encodeURIComponent(seq.folder)}`}>{seq.folder}</Link></> : null}</div>
      <div className="page-head">
        <div>
          <h1>{seq.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {example ? <span className="badge">Ejemplo · no envía</span>
              : <span className={`badge ${seq.archived_at ? "" : seq.is_active ? "won" : "warn"}`}>{seq.archived_at ? "Archivada" : seq.is_active ? "Activa" : "En pausa"}</span>}{" "}
            {seq.steps.length} paso{seq.steps.length === 1 ? "" : "s"} · {describeSchedule(schedule)}
          </p>
        </div>
        {canEdit && !seq.archived_at && !example && (
          <div className="head-actions">
            <ActionForm action={setSequenceActiveAction.bind(null, id, !seq.is_active)} submitLabel={seq.is_active ? "Pausar la secuencia" : "Activar"}
                        secondary={seq.is_active || seq.steps.length === 0} className="form inline"
                        confirm={seq.is_active ? "No saldrá nada hasta que la vuelvas a activar. Los contactos se quedan donde están." : undefined} />
            <Link className={seq.is_active || seq.steps.length === 0 ? "btn" : "btn secondary"} href={`/sequences/${id}/anadir`}><Icon name="plus" />Añadir contactos</Link>
          </div>
        )}
      </div>
      {sp.anadidos !== undefined && (
        <p className="callout good" role="status">{sp.anadidos === "0" ? "No se ha añadido a nadie." : `${sp.anadidos} contacto${sp.anadidos === "1" ? "" : "s"} añadido${sp.anadidos === "1" ? "" : "s"}.`}
          {sp.saltados && sp.saltados !== "0" ? ` ${sp.saltados} se quedaron fuera por los avisos.` : ""}</p>
      )}
      {example && (
        <div className="callout example-offer">
          <div><strong>Esto es un ejemplo con contactos ficticios: no envía nada.</strong>
            <span className="meta"> Mira las pestañas: quién respondió o rebotó, los correos con sus aperturas, el informe por paso y las tareas que esperan en tu cola (en <Link href="/sequences/tasks">Tareas</Link>).
              {exCampaign && <> La usa la <Link href={`/campaigns/${exCampaign}`}>campaña de ejemplo</Link>.</>} Para usarla con tus contactos, duplícala: la copia sale limpia, en pausa.</span></div>
          {canEdit && (
            <div className="head-actions">
              <ActionForm action={duplicateSequenceAction.bind(null, id)} submitLabel="Usarla de verdad" pendingLabel="Duplicando…" className="form inline" />
              <ActionForm action={removeExampleAction.bind(null, id, "sequences")} submitLabel="Borrar el ejemplo" pendingLabel="Borrando…" secondary className="form inline"
                          confirm="Se borran la secuencia, la campaña de ejemplo y sus contactos, empresas, deal, correos y tareas de muestra." />
            </div>
          )}
        </div>
      )}
      {!example && !seq.is_active && !seq.archived_at && seq.steps.length > 0 && <p className="callout">La secuencia está en pausa: no sale ningún correo ni se crean tareas hasta que la actives.</p>}

      <nav className="tabs" aria-label="Secciones de la secuencia">
        {TABS.map((t) => (
          <Link key={t.key} href={`/sequences/${id}?tab=${t.key}`} aria-current={tab === t.key ? "page" : undefined}>
            {t.label}
            {t.key === "contactos" && enrollments.length - report.status.removed > 0 && <span className="count neutral">{enrollments.length - report.status.removed}</span>}
            {t.key === "pasos" && <span className="count neutral">{seq.steps.length}</span>}
            {t.key === "tareas" && waitingTasks > 0 && <span className="count">{waitingTasks}</span>}
          </Link>
        ))}
      </nav>

      {tab === "resumen" && <Summary id={id} report={report} steps={seq.steps} />}
      {tab === "pasos" && <Steps id={id} userId={user.id} seq={seq} canEdit={canEdit && !seq.archived_at} />}
      {tab === "contactos" && (
        <Contacts id={id} enrollments={enrollments} counts={counts} filter={sp.estado} q={sp.q} steps={seq.steps} canEdit={canEdit && !seq.archived_at} />
      )}
      {tab === "correos" && <Emails id={id} view={sp.ver === "programados" ? "scheduled" : "sent"} filter={sp.filtro} />}
      {tab === "tareas" && <Tasks id={id} />}
      {tab === "ajustes" && <Settings id={id} seq={seq} canEdit={canEdit} />}
    </main>
  );
}

// ---------------------------------------------------------------------------

function Kpi({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return <div className="kpi"><span className="meta">{label}</span><strong>{value}</strong>{hint && <span className="meta">{hint}</span>}</div>;
}

async function Summary({ id, report: r, steps }: { id: string; report: Awaited<ReturnType<typeof sequenceReport>>; steps: SequenceStep[] }) {
  const stats = await sequenceStats(id);
  const funnel = [
    { label: "En la secuencia", n: r.contacts.total },
    { label: "Contactados", n: r.contacts.contacted },
    { label: "Entregados", n: r.contacts.delivered },
    { label: "Abrieron", n: r.contacts.opened },
    { label: "Respondieron", n: r.contacts.replied },
    { label: "Interesados", n: r.contacts.interested },
  ];
  const max = Math.max(1, funnel[0].n);
  return (
    <>
      <section className="kpi-row" aria-label="Lo importante">
        <Kpi label="Activos" value={r.status.active} hint={r.status.scheduled ? `${r.status.scheduled} con correo programado` : undefined} />
        <Kpi label="Respondieron" value={r.contacts.replied} hint={r.contacts.delivered ? `${pct(r.contacts.replied, r.contacts.delivered)} de los que lo recibieron` : undefined} />
        <Kpi label="Interesados" value={r.contacts.interested} />
        <Link href={`/sequences/${id}?tab=contactos&estado=paused`} className="kpi kpi-link">
          <span className="meta">Necesitan atención</span><strong>{r.status.paused + r.status.failed + r.status.bounced}</strong>
          <span className="meta">{[r.status.paused && `${r.status.paused} en pausa`, r.status.failed && `${r.status.failed} sin enviar`, r.status.bounced && `${r.status.bounced} rebotados`].filter(Boolean).join(" · ") || "Nada"}</span>
        </Link>
      </section>
      <div className="grid-2">
        <section className="panel" aria-label="Embudo por contacto">
          <h2>Embudo por contacto</h2>
          <ol className="seq-funnel">
            {funnel.map((f, i) => (
              <li key={f.label}>
                <span>{f.label}</span>
                <span className="funnel-bar"><span style={{ width: `${Math.round((f.n / max) * 100)}%` }} /></span>
                <strong className="num">{f.n}</strong>
                <span className="meta num">{i > 0 ? pct(f.n, funnel[i - 1].n) : ""}</span>
              </li>
            ))}
          </ol>
          {r.contacts.unsubscribed > 0 && <p className="meta">{r.contacts.unsubscribed} se dieron de baja.</p>}
        </section>
        <section className="panel" aria-label="Correos">
          <h2>Correos</h2>
          <div className="kpi-row compact">
            <Kpi label="Enviados" value={r.emails.sent} />
            <Kpi label="Entregados" value={pct(r.emails.sent - r.emails.bounced, r.emails.sent)} />
            <Kpi label="Abiertos" value={pct(r.emails.opened, r.emails.sent)} />
            <Kpi label="Clics" value={pct(r.emails.clicked, r.emails.sent)} />
            <Kpi label="Respuestas" value={pct(r.emails.replied, r.emails.sent)} />
          </div>
          <h3>Tareas</h3>
          <p className="meta" style={{ margin: 0 }}>{plural(r.tasks.pending, "pendiente", "pendientes")} · {plural(r.tasks.done, "hecha", "hechas")}{r.tasks.calls_answered ? ` · ${plural(r.tasks.calls_answered, "llamada contestada", "llamadas contestadas")}` : ""}</p>
        </section>
      </div>

      <section className="panel" aria-label="Resultados por paso">
        <h2>Por paso</h2>
        <div className="table-wrap flat">
          <table>
            <thead><tr><th>Paso</th><th className="num">Enviados</th><th className="num">Abiertos</th><th className="num">Clics</th><th className="num">Respuestas</th></tr></thead>
            <tbody>
              {steps.map((st) => {
                const rows = stats.filter((x) => x.step_id === st.id);
                const sum = rows.reduce((a, x) => ({ sent: a.sent + x.sent, opened: a.opened + x.opened, clicked: a.clicked + x.clicked, replied: a.replied + x.replied }),
                  { sent: 0, opened: 0, clicked: 0, replied: 0 });
                return (
                  <tr key={st.id}>
                    <td><Icon name={STEP_KINDS[st.kind].icon} /> {st.position}. {STEP_KINDS[st.kind].short}{st.subject ? ` · ${vars(st.subject)}` : st.thread_reply ? " · en el hilo" : ""}
                      {st.variants.length > 0 && <span className="meta"> · A/B</span>}</td>
                    {isEmailKind(st.kind) ? (
                      <><td className="num">{sum.sent || "—"}</td><td className="num">{pct(sum.opened, sum.sent)}</td><td className="num">{pct(sum.clicked, sum.sent)}</td><td className="num">{pct(sum.replied, sum.sent)}</td></>
                    ) : <td colSpan={4} className="meta">Tarea</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid-2">
        {r.byMailbox.length > 0 && (
          <section className="panel" aria-label="Por buzón">
            <h2>Por buzón</h2>
            <div className="table-wrap flat"><table>
              <thead><tr><th>Buzón</th><th className="num">Enviados</th><th className="num">Abiertos</th><th className="num">Respondieron</th><th className="num">Rebotes</th></tr></thead>
              <tbody>{r.byMailbox.map((m) => (
                <tr key={m.email}><td>{m.email}</td><td className="num">{m.sent}</td><td className="num">{pct(m.opened, m.sent)}</td><td className="num">{m.replied}</td>
                  <td className={`num${m.sent >= 20 && m.bounced / m.sent > 0.03 ? " tone-bad" : ""}`}>{pct(m.bounced, m.sent)}</td></tr>
              ))}</tbody>
            </table></div>
          </section>
        )}
        {r.contacts.total > 0 && (
          <section className="panel" aria-label="Público que más responde">
            <h2>Quién responde</h2>
            {[["Por cargo", r.byTitle], ["Por sector", r.byIndustry]].map(([title, rows]) => (
              <div key={title as string}>
                <h3>{title as string}</h3>
                <div className="table-wrap flat"><table>
                  <thead><tr><th /><th className="num">Contactos</th><th className="num">Respondieron</th><th className="num">Interesados</th></tr></thead>
                  <tbody>{(rows as typeof r.byTitle).map((x) => (
                    <tr key={x.label}><td>{x.label}</td><td className="num">{x.contacts}</td><td className="num">{pct(x.replied, x.contacts)}</td><td className="num">{pct(x.interested, x.contacts)}</td></tr>
                  ))}</tbody>
                </table></div>
              </div>
            ))}
          </section>
        )}
      </div>
    </>
  );
}

async function Steps({ id, userId, seq, canEdit }: { id: string; userId: string; seq: NonNullable<Awaited<ReturnType<typeof getSequence>>>; canEdit: boolean }) {
  const [types, stats, templates, ai, personFields, orgFields, dealFields, enrollments] = await Promise.all([
    activeActivityTypes(), sequenceStats(id), listTemplates(userId), getAiSettings(),
    listFieldDefinitions("person"), listFieldDefinitions("organization"), listFieldDefinitions("deal"), listEnrollments({ sequenceId: id }),
  ]);
  const typeOptions = types.map((t) => ({ key: t.key, label: t.label }));
  const customVars: CustomVar[] = [
    ...personFields.map((f) => ({ key: `contacto.${f.key}`, label: f.label, group: "Campos del contacto" })),
    ...orgFields.map((f) => ({ key: `empresa.${f.key}`, label: f.label, group: "Campos de la empresa" })),
    ...dealFields.map((f) => ({ key: `deal.${f.key}`, label: f.label, group: "Campos del deal" })),
  ];
  const seen = new Set<string>();
  const contacts = enrollments.filter((e) => !seen.has(e.person_id) && seen.add(e.person_id)).slice(0, 30)
    .map((e) => ({ id: e.person_id, label: e.person_name, hint: e.deal_title }));
  const editor = {
    sequenceId: id, contacts, customVars, aiReady: aiReady(ai),
    templates: templates.map((t) => ({ id: t.id, name: t.name, subject: t.subject, body: t.body, format: t.format })),
  };
  let hours = 0;
  return (
    <>
      {seq.steps.length === 0 && (
        <div className="empty-state">
          <strong>Añade el primer paso.</strong>
          <span className="meta">Combina correos automáticos (en el mismo hilo), llamadas y pasos de LinkedIn. Las tareas esperan a que las hagas; los correos salen solos en el horario de envío.</span>
        </div>
      )}
      <ol className="seq-timeline">
        {seq.steps.map((st, i) => {
          hours += st.delay_days * 24 + st.delay_hours;
          const day = Math.floor(hours / 24) + 1;
          const isEmail = isEmailKind(st.kind);
          const k = STEP_KINDS[st.kind];
          return (
            <li key={st.id} className={`seq-node${st.is_active ? "" : " off"}`}>
              <div className="seq-day"><strong>Día {day}</strong>{hours % 24 ? <span className="meta">+{hours % 24} h</span> : null}</div>
              <div className="panel seq-step" aria-label={`Paso ${st.position}`}>
                <div className="rule-head">
                  <div>
                    <p className="meta" style={{ margin: 0 }}>
                      <span className={`step-chip ch-${k.channel}`}><Icon name={k.icon} />{k.label}</span>
                      {" "}Paso {st.position}{st.delay_days || st.delay_hours ? ` · ${st.delay_days ? `${st.delay_days} d` : ""}${st.delay_hours ? ` ${st.delay_hours} h` : ""} después` : ""}
                      {st.priority !== "medium" ? ` · prioridad ${PRIORITIES[st.priority].toLowerCase()}` : ""}
                      {st.thread_reply ? " · en el mismo hilo" : ""}
                      {st.variants.length > 0 && ` · prueba A/B (${1 + st.variants.filter((v) => v.is_active).length} variantes)`}
                      {!st.is_active && " · desactivado (se salta)"}
                    </p>
                    <h3 style={{ margin: "2px 0 0" }}>{st.subject ? vars(st.subject) : st.thread_reply ? "Re: (asunto anterior)" : isEmail ? "(sin asunto)" : k.label}</h3>
                    {!isEmail && st.body && <p className="meta clamp-2" style={{ margin: "2px 0 0" }}>{vars(st.body)}</p>}
                  </div>
                  {canEdit && (
                    <div className="ee-row">
                      <Drawer label="Editar" buttonClass="btn secondary small" title={`Paso ${st.position}: ${k.label}`} subtitle={isEmail && st.variants.length ? "Variante A" : undefined}>
                        <ActionForm action={saveStepAction.bind(null, id, st.id)} submitLabel="Guardar paso">
                          <StepForm step={st} first={i === 0} types={typeOptions} label={`paso ${st.position}`} {...editor} />
                        </ActionForm>
                      </Drawer>
                      <details className="step-more">
                        <summary className="btn secondary small" aria-label={`Más acciones del paso ${st.position}`}><Icon name="dots" /></summary>
                        <div className="step-more-menu">
                          {i > 0 && <form action={moveStepAction.bind(null, id, st.id, -1)}><button type="submit">Subir</button></form>}
                          {i < seq.steps.length - 1 && <form action={moveStepAction.bind(null, id, st.id, 1)}><button type="submit">Bajar</button></form>}
                          <form action={stepActiveAction.bind(null, id, st.id, !st.is_active)}><button type="submit">{st.is_active ? "Desactivar (se salta)" : "Activar"}</button></form>
                          <form action={deleteStepAction.bind(null, id, st.id)}>
                            <ConfirmButton label="Quitar el paso" ariaLabel={`Quitar el paso ${st.position}`} confirm="Se quita el paso; los contactos que estaban en él pasan al siguiente." />
                          </form>
                        </div>
                      </details>
                    </div>
                  )}
                </div>
                {isEmail && <StatsTable step={st} stats={stats} />}
                {isEmail && canEdit && st.variants.map((v) => (
                  <details key={v.id} className="ee-variant">
                    <summary className="meta">Variante {v.label}{v.is_active ? "" : " (en pausa)"}: {v.subject || "Re: (asunto anterior)"}</summary>
                    <ActionForm action={saveVariantAction.bind(null, id, st.id, v.id)} submitLabel={`Guardar variante ${v.label}`} secondary>
                      <EmailEditor initialSubject={v.subject} initialBody={v.body} initialFormat={st.format} formatLocked
                                   threadReply={st.thread_reply} firstStep={i === 0} label={`paso ${st.position} variante ${v.label}`} {...editor} />
                    </ActionForm>
                    <div className="ee-row">
                      <form action={variantAction.bind(null, id, st.id, v.id, v.is_active ? "off" : "on")}><button type="submit" className="btn secondary small">{v.is_active ? "Pausar variante" : "Activar variante"}</button></form>
                      <form action={variantAction.bind(null, id, st.id, v.id, "promote")}><button type="submit" className="btn secondary small" aria-label={`Quedarse con la variante ${v.label}`}>Quedarse con esta (pasa a ser la A)</button></form>
                      <form action={variantAction.bind(null, id, st.id, v.id, "delete")}><ConfirmButton label="Borrar variante" confirm="Se borra la variante y sus estadísticas." /></form>
                    </div>
                  </details>
                ))}
                {isEmail && canEdit && st.kind === "email" && (
                  <details className="ee-variant">
                    <summary className="meta">+ Prueba A/B: añadir una variante</summary>
                    <p className="meta">Cada contacto recibe una de las variantes activas, a partes iguales. Cambia el asunto o el texto y compara aperturas y respuestas.</p>
                    <ActionForm action={saveVariantAction.bind(null, id, st.id, null)} submitLabel="Añadir variante" secondary>
                      <EmailEditor initialSubject={st.subject} initialBody={st.body} initialFormat={st.format} formatLocked
                                   threadReply={st.thread_reply} firstStep={i === 0} label={`paso ${st.position} nueva variante`} {...editor} />
                    </ActionForm>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {canEdit && (
        <Drawer label={<><Icon name="plus" />Añadir un paso</>} buttonClass={seq.steps.length ? "btn secondary" : "btn"} title="Añadir un paso"
                subtitle="Correo, llamada, LinkedIn o tarea." defaultOpen={seq.steps.length === 0}>
          <ActionForm action={saveStepAction.bind(null, id, null)} submitLabel="Añadir paso" resetOnSuccess>
            <StepForm first={seq.steps.length === 0} types={typeOptions} label="nuevo paso" {...editor} />
          </ActionForm>
        </Drawer>
      )}
    </>
  );
}

async function Contacts({ id, enrollments, counts, filter, q, steps, canEdit }: {
  id: string; enrollments: Enrollment[]; counts: Record<string, number>; filter?: string; q?: string; steps: SequenceStep[]; canEdit: boolean;
}) {
  const f = STATUS_FILTERS.find((x) => x.key === filter)?.key ?? "todos";
  const query = (q ?? "").trim().toLowerCase();
  const list = enrollments.filter((e) => {
    const s = statusOf(e).label;
    const ok = f === "todos" ? e.status !== "removed" : f === "finished" ? (e.status === "completed" || e.status === "stopped") && s !== "Rebotado"
      : f === "bounced" ? s === "Rebotado" : e.status === f;
    return ok && (!query || `${e.person_name} ${e.email ?? ""} ${e.organization_name ?? ""}`.toLowerCase().includes(query));
  });
  const [conns, outbound] = await Promise.all([listConnections(), listOutboundMailboxes()]);
  const mailboxes = [...conns.filter((c) => c.status === "active").map((c) => ({ id: c.id, label: `${c.email} (${c.user_name})` })),
                     ...outbound.filter((c) => c.status === "active").map((c) => ({ id: c.id, label: `${c.email} (outbound)` }))];
  const rows: EnrollmentRow[] = list.map((e) => {
    const s = statusOf(e);
    const step = steps[e.next_step];
    const reason = e.status === "paused" ? [e.paused_reason, e.resume_at ? `se reanuda el ${dateTime(e.resume_at)}` : null, e.error].filter(Boolean).join(" · ")
      : e.status === "failed" ? e.error : e.stopped_reason;
    return {
      id: e.id, person_id: e.person_id, person_name: e.person_name, email: e.email, organization_name: e.organization_name, status: e.status,
      status_label: s.label, tone: s.tone, reason: reason || null,
      step_text: e.status === "active" || e.status === "paused" ? `${Math.min(e.next_step + 1, e.steps)} de ${e.steps}${step ? ` · ${STEP_KINDS[step.kind].short}` : ""}` : `${Math.min(e.next_step, e.steps)} de ${e.steps}`,
      next_text: e.status === "active" ? (e.waiting_activity_id ? "Tarea pendiente" : e.next_run_at ? dateTime(e.next_run_at) : null) : null,
      mailbox_email: e.mailbox_email, sent: e.sent, opened: e.opened, replied: e.replied, added: dateTime(e.created_at),
      deal_id: e.deal_id, deal_title: e.deal_title,
    };
  });
  return (
    <>
      <div className="filter-row">
        <nav className="chips" aria-label="Estado">
          {STATUS_FILTERS.map((x) => (
            <Link key={x.key} href={`/sequences/${id}?tab=contactos&estado=${x.key}${q ? `&q=${encodeURIComponent(q)}` : ""}`} aria-current={f === x.key ? "page" : undefined}>
              {x.label} <span className="meta">{x.key === "todos" ? counts.todos - (counts.removed ?? 0) : counts[x.key] ?? 0}</span>
            </Link>
          ))}
        </nav>
        <form className="search-inline" role="search">
          <input type="hidden" name="tab" value="contactos" /><input type="hidden" name="estado" value={f} />
          <input name="q" defaultValue={q} placeholder="Buscar contacto, correo o empresa" aria-label="Buscar contactos" />
        </form>
      </div>
      {enrollments.length === 0 ? (
        <div className="empty-state">
          <strong>Nadie en la secuencia todavía.</strong>
          <span className="meta">Añade contactos buscándolos o pegando sus correos; antes de entrar verás los avisos (sin email, en otra secuencia…).</span>
          {canEdit && <Link className="btn" href={`/sequences/${id}/anadir`}><Icon name="plus" />Añadir contactos</Link>}
        </div>
      ) : rows.length === 0 ? <p className="muted">Nadie en este estado.</p> : (
        <EnrollmentTable rows={rows} action={bulkEnrollmentsAction.bind(null, id)} mailboxes={mailboxes} canEdit={canEdit}
                         steps={steps.map((s, i) => ({ index: i, label: `${s.position}. ${STEP_KINDS[s.kind].short}${s.subject ? ` · ${s.subject}` : ""}` }))} />
      )}
    </>
  );
}

async function Emails({ id, view, filter }: { id: string; view: "scheduled" | "sent"; filter?: string }) {
  const rows = await sequenceEmails(id, view, filter);
  const filters = [["", "Todos"], ["abiertos", "Abiertos"], ["sin_abrir", "Sin abrir"], ["clics", "Con clic"], ["respondidos", "Respondidos"], ["rebotados", "Rebotados"]];
  return (
    <>
      <div className="filter-row">
        <nav className="chips" aria-label="Correos">
          <Link href={`/sequences/${id}?tab=correos&ver=enviados`} aria-current={view === "sent" ? "page" : undefined}>Enviados</Link>
          <Link href={`/sequences/${id}?tab=correos&ver=programados`} aria-current={view === "scheduled" ? "page" : undefined}>Programados</Link>
        </nav>
        {view === "sent" && (
          <nav className="chips" aria-label="Filtrar">
            {filters.map(([k, l]) => <Link key={k} href={`/sequences/${id}?tab=correos&ver=enviados${k ? `&filtro=${k}` : ""}`} aria-current={(filter ?? "") === k ? "page" : undefined}>{l}</Link>)}
          </nav>
        )}
      </div>
      {rows.length === 0 ? <p className="muted">{view === "scheduled" ? "No hay correos programados ahora mismo." : "Ningún correo con este filtro."}</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Para</th><th>Paso</th><th>Asunto</th><th>{view === "scheduled" ? "Saldrá" : "Enviado"}</th><th>Desde</th>{view === "sent" && <th>Estado</th>}</tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id}>
                  <td><Link href={`/persons/${m.person_id}`}>{m.person_name}</Link><div className="meta">{m.to ?? "sin email"}</div></td>
                  <td className="num">{m.step ?? "—"}</td>
                  <td>{view === "sent" ? <Link href={`/emails/${m.id}`}>{m.subject ?? "(sin asunto)"}</Link> : m.subject ?? <span className="meta">Re: (asunto anterior)</span>}</td>
                  <td className="nowrap">{m.at ? dateTime(m.at) : "—"}{view === "scheduled" && <div className="meta">o al abrir la franja de envío</div>}</td>
                  <td className="meta">{m.from_email ?? "—"}</td>
                  {view === "sent" && (
                    <td>{m.bounced ? <span className="badge lost">Rebotó</span> : m.replied ? <span className="badge won">Respondió</span>
                      : m.clicked ? <span className="badge open">Clic</span> : m.opened ? <span className="badge open">Abierto{m.open_count > 1 ? ` ×${m.open_count}` : ""}</span>
                      : <span className="badge">Entregado</span>}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

async function Tasks({ id }: { id: string }) {
  const tasks = await listQueue({ userId: null, all: true, when: "todas", sequenceId: id });
  return tasks.length === 0 ? (
    <div className="empty-state"><strong>No hay tareas pendientes en esta secuencia.</strong>
      <span className="meta">Las llamadas, pasos de LinkedIn y correos manuales aparecen aquí y en <Link href="/sequences/tasks">Tareas de secuencias</Link>.</span></div>
  ) : (
    <>
      <p><Link className="btn" href={`/sequences/tasks/hacer?secuencia=${id}`}><Icon name="send" />Hacerlas una tras otra</Link></p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Tarea</th><th>Contacto</th><th>Paso</th><th>Vence</th><th>Responsable</th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.activity_id}>
                <td><Icon name={STEP_KINDS[t.step_kind as keyof typeof STEP_KINDS]?.icon ?? "check"} /> {t.subject}
                  {t.priority === "high" && <span className="badge warn" style={{ marginLeft: 6 }}>Alta</span>}</td>
                <td><Link href={`/persons/${t.person_id}`}>{t.person_name}</Link>{t.organization && <div className="meta">{t.organization}</div>}</td>
                <td className="num">{t.step} de {t.steps}</td>
                <td className={`nowrap${t.overdue ? " tone-bad" : ""}`}>{t.due_at ? dateTime(t.due_at) : "—"}</td>
                <td className="meta">{t.owner_name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

async function Settings({ id, seq, canEdit }: { id: string; seq: NonNullable<Awaited<ReturnType<typeof getSequence>>>; canEdit: boolean }) {
  const [schedules, users] = await Promise.all([
    listSchedules(),
    sql<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE kind = 'human' AND is_active ORDER BY name`,
  ]);
  return (
    <>
      <ActionForm action={updateSequenceSettingsAction.bind(null, id)} submitLabel="Guardar ajustes">
        <section className="panel" aria-label="General">
          <h2>General</h2>
          <div className="grid-2">
            <label className="field"><span className="label">Nombre *</span><input name="name" required maxLength={120} defaultValue={seq.name} /></label>
            <label className="field"><span className="label">Carpeta</span><input name="folder" maxLength={60} defaultValue={seq.folder ?? ""} placeholder="p. ej. Outbound, Inbound, Clientes" /></label>
            <label className="field"><span className="label">Para qué es</span><input name="description" maxLength={1000} defaultValue={seq.description ?? ""} /></label>
            <label className="field"><span className="label">Propietario</span>
              <select name="owner_id" defaultValue={seq.owner_id ?? ""}><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          </div>
        </section>
        <section className="panel" aria-label="Horario de envío">
          <h2>Horario de envío</h2>
          <label className="field"><span className="label">Los correos automáticos salen</span>
            <select name="schedule_id" defaultValue={seq.schedule_id ?? ""}>
              {!seq.schedule_id && <option value="">Días y horas de antes ({seq.send_days.length} días, {seq.send_from}:00–{seq.send_to}:00)</option>}
              {schedules.map((s) => <option key={s.id} value={s.id}>{s.name}: {describeSchedule(s)}</option>)}
            </select>
            <span className="meta">Las tareas se crean aunque sea fuera del horario. <Link href="/sequences/horarios">Gestionar horarios</Link></span></label>
        </section>
        <section className="panel" aria-label="Reglas">
          <h2>Reglas</h2>
          <div className="rules-grid">
            <label className="checkbox"><input type="checkbox" name="stop_on_reply" defaultChecked={seq.stop_on_reply} />Terminar si responde</label>
            <label className="checkbox"><input type="checkbox" name="stop_on_meeting" defaultChecked={seq.stop_on_meeting} />Terminar si se agenda una reunión con él</label>
            <label className="checkbox"><input type="checkbox" name="pause_on_ooo" defaultChecked={seq.pause_on_ooo} />Pausar si responde «fuera de la oficina» y reanudar a su vuelta</label>
            <label className="checkbox"><input type="checkbox" name="finish_on_click" defaultChecked={seq.finish_on_click} />Terminar si hace clic en un enlace</label>
          </div>
          <p className="meta">Siempre: termina si se da de baja, si contesta una llamada de la secuencia o si su deal se cierra; si su correo rebota, no se le vuelve a escribir.</p>
          <div className="grid-3">
            <label className="field"><span className="label">Si responde otra persona de su empresa</span>
              <select name="same_account" defaultValue={seq.same_account}>
                <option value="none">Seguir igual</option><option value="stop">Terminar también con él</option><option value="delay">Esperar unos días</option>
              </select></label>
            <label className="field"><span className="label">Días de espera (si «esperar»)</span><input name="same_account_days" type="number" min={1} max={90} defaultValue={seq.same_account_days} /></label>
            <label className="field"><span className="label">Crear una llamada tras N aperturas</span><input name="call_after_opens" type="number" min={1} max={50} defaultValue={seq.call_after_opens ?? ""} placeholder="vacío: no" /></label>
          </div>
        </section>
        <section className="panel" aria-label="Envío">
          <h2>Envío</h2>
          <div className="rules-grid">
            <label className="checkbox"><input type="checkbox" name="track" defaultChecked={seq.track} />Seguir aperturas y clics</label>
            <label className="checkbox"><input type="checkbox" name="add_signature" defaultChecked={seq.add_signature} />Añadir la firma del buzón</label>
            <label className="checkbox"><input type="checkbox" name="unsubscribe_link" defaultChecked={seq.unsubscribe_link} />Enlace de baja (y baja con un clic en Gmail)</label>
          </div>
          <div className="grid-3">
            <label className="field"><span className="label">Máximo de correos en 24 h</span><input name="daily_limit" type="number" min={1} max={5000} defaultValue={seq.daily_limit ?? ""} placeholder="sin límite de secuencia" />
              <span className="meta">Además del límite y el ritmo de cada buzón.</span></label>
            <label className="field"><span className="label">CC en todos los correos</span><input name="cc" defaultValue={seq.cc ?? ""} placeholder="correo@empresa.com" /></label>
            <label className="field"><span className="label">CCO en todos los correos</span><input name="bcc" defaultValue={seq.bcc ?? ""} placeholder="p. ej. el de tu CRM antiguo" /></label>
          </div>
        </section>
        {!canEdit && <p className="meta">Solo lectura.</p>}
      </ActionForm>

      {canEdit && (
        <section className="panel danger-zone" aria-label="Más acciones">
          <h2>Más acciones</h2>
          <div className="ee-row">
            <ActionForm action={duplicateSequenceAction.bind(null, id)} submitLabel="Duplicar" secondary className="form inline" />
            <ActionForm action={archiveSequenceAction.bind(null, id, !seq.archived_at)} submitLabel={seq.archived_at ? "Sacar del archivo" : "Archivar"} secondary className="form inline"
                        confirm={seq.archived_at ? undefined : "Se terminan los contactos en marcha y deja de enviar. Sus datos y resultados se conservan."} />
            <ActionForm action={deleteSequenceAction.bind(null, id)} submitLabel="Borrar" danger className="form inline"
                        confirm="Se borra la secuencia con sus pasos. Si tiene contactos en marcha, archívala en vez de borrarla." />
          </div>
        </section>
      )}
    </>
  );
}
