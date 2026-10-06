import Link from "next/link";
import { notFound } from "next/navigation";
import {
  deleteSequenceAction, deleteStepAction, saveStepAction, stopEnrollmentAction, updateSequenceAction,
} from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { activeActivityTypes } from "@/lib/activity-types";
import { activityLabel, dateTime } from "@/lib/format";
import { getSequence, listEnrollments, type SequenceStep } from "@/lib/sequences";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Secuencia" };

const STATUS: Record<string, string> = { active: "En marcha", completed: "Terminada", stopped: "Parada", failed: "Con error" };

function StepFields({ step, types }: { step?: SequenceStep; types: { key: string; label: string }[] }) {
  return (
    <>
      <div className="grid-3">
        <label className="field"><span className="label">Tipo de paso</span>
          <select name="kind" defaultValue={step?.kind ?? "email"}>
            <option value="email">Correo</option>
            <option value="task">Tarea para el responsable</option>
          </select>
        </label>
        <label className="field"><span className="label">{step?.position === 1 || !step ? "Días tras añadirlo" : "Días tras el paso anterior"}</span>
          <input name="delay_days" type="number" min={0} max={90} required defaultValue={step?.delay_days ?? 3} />
        </label>
        <label className="field"><span className="label">Si es tarea, de tipo</span>
          <select name="task_type" defaultValue={step?.task_type ?? "task"}>
            {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
      </div>
      <label className="field"><span className="label">Asunto</span><input name="subject" required maxLength={300} defaultValue={step?.subject} /></label>
      <label className="field"><span className="label">Texto (en una tarea, la descripción)</span>
        <textarea name="body" rows={6} defaultValue={step?.body ?? "Hola {nombre},\n\n\n\nUn saludo,\n{responsable}"} /></label>
    </>
  );
}

export default async function SequencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const seq = await getSequence(id);
  if (!seq) notFound();
  const [enrollments, types] = await Promise.all([listEnrollments({ sequenceId: id }), activeActivityTypes()]);
  const typeOptions = types.map((t) => ({ key: t.key, label: t.label }));
  let day = 0;
  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="crumbs"><Link href="/sequences">Secuencias</Link></div>
      <div className="page-head">
        <div>
          <h1>{seq.name}</h1>
          {seq.description && <p className="muted" style={{ margin: 0 }}>{seq.description}</p>}
        </div>
      </div>

      <section className="panel">
        <h2>Ajustes</h2>
        <ActionForm action={updateSequenceAction.bind(null, id)} submitLabel="Guardar" secondary>
          <div className="grid-2">
            <label className="field"><span className="label">Nombre</span><input name="name" required maxLength={120} defaultValue={seq.name} /></label>
            <label className="field"><span className="label">Para qué es</span><input name="description" maxLength={1000} defaultValue={seq.description ?? ""} /></label>
          </div>
          <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={seq.is_active} />Activa (si no, no se envía nada)</label>
          <label className="checkbox"><input type="checkbox" name="stop_on_reply" defaultChecked={seq.stop_on_reply} />Parar si el contacto responde</label>
          <label className="checkbox"><input type="checkbox" name="stop_on_meeting" defaultChecked={seq.stop_on_meeting} />Parar si se agenda una reunión con él</label>
        </ActionForm>
      </section>

      <h2 className="section-title" style={{ marginTop: 22 }}>Pasos</h2>
      <ol className="seq-steps">
        {seq.steps.map((st) => {
          day += st.delay_days;
          return (
            <li key={st.id} className="panel seq-step" aria-label={`Paso ${st.position}`}>
              <div className="rule-head">
                <div>
                  <p className="meta" style={{ margin: 0 }}>Paso {st.position} · día {day} · {st.kind === "email" ? "Correo" : activityLabel(st.task_type ?? "task")}</p>
                  <h3 style={{ margin: "2px 0 0" }}>{st.subject}</h3>
                </div>
                <form action={deleteStepAction.bind(null, id, st.id)}>
                  <button type="submit" className="btn secondary small" aria-label={`Quitar el paso ${st.position}`}>Quitar</button>
                </form>
              </div>
              <details>
                <summary className="meta">Editar</summary>
                <ActionForm action={saveStepAction.bind(null, id, st.id)} submitLabel="Guardar paso" secondary>
                  <StepFields step={st} types={typeOptions} />
                </ActionForm>
              </details>
            </li>
          );
        })}
      </ol>
      <section className="panel">
        <h2>Añadir un paso</h2>
        <ActionForm action={saveStepAction.bind(null, id, null)} submitLabel="Añadir paso" resetOnSuccess>
          <StepFields types={typeOptions} />
          <p className="meta" style={{ margin: 0 }}>
            Puedes usar {"{nombre}"}, {"{empresa}"}, {"{deal}"}, {"{responsable}"}, {"{huecos}"} (huecos libres) y {"{enlace_reserva}"}.
          </p>
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
                  <td><span className={`badge ${e.status === "active" ? "open" : e.status === "failed" ? "lost" : ""}`}>{STATUS[e.status]}</span>
                    {e.stopped_reason && <div className="meta">{e.stopped_reason}</div>}
                    {e.error && <div className="meta tone-bad">{e.error}</div>}</td>
                  <td>{Math.min(e.next_step, e.steps)} de {e.steps}</td>
                  <td>{e.status === "active" && e.next_run_at ? dateTime(e.next_run_at) : "—"}</td>
                  <td>{e.status === "active" && (
                    <form action={stopEnrollmentAction.bind(null, e.id, `/sequences/${id}`)}><button type="submit" className="btn secondary small">Parar</button></form>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section className="panel" style={{ marginTop: 22 }}>
        <h2>Borrar la secuencia</h2>
        <ActionForm action={deleteSequenceAction.bind(null, id)} submitLabel="Borrar secuencia" danger className="form inline" />
      </section>
    </main>
  );
}
