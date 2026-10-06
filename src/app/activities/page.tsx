import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { listActivities, type Activity } from "@/lib/activities";
import { listUsers } from "@/lib/users";
import { activityLabel, dateTime, outcomeLabel } from "@/lib/format";
import { isId } from "@/lib/validation";
import { completeActivityAction } from "@/app/actions/records";
import { ActionForm } from "@/components/ActionForm";
import { OUTCOMES } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Actividades" };

function groups(items: Activity[]) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return [
    { title: "Vencidas", items: items.filter((a) => a.due_at && new Date(a.due_at) < start) },
    { title: "Hoy", items: items.filter((a) => a.due_at && new Date(a.due_at) >= start && new Date(a.due_at) < end) },
    { title: "Próximas", items: items.filter((a) => a.due_at && new Date(a.due_at) >= end) },
    { title: "Sin fecha", items: items.filter((a) => !a.due_at) },
  ].filter((g) => g.items.length > 0);
}

export default async function ActivitiesPage({ searchParams }: { searchParams: Promise<{ view?: string; owner?: string }> }) {
  const sp = await searchParams;
  const view = sp.view === "done" ? "done" : "pending";
  const owner = isId(sp.owner) ? sp.owner : null;
  const [items, users] = await Promise.all([listActivities({ view, ownerId: owner }), listUsers()]);
  const qs = (v: string) => `/activities?view=${v}${owner ? `&owner=${owner}` : ""}`;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Actividades</h1>
        <span className="spacer" />
        <ExportLink dataset="activities" params={{ view, owner }} />
      </div>
      <nav className="tabs">
        <Link href={qs("pending")} aria-current={view === "pending" ? "page" : undefined}>Pendientes</Link>
        <Link href={qs("done")} aria-current={view === "done" ? "page" : undefined}>Hechas</Link>
      </nav>
      <form className="toolbar">
        <input type="hidden" name="view" value={view} />
        <select name="owner" defaultValue={owner ?? ""} aria-label="Responsable">
          <option value="">Todos los responsables</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button className="btn secondary">Filtrar</button>
      </form>

      {items.length === 0 && <p className="muted">No hay actividades {view === "done" ? "hechas" : "pendientes"}.</p>}
      {(view === "pending" ? groups(items) : [{ title: "", items }]).map((g) => (
        <section key={g.title} className="stack" style={{ marginBottom: 20 }}>
          {g.title && <h3>{g.title} ({g.items.length})</h3>}
          <ul className="items">
            {g.items.map((a) => (
              <li key={a.id} className={a.is_overdue ? "item overdue" : a.done ? "item done" : "item"}>
                <div className="item-head">
                  <span className="badge">{activityLabel(a.type)}</span>
                  <strong>{a.subject}</strong>
                  {a.outcome && <span className={a.outcome === "no_show" ? "badge lost" : "badge won"}>{outcomeLabel(a.outcome)}</span>}
                  <span className="spacer" />
                  <span className="meta">{a.done ? `Hecha ${dateTime(a.done_at)}` : a.due_at ? dateTime(a.due_at) : "Sin fecha"}{a.owner_name && ` · ${a.owner_name}`}</span>
                </div>
                <div className="meta">
                  {a.deal_id && <Link href={`/deals/${a.deal_id}`}>{a.deal_title}</Link>}
                  {a.person_id && <> · <Link href={`/persons/${a.person_id}`}>{a.person_name}</Link></>}
                  {a.organization_id && <> · <Link href={`/organizations/${a.organization_id}`}>{a.organization_name}</Link></>}
                  {a.lead_id && <> · <Link href={`/leads/${a.lead_id}`}>Lead</Link></>}
                </div>
                {a.note && <p className="note-body">{a.note}</p>}
                {!a.done && (
                  <details>
                    <summary>Marcar como hecha</summary>
                    <ActionForm action={completeActivityAction.bind(null, a.id, "/activities")} submitLabel="Guardar" className="form inline">
                      <label className="field"><span className="label">Resultado</span>
                        <select name="outcome" defaultValue="">
                          <option value="">—</option>
                          {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </label>
                      <label className="field" style={{ flex: 1 }}><span className="label">Comentario</span><input name="note" /></label>
                    </ActionForm>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
