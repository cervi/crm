import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { listActivities, listActivitiesBetween, type Activity } from "@/lib/activities";
import { zonedToUtc } from "@/lib/slots";
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

const TZ = () => process.env.TZ || "Europe/Madrid";
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** Lunes de la semana de una fecha «AAAA-MM-DD» (en la zona de la app). */
function mondayOf(day: string): { y: number; m: number; d: number } {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

async function WeekView({ week, owner }: { week: string | undefined; owner: string | null }) {
  const base = mondayOf(week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? week : ymd(new Date()));
  const days = Array.from({ length: 7 }, (_, i) => {
    const t = new Date(Date.UTC(base.y, base.m - 1, base.d + i));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  });
  const start = zonedToUtc(base.y, base.m, base.d, 0, 0, TZ());
  const last = days[6];
  const end = zonedToUtc(last.y, last.m, last.d + 1, 0, 0, TZ());
  const items = await listActivitiesBetween(start, end, owner);
  const key = (p: { y: number; m: number; d: number }) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  const shift = (n: number) => { const t = new Date(Date.UTC(base.y, base.m - 1, base.d + n)); return t.toISOString().slice(0, 10); };
  const link = (w: string) => `/activities?view=week&week=${w}${owner ? `&owner=${owner}` : ""}`;
  const today = ymd(new Date());
  const hour = new Intl.DateTimeFormat("es-ES", { timeZone: TZ(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const label = new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  return (
    <>
      <div className="week-nav">
        <Link href={link(shift(-7))} className="btn secondary small">← Semana anterior</Link>
        <Link href={link(ymd(new Date()))} className="btn secondary small">Esta semana</Link>
        <Link href={link(shift(7))} className="btn secondary small">Semana siguiente →</Link>
        <span className="meta">{items.length} actividad{items.length === 1 ? "" : "es"}</span>
      </div>
      <div className="week-grid">
        {days.map((p) => {
          const k = key(p);
          const list = items.filter((a) => a.due_at && ymd(new Date(a.due_at)) === k);
          return (
            <section key={k} className={k === today ? "week-day today" : "week-day"} aria-label={k}>
              <h3>{label.format(new Date(Date.UTC(p.y, p.m - 1, p.d)))}</h3>
              {list.length === 0 && <p className="meta">—</p>}
              {list.map((a) => (
                <Link key={a.id} href={a.deal_id ? `/deals/${a.deal_id}` : a.person_id ? `/persons/${a.person_id}` : "/activities"}
                      className={`week-item${a.done ? " done" : ""}${a.is_overdue ? " overdue" : ""}`}>
                  <span className="meta">{hour.format(new Date(a.due_at!))} · {activityLabel(a.type)}</span>
                  <strong>{a.subject}</strong>
                  {a.deal_title && <span className="meta">{a.deal_title}</span>}
                </Link>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}

export default async function ActivitiesPage({ searchParams }: { searchParams: Promise<{ view?: string; owner?: string; week?: string }> }) {
  const sp = await searchParams;
  const view = sp.view === "done" ? "done" : sp.view === "week" ? "week" : "pending";
  const owner = isId(sp.owner) ? sp.owner : null;
  const [items, users] = await Promise.all([view === "week" ? Promise.resolve([]) : listActivities({ view, ownerId: owner }), listUsers()]);
  const qs = (v: string) => `/activities?view=${v}${owner ? `&owner=${owner}` : ""}`;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Actividades</h1>
        <span className="spacer" />
        {view !== "week" && <ExportLink dataset="activities" params={{ view, owner }} />}
      </div>
      <nav className="tabs">
        <Link href={qs("pending")} aria-current={view === "pending" ? "page" : undefined}>Pendientes</Link>
        <Link href={qs("done")} aria-current={view === "done" ? "page" : undefined}>Hechas</Link>
        <Link href={qs("week")} aria-current={view === "week" ? "page" : undefined}>Semana</Link>
      </nav>
      <form className="toolbar">
        <input type="hidden" name="view" value={view} />
        <select name="owner" defaultValue={owner ?? ""} aria-label="Responsable">
          <option value="">Todos los responsables</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button className="btn secondary">Filtrar</button>
      </form>

      {view === "week" && <WeekView week={sp.week} owner={owner} />}
      {view !== "week" && items.length === 0 && <p className="muted">No hay actividades {view === "done" ? "hechas" : "pendientes"}.</p>}
      {view !== "week" && (view === "pending" ? groups(items) : [{ title: "", items }]).map((g) => (
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
