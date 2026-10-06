import { ActionForm } from "./ActionForm";
import {
  completeActivityAction, createActivityAction, reopenActivityAction,
} from "@/app/actions/records";
import type { Activity } from "@/lib/activities";
import { OUTCOMES, activityLabel, dateTime, outcomeLabel } from "@/lib/format";
import { activeActivityTypes } from "@/lib/activity-types";

type Ref = { deal_id?: string; lead_id?: string; person_id?: string; organization_id?: string };

/** Actividades de una ficha: alta, pendientes (con su cierre) y hechas. */
export async function ActivityPanel({ activities, refs, back, users }: {
  activities: Activity[];
  refs: Ref;
  back: string;
  users: { id: string; name: string }[];
}) {
  const types = await activeActivityTypes();
  const pending = activities.filter((a) => !a.done);
  const done = activities.filter((a) => a.done);
  return (
    <section className="panel stack">
      <h2>Actividades</h2>
      <details>
        <summary>+ Programar actividad</summary>
        <ActionForm action={createActivityAction.bind(null, back)} submitLabel="Programar" resetOnSuccess>
          {Object.entries(refs).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
          <div className="grid-2">
            <label className="field"><span className="label">Tipo</span>
              <select name="type" defaultValue={types.find((t) => t.key === "call")?.key ?? types[0]?.key}>
                {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
            <label className="field"><span className="label">Asunto</span><input name="subject" required /></label>
            <label className="field"><span className="label">Fecha y hora</span><input type="datetime-local" name="due_at" /></label>
            <label className="field"><span className="label">Duración (min)</span><input type="number" name="duration_minutes" min={1} /></label>
            <label className="field"><span className="label">Responsable</span>
              <select name="owner_id" defaultValue="">
                <option value="">—</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label className="field"><span className="label">Enlace de la reunión</span><input name="meeting_url" /></label>
            <label className="field span-2"><span className="label">Notas</span><textarea name="note" rows={2} /></label>
          </div>
        </ActionForm>
      </details>

      {pending.length === 0 && <p className="muted">No hay actividades pendientes.</p>}
      <ul className="items">
        {pending.map((a) => (
          <li key={a.id} className={a.is_overdue ? "item overdue" : "item"}>
            <ActivityHead a={a} />
            {a.note && <p className="note-body">{a.note}</p>}
            <details>
              <summary>Marcar como hecha</summary>
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

      {done.length > 0 && (
        <details>
          <summary>Hechas ({done.length})</summary>
          <ul className="items">
            {done.map((a) => (
              <li key={a.id} className="item done">
                <ActivityHead a={a} />
                {a.note && <p className="note-body">{a.note}</p>}
                <form action={reopenActivityAction.bind(null, a.id, back)}>
                  <button className="link" type="submit">Reabrir</button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ActivityHead({ a }: { a: Activity }) {
  return (
    <div className="item-head">
      <span className="badge">{activityLabel(a.type)}</span>
      <strong>{a.subject}</strong>
      {a.outcome && <span className={a.outcome === "no_show" ? "badge lost" : "badge won"}>{outcomeLabel(a.outcome)}</span>}
      {a.is_overdue && <span className="badge lost">Vencida</span>}
      <span className="spacer" />
      <span className="meta">{a.due_at ? dateTime(a.due_at) : "Sin fecha"}{a.owner_name && ` · ${a.owner_name}`}</span>
      {a.meeting_url && <a href={a.meeting_url} target="_blank" rel="noreferrer" className="meta">Enlace</a>}
    </div>
  );
}
