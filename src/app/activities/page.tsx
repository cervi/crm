import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { ACTIVITY_PERIODS, listActivitiesBetween, listActivityBoard, type Activity, type ActivityPeriod } from "@/lib/activities";
import { zonedToUtc } from "@/lib/slots";
import { listUsers } from "@/lib/users";
import { activityLabel, dateTime, outcomeLabel } from "@/lib/format";
import { isId } from "@/lib/validation";
import { requireUser } from "@/lib/auth";
import { activityTypes } from "@/lib/activity-types";
import { Icon, type IconName } from "@/components/Icon";
import { DataTable } from "@/components/DataTable";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { QuickDone } from "@/components/activities/QuickDone";
import { ActivityHover } from "@/components/activities/ActivityHover";
import { ActivityBulkBar } from "@/components/activities/ActivityBulkBar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Actividades" };

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

/** Icono según el tipo (por su clave o su nombre). */
function typeIcon(key: string, label: string): IconName {
  const t = `${key} ${label}`.toLowerCase();
  if (/call|llamad|phone|tel/.test(t)) return "phone";
  if (/mail|correo/.test(t)) return "mail";
  if (/meet|reuni|demo|video|session|sesi|diagnos|intro/.test(t)) return "video";
  if (/deadline|plazo|vencim/.test(t)) return "flag";
  if (/lunch|comida|almuerzo|caf/.test(t)) return "users";
  return "check";
}

