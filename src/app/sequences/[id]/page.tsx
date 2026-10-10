import Link from "next/link";
import { ConfirmButton } from "@/components/ConfirmButton";
import { notFound } from "next/navigation";
import {
  deleteSequenceAction, deleteStepAction, moveStepAction, resumeEnrollmentAction, saveStepAction, saveVariantAction,
  stopEnrollmentAction, updateSequenceAction, updateSequenceSendingAction, variantAction,
} from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { EmailEditor, type CustomVar } from "@/components/EmailEditor";
import { StepForm } from "@/components/sequences/StepForm";
import { activeActivityTypes } from "@/lib/activity-types";
import { activityLabel, dateTime } from "@/lib/format";
import { getSequence, listEnrollments, sequenceStats, type SequenceStep, type VariantStats } from "@/lib/sequences";
import { listTemplates } from "@/lib/emails";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { aiReady, getAiSettings } from "@/lib/ai";
import { requireUser } from "@/lib/auth";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Secuencia" };

const STATUS: Record<string, string> = { active: "En marcha", paused: "En pausa", completed: "Terminada", stopped: "Parada", failed: "Con error" };
const KIND: Record<string, string> = { email: "Correo automático", manual_email: "Correo manual" };
const DAYS: [number, string][] = [[1, "L"], [2, "M"], [3, "X"], [4, "J"], [5, "V"], [6, "S"], [7, "D"]];

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");

