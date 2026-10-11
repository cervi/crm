import Link from "next/link";
import { completeTaskAction, sendManualAndNextAction } from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { EmailEditor } from "@/components/EmailEditor";
import { Icon } from "@/components/Icon";
import { aiReady, getAiSettings } from "@/lib/ai";
import { requireUser } from "@/lib/auth";
import { CALL_OUTCOMES } from "@/lib/contact-workspace";
import { dateTime } from "@/lib/format";
import { TASK_TABS, listQueue, type TaskTab } from "@/lib/sequence-tasks";
import { STEP_KINDS } from "@/lib/step-kinds";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hacer tareas" };

/** Modo «una tras otra» (como «Start tasks» en Apollo): la siguiente tarea con todo lo necesario a la vista. */
export default async function PlayTasksPage({ searchParams }: { searchParams: Promise<{ tipo?: string; todos?: string; secuencia?: string; tarea?: string }> }) {
  const [user, sp, ai] = await Promise.all([requireUser(), searchParams, getAiSettings()]);
  const all = sp.todos === "1";
  const tab = (TASK_TABS.find((t) => t.key === sp.tipo)?.key ?? "todas") as TaskTab;
  const sequenceId = isId(sp.secuencia ?? "") ? sp.secuencia! : null;
  const queue = await listQueue({ userId: user.id, all: all || Boolean(sequenceId), tab, when: sequenceId || sp.tarea ? "todas" : "hoy", sequenceId });
  const t = (sp.tarea && queue.find((x) => x.activity_id === sp.tarea)) || queue[0];
  const self = `/sequences/tasks/hacer?${new URLSearchParams({ ...(tab !== "todas" ? { tipo: tab } : {}), ...(all ? { todos: "1" } : {}), ...(sequenceId ? { secuencia: sequenceId } : {}) })}`;
  const exit = sequenceId ? `/sequences/${sequenceId}?tab=tareas` : "/sequences/tasks";

  if (!t) {
    return (
      <main className="page medium">
        <div className="crumbs"><Link href="/sequences/tasks">Tareas de secuencias</Link></div>
        <div className="empty-state"><strong>¡Hecho! No quedan tareas pendientes.</strong>
          <Link className="btn secondary" href={exit}>Volver</Link></div>
      </main>
    );
  }
  const k = STEP_KINDS[t.step_kind as keyof typeof STEP_KINDS] ?? STEP_KINDS.task;
  const position = queue.indexOf(t) + 1;
  return (
    <main className="page medium">
      <div className="crumbs"><Link href={exit}>Tareas de secuencias</Link></div>
      <div className="play-head">
        <h1 style={{ margin: 0 }}><span className={`step-chip ch-${k.channel}`}><Icon name={k.icon} />{k.label}</span></h1>
        <span className="meta">{position} de {queue.length} pendientes · <Link href={exit}>Salir</Link></span>
      </div>
      <section className="panel task-card">
        <div>
          <h2 style={{ margin: 0 }}><Link href={`/persons/${t.person_id}`}>{t.person_name}</Link></h2>
          <p className="meta" style={{ margin: 0 }}>{[t.job_title, t.organization].filter(Boolean).join(" · ")}
            {t.deal_id && <> · <Link href={`/deals/${t.deal_id}`}>{t.deal_title}</Link></>}</p>
        </div>
        <dl className="task-contact">
          <div><dt>Correo</dt><dd>{t.email ? <a href={`mailto:${t.email}`}>{t.email}</a> : "—"}</dd></div>
          <div><dt>Teléfono</dt><dd>{t.phone ? <a href={`tel:${t.phone.replace(/\s+/g, "")}`}>{t.phone}</a> : "—"}</dd></div>
          <div><dt>LinkedIn</dt><dd>{t.linkedin_url ? <a href={t.linkedin_url} target="_blank" rel="noreferrer">Abrir su perfil</a> : "—"}</dd></div>
          <div><dt>Secuencia</dt><dd><Link href={`/sequences/${t.sequence_id}`}>{t.sequence_name}</Link> <span className="meta">· paso {t.step} de {t.steps}</span></dd></div>
          <div><dt>Vence</dt><dd className={t.overdue ? "tone-bad" : undefined}>{t.due_at ? dateTime(t.due_at) : "—"}</dd></div>
        </dl>
        {t.step_kind !== "manual_email" && (
          <div>
            <h3 style={{ margin: "0 0 4px" }}>{t.subject}</h3>
            {t.note && <p style={{ whiteSpace: "pre-line", margin: 0 }}>{t.note}</p>}
          </div>
        )}

        {t.step_kind === "manual_email" ? (
          <ActionForm action={sendManualAndNextAction.bind(null, t.activity_id, self)} submitLabel={`Enviar a ${t.person_name} y seguir`} pendingLabel="Enviando…">
            <EmailEditor initialSubject={t.draft_subject ?? ""} initialBody={t.draft_html ?? ""} initialFormat="html" formatLocked aiReady={aiReady(ai)}
                         contacts={[{ id: t.person_id, label: t.person_name }]} label={`correo a ${t.person_name}`} />
          </ActionForm>
        ) : (
          <ActionForm action={completeTaskAction.bind(null, t.activity_id, self)} submitLabel="Hecha, siguiente" pendingLabel="Guardando…">
            {t.step_kind === "call" && (
              <label className="field"><span className="label">Resultado de la llamada</span>
                <select name="outcome" required defaultValue="">
                  <option value="" disabled>Elige…</option>
                  {CALL_OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <span className="meta">Si contestó, termina su secuencia (ya estáis hablando).</span></label>
            )}
            <label className="field"><span className="label">Nota (opcional)</span><textarea name="note" rows={3} /></label>
          </ActionForm>
        )}
        <ActionForm action={completeTaskAction.bind(null, t.activity_id, self)} submitLabel="Saltar esta" secondary className="form inline">
          <input type="hidden" name="skip" value="1" />
        </ActionForm>
      </section>
    </main>
  );
}