const dayFmt = () => new Intl.DateTimeFormat("es-ES", { timeZone: TZ(), weekday: "short", day: "numeric", month: "short" });
const hourFmt = () => new Intl.DateTimeFormat("es-ES", { timeZone: TZ(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** «Hoy 10:00», «Mañana», «hace 3 días», «lun 13 oct»… */
function when(a: Activity): { text: string; overdue: string | null } {
  if (!a.due_at) return { text: "Sin fecha", overdue: null };
  const d = new Date(a.due_at);
  const k = ymd(d), today = ymd(new Date());
  const tomorrow = ymd(new Date(Date.now() + 86_400_000));
  const h = hourFmt().format(d);
  const hasTime = h !== "00:00" && h !== "23:59";
  const days = Math.floor((Date.parse(today) - Date.parse(k)) / 86_400_000);
  if (k === today) return { text: `Hoy${hasTime ? ` ${h}` : ""}`, overdue: a.is_overdue ? "Vence hoy y la hora ya ha pasado." : null };
  if (k === tomorrow) return { text: `Mañana${hasTime ? ` ${h}` : ""}`, overdue: null };
  const text = `${dayFmt().format(d)}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ""}${hasTime ? ` ${h}` : ""}`;
  return { text, overdue: !a.done && days > 0 ? `Vencida hace ${days} día${days === 1 ? "" : "s"}.` : null };
}

export default async function ActivitiesPage({ searchParams }: { searchParams: Promise<{ view?: string; owner?: string; week?: string; period?: string; type?: string }> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const calendar = sp.view === "week";
  const period = (ACTIVITY_PERIODS.some((p) => p.key === sp.period) ? sp.period : sp.view === "done" ? "done" : "todo") as ActivityPeriod;
  // Por defecto, las mías (como en Pipedrive); «all» para ver las de todo el equipo.
  let owner = sp.owner === "all" ? null : isId(sp.owner) ? sp.owner : me.id;
  const type = sp.type && /^[a-z0-9_]{1,40}$/.test(sp.type) ? sp.type : null;
  let [board, users, types] = await Promise.all([
    calendar ? null : listActivityBoard({ period, ownerId: owner, type }),
    listUsers(), activityTypes(),
  ]);
  // Si no tengo nada pendiente (p. ej. el administrador), enseño las del equipo.
  let showingTeam = false;
  if (!sp.owner && me.role === "admin" && board && board.counts.todo === 0 && board.items.length === 0) {
    owner = null; showingTeam = true;
    board = await listActivityBoard({ period, ownerId: null, type });
  }
  const link = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const cur: Record<string, string | null> = { view: calendar ? "week" : null, period: period === "todo" ? null : period, type, owner: sp.owner ?? null, week: sp.week ?? null };
    for (const [k, v] of Object.entries({ ...cur, ...patch })) if (v) next.set(k, v);
    return `/activities${next.size ? `?${next}` : ""}`;
  };
  const label = (k: string) => types.find((t) => t.key === k)?.label ?? activityLabel(k);
  const total = board?.types.reduce((n, t) => n + t.n, 0) ?? 0;

  return (
    <main className="page activities-page">
      <div className="page-head">
        <h1>Actividades</h1>
        <div className="segmented" role="group" aria-label="Vista">
          <Link href={link({ view: null, week: null })} aria-pressed={!calendar} title="Lista" aria-label="Vista de lista"><Icon name="list" /></Link>
          <Link href={link({ view: "week" })} aria-pressed={calendar} title="Semana" aria-label="Vista semanal"><Icon name="activities" /></Link>
        </div>
        <span className="spacer" />
        {!calendar && <span className="board-count"><strong>{board!.items.length}</strong> actividad{board!.items.length === 1 ? "" : "es"}</span>}
        <form className="owner-pick">
          {calendar && <input type="hidden" name="view" value="week" />}
          {period !== "todo" && <input type="hidden" name="period" value={period} />}
          {type && <input type="hidden" name="type" value={type} />}
          <AutoSubmitSelect name="owner" defaultValue={owner ?? "all"} aria-label="Responsable">
            <option value={me.id}>Mis actividades</option>
            <option value="all">Todo el equipo</option>
            {users.filter((u) => u.id !== me.id && u.kind === "human").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </AutoSubmitSelect>
          <noscript><button className="btn secondary">Ver</button></noscript>
        </form>
        {!calendar && <ExportLink dataset="activities" params={{ view: period === "done" ? "done" : "pending", owner }} />}
      </div>

      {calendar ? <WeekView week={sp.week} owner={owner} /> : (
        <>
          <div className="act-filters">
            <nav className="act-types" aria-label="Tipo">
              <Link href={link({ type: null })} aria-current={!type ? "page" : undefined}>Todos <span>{total}</span></Link>
              {board!.types.map((t) => (
                <Link key={t.type} href={link({ type: t.type })} aria-current={type === t.type ? "page" : undefined} title={label(t.type)}>
                  <Icon name={typeIcon(t.type, label(t.type))} />{label(t.type)} <span>{t.n}</span>
                </Link>
              ))}
            </nav>
            <nav className="act-periods" aria-label="Periodo">
              {ACTIVITY_PERIODS.map((p) => {
                const n = p.key === "done" ? null : board!.counts[p.key];
                return (
                  <Link key={p.key} href={link({ period: p.key === "todo" ? null : p.key })} aria-current={period === p.key ? "page" : undefined}
                        title={p.hint} className={p.key === "overdue" && n ? "has-overdue" : undefined}>
                    {p.label}{n !== null && n > 0 && <span>{n}</span>}
                  </Link>
                );
              })}
            </nav>
          </div>

          {showingTeam && <p className="callout" style={{ margin: "0 0 12px" }}>No tienes nada pendiente: te enseñamos las del equipo.</p>}
          <ActivityBulkBar />
          <DataTable id="activities" selectable
            empty={period === "done" ? "Todavía no hay actividades hechas." : "Nada pendiente aquí. 🎉"}
            columns={[
              { key: "done", label: "Hecha", required: true, pinned: true, className: "done-col" },
              { key: "subject", label: "Asunto", required: true, pinned: true },
              { key: "deal", label: "Deal" },
              { key: "person", label: "Contacto" },
              { key: "org", label: "Empresa" },
              { key: "due", label: period === "done" ? "Hecha el" : "Vence", className: "nowrap" },
              { key: "duration", label: "Duración", hidden: true },
              { key: "outcome", label: "Resultado", hidden: period !== "done" },
              { key: "type", label: "Tipo", hidden: true },
              { key: "owner", label: "Responsable", hidden: !!owner, className: "nowrap" },
            ]}
            rows={board!.items.map((a) => {
              const w = when(a);
              const icon = typeIcon(a.type, label(a.type));
              const href = a.deal_id ? `/deals/${a.deal_id}` : a.person_id ? `/persons/${a.person_id}` : a.organization_id ? `/organizations/${a.organization_id}` : null;
              return {
                id: a.id, label: a.subject, className: [a.is_overdue && "act-overdue", a.done && "act-done"].filter(Boolean).join(" ") || undefined,
                cells: {
                  done: <QuickDone id={a.id} done={a.done} subject={a.subject} />,
                  subject: (
                    <ActivityHover href={href} card={{
                      type: label(a.type), when: a.due_at ? dateTime(a.due_at) : "Sin fecha",
                      duration: a.duration_minutes ? `${a.duration_minutes} min` : null,
                      note: a.note ?? a.summary, meeting: a.meeting_url,
                      who: [a.person_name, a.organization_name].filter(Boolean).join(" · ") || null,
                      owner: a.owner_name, prep: !!a.prep, overdue: w.overdue,
                      outcome: a.outcome ? outcomeLabel(a.outcome) : null,
                    }}>
                      <Icon name={icon} /><span>{a.subject}</span>{(a.note || a.summary) && <span className="act-has-note" aria-hidden="true" />}
                    </ActivityHover>
                  ),
                  deal: a.deal_id ? <Link href={`/deals/${a.deal_id}`}>{a.deal_title}</Link> : null,
                  person: a.person_id ? <Link href={`/persons/${a.person_id}`}>{a.person_name}</Link> : null,
                  org: a.organization_id ? <Link href={`/organizations/${a.organization_id}`}>{a.organization_name}</Link> : null,
                  due: period === "done"
                    ? (a.done_at ? dateTime(a.done_at) : null)
                    : <span className={w.overdue ? "tone-bad" : undefined} title={a.due_at ? dateTime(a.due_at) : undefined}>{w.text}{w.overdue && <span className="overdue-tag"> · vencida</span>}</span>,
                  duration: a.duration_minutes ? `${a.duration_minutes} min` : null,
                  outcome: a.outcome ? <span className={a.outcome === "no_show" ? "badge lost" : "badge won"}>{outcomeLabel(a.outcome)}</span> : null,
                  type: label(a.type),
                  owner: a.owner_name,
                },
              };
            })} />
        </>
      )}
    </main>
  );
}