function StatsTable({ step, stats }: { step: SequenceStep; stats: VariantStats[] }) {
  const rows = stats.filter((s) => s.step_id === step.id);
  if (!rows.length) return <p className="meta" style={{ margin: "6px 0 0" }}>Aún no ha salido ningún correo de este paso.</p>;
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

export default async function SequencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const user = await requireUser();
  const seq = await getSequence(id);
  if (!seq) notFound();
  const [enrollments, types, stats, templates, ai, personFields, orgFields, dealFields] = await Promise.all([
    listEnrollments({ sequenceId: id }), activeActivityTypes(), sequenceStats(id), listTemplates(user.id), getAiSettings(),
    listFieldDefinitions("person"), listFieldDefinitions("organization"), listFieldDefinitions("deal"),
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
  const paused = enrollments.filter((e) => e.status === "paused").length;
  let hours = 0;
  return (
    <main className="page">
      <div className="crumbs"><Link href="/sequences">Secuencias</Link></div>
      <div className="page-head">
        <div>
          <h1>{seq.name}</h1>
          {seq.description && <p className="muted" style={{ margin: 0 }}>{seq.description}</p>}
        </div>
        <Link className="btn secondary" href="/sequences/tasks">Correos manuales por enviar</Link>
      </div>
      {paused > 0 && (
        <p className="ee-warn" role="alert">
          {paused === 1 ? "Un contacto está en pausa" : `${paused} contactos están en pausa`} porque a su correo le faltan datos. Complétalos (o pon un valor por defecto a la variable) y pulsa «Reanudar» abajo.
        </p>
      )}

      <div className="grid-2">
        <section className="panel">
          <h2>Ajustes</h2>
          <ActionForm action={updateSequenceAction.bind(null, id)} submitLabel="Guardar" secondary>
            <label className="field"><span className="label">Nombre *</span><input name="name" required maxLength={120} defaultValue={seq.name} /></label>
            <label className="field"><span className="label">Para qué es</span><input name="description" maxLength={1000} defaultValue={seq.description ?? ""} /></label>
            <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={seq.is_active} />Activa (si no, no se envía nada)</label>
            <label className="checkbox"><input type="checkbox" name="stop_on_reply" defaultChecked={seq.stop_on_reply} />Parar si el contacto responde</label>
            <label className="checkbox"><input type="checkbox" name="stop_on_meeting" defaultChecked={seq.stop_on_meeting} />Parar si se agenda una reunión con él</label>
          </ActionForm>
        </section>
        <section className="panel" aria-label="Envío">
          <h2>Envío</h2>
          <ActionForm action={updateSequenceSendingAction.bind(null, id)} submitLabel="Guardar envío" secondary>
            <div className="field"><span className="label">Días</span>
              <div className="ee-days">
                {DAYS.map(([n, l]) => (
                  <label key={n} className="ee-day"><input type="checkbox" name="send_days" value={n} defaultChecked={seq.send_days.includes(n)} aria-label={`Enviar el día ${l}`} /><span>{l}</span></label>
                ))}
              </div>
            </div>
            <div className="ee-row">
              <label className="field"><span className="label">Desde</span>
                <select name="send_from" defaultValue={seq.send_from}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00</option>)}</select>
              </label>
              <label className="field"><span className="label">Hasta</span>
                <select name="send_to" defaultValue={seq.send_to}>{Array.from({ length: 24 }, (_, h) => <option key={h + 1} value={h + 1}>{h + 1}:00</option>)}</select>
              </label>
            </div>
            <label className="checkbox"><input type="checkbox" name="track" defaultChecked={seq.track} />Seguir aperturas y clics</label>
            <label className="checkbox"><input type="checkbox" name="add_signature" defaultChecked={seq.add_signature} />Añadir mi firma (se edita en <Link href="/account">Mi cuenta</Link>)</label>
            <label className="checkbox"><input type="checkbox" name="unsubscribe_link" defaultChecked={seq.unsubscribe_link} />Añadir enlace de baja (siempre en campañas de outbound)</label>
          </ActionForm>
        </section>
      </div>

      <h2 className="section-title" style={{ marginTop: 22 }}>Pasos</h2>
      <ol className="seq-steps">
        {seq.steps.map((st, i) => {
          hours += st.delay_days * 24 + st.delay_hours;
          const day = Math.floor(hours / 24);
          const isEmail = st.kind !== "task";
          return (
            <li key={st.id} className="panel seq-step" aria-label={`Paso ${st.position}`}>
              <div className="rule-head">
                <div>
                  <p className="meta" style={{ margin: 0 }}>
                    Paso {st.position} · día {day}{hours % 24 ? ` + ${hours % 24} h` : ""} · {KIND[st.kind] ?? activityLabel(st.task_type ?? "task")}
                    {st.format === "html" && isEmail ? " · con formato" : ""}{st.thread_reply ? " · en el mismo hilo" : ""}
                    {st.variants.length > 0 && ` · prueba A/B (${1 + st.variants.filter((v) => v.is_active).length} variantes activas)`}
                  </p>
                  <h3 style={{ margin: "2px 0 0" }}>{st.subject || (st.thread_reply ? "Re: (asunto anterior)" : "(sin asunto)")}</h3>
                </div>
                <div className="ee-row">
                  {i > 0 && <form action={moveStepAction.bind(null, id, st.id, -1)}><button type="submit" className="btn secondary small" aria-label={`Subir el paso ${st.position}`}>↑</button></form>}
                  {i < seq.steps.length - 1 && <form action={moveStepAction.bind(null, id, st.id, 1)}><button type="submit" className="btn secondary small" aria-label={`Bajar el paso ${st.position}`}>↓</button></form>}
                  <form action={deleteStepAction.bind(null, id, st.id)}>
                    <ConfirmButton label="Quitar" ariaLabel={`Quitar el paso ${st.position}`} confirm="Se quita el paso; los contactos en curso pasan al siguiente." />
                  </form>
                </div>
              </div>
              {isEmail && <StatsTable step={st} stats={stats} />}
              <details>
                <summary className="meta">Editar{isEmail && st.variants.length ? " (variante A)" : ""}</summary>
                <ActionForm action={saveStepAction.bind(null, id, st.id)} submitLabel="Guardar paso" secondary>
                  <StepForm step={st} first={i === 0} types={typeOptions} label={`paso ${st.position}`} {...editor} />
                </ActionForm>
              </details>
              {isEmail && st.variants.map((v) => (
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
              {isEmail && (
                <details className="ee-variant">
                  <summary className="meta">+ Prueba A/B: añadir una variante</summary>
                  <p className="meta">Cada contacto recibe una de las variantes activas, a partes iguales. Cambia el asunto o el texto y compara aperturas y respuestas.</p>
                  <ActionForm action={saveVariantAction.bind(null, id, st.id, null)} submitLabel="Añadir variante" secondary>
                    <EmailEditor initialSubject={st.subject} initialBody={st.body} initialFormat={st.format} formatLocked
                                 threadReply={st.thread_reply} firstStep={i === 0} label={`paso ${st.position} nueva variante`} {...editor} />
                  </ActionForm>
                </details>
              )}
            </li>
          );
        })}
      </ol>
      <section className="panel" aria-label="Añadir un paso">
        <h2>Añadir un paso</h2>
        <ActionForm action={saveStepAction.bind(null, id, null)} submitLabel="Añadir paso" resetOnSuccess>
          <StepForm first={seq.steps.length === 0} types={typeOptions} label="nuevo paso" {...editor} />
        </ActionForm>
      </section>

      <h2 className="section-title" style={{ marginTop: 22 }}>Contactos <span className="muted">{enrollments.length}</span></h2>
      {enrollments.length === 0 ? <p className="muted">Nadie todavía. Añade contactos desde la ficha de un deal o en bloque desde la lista de deals.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Contacto</th><th>Deal</th><th>Estado</th><th>Progreso</th><th>Siguiente paso</th><th /></tr></thead>
            <tbody>
              {enrollments.map((e) => (
                <tr key={e.id}>
                  <td><Link href={`/persons/${e.person_id}`}>{e.person_name}</Link></td>
                  <td>{e.deal_id ? <Link href={`/deals/${e.deal_id}`}>{e.deal_title}</Link> : "—"}</td>
                  <td><span className={`badge ${e.status === "active" ? "open" : e.status === "failed" || e.status === "paused" ? "lost" : ""}`}>{STATUS[e.status]}</span>
                    {e.stopped_reason && <div className="meta">{e.stopped_reason}</div>}
                    {e.error && <div className="meta tone-bad">{e.error}</div>}</td>
                  <td>{Math.min(e.next_step, e.steps)} de {e.steps}</td>
                  <td>{e.status === "active" && e.waiting_activity_id ? <Link href="/sequences/tasks">Correo manual por enviar</Link>
                    : e.status === "active" && e.next_run_at ? dateTime(e.next_run_at) : "—"}</td>
                  <td className="ee-row">
                    {e.status === "paused" && (
                      <form action={resumeEnrollmentAction.bind(null, e.id, `/sequences/${id}`)}><button type="submit" className="btn secondary small">Reanudar</button></form>
                    )}
                    {(e.status === "active" || e.status === "paused") && (
                      <form action={stopEnrollmentAction.bind(null, e.id, `/sequences/${id}`)}><button type="submit" className="btn secondary small">Parar</button></form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="panel" style={{ marginTop: 22 }}>
        <h2>Borrar la secuencia</h2>
        <ActionForm action={deleteSequenceAction.bind(null, id)} submitLabel="Borrar secuencia" secondary className="form inline"
                    confirm="Se para la secuencia para todos los contactos en curso y se borra. No se puede deshacer." />
      </section>
    </main>
  );
}
