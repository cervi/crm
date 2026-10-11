import Link from "next/link";
import { completeTaskAction } from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { TASK_TABS, listQueue, queueCounts, type TaskTab } from "@/lib/sequence-tasks";
import { STEP_KINDS } from "@/lib/step-kinds";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tareas de secuencias" };

/** Cola de tareas de las secuencias (como «Tasks» en Apollo): llamadas, LinkedIn, tareas y correos manuales. */
export default async function SequenceTasksPage({ searchParams }: { searchParams: Promise<{ tipo?: string; cuando?: string; todos?: string }> }) {
  const [user, sp] = await Promise.all([requireUser(), searchParams]);
  const all = sp.todos === "1";
  const tab = (TASK_TABS.find((t) => t.key === sp.tipo)?.key ?? "todas") as TaskTab;
  const when = sp.cuando === "proximas" ? "proximas" : sp.cuando === "todas" ? "todas" : "hoy";
  const [tasks, counts] = await Promise.all([listQueue({ userId: user.id, all, tab, when }), queueCounts(user.id, all)]);
  const qs = (p: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ tipo: tab === "todas" ? undefined : tab, cuando: when === "hoy" ? undefined : when, todos: all ? "1" : undefined, ...p })) if (v) u.set(k, v);
    return u.toString() ? `/sequences/tasks?${u}` : "/sequences/tasks";
  };
  const playHref = `/sequences/tasks/hacer?${new URLSearchParams({ ...(tab !== "todas" ? { tipo: tab } : {}), ...(all ? { todos: "1" } : {}) })}`;
  const back = qs({});

  return (
    <main className="page">
      <div className="crumbs"><Link href="/sequences">Secuencias</Link></div>
      <div className="page-head">
        <div>
          <h1>Tareas de secuencias</h1>
          <p className="muted" style={{ margin: 0 }}>Lo que las secuencias esperan de ti hoy. Al hacerla (o saltarla), el contacto sigue con el paso siguiente.</p>
        </div>
        <div className="head-actions">
          <nav className="chips" aria-label="De quién">
            <Link href={qs({ todos: undefined })} aria-current={all ? undefined : "page"}>Mías</Link>
            <Link href={qs({ todos: "1" })} aria-current={all ? "page" : undefined}>De todo el equipo</Link>
          </nav>
          {tasks.length > 0 && <Link className="btn" href={playHref}><Icon name="send" />Empezar (una tras otra)</Link>}
        </div>
      </div>

      <nav className="tabs" aria-label="Tipo de tarea">
        {TASK_TABS.map((t) => (
          <Link key={t.key} href={qs({ tipo: t.key === "todas" ? undefined : t.key })} aria-current={tab === t.key ? "page" : undefined}>
            {t.label}{counts[t.key] ? <span className="count">{counts[t.key]}</span> : null}
          </Link>
        ))}
      </nav>
      <nav className="chips" aria-label="Cuándo">
        {[["hoy", "Vencidas y de hoy"], ["proximas", "Próximas"], ["todas", "Todas"]].map(([k, l]) => (
          <Link key={k} href={qs({ cuando: k === "hoy" ? undefined : k })} aria-current={when === k ? "page" : undefined}>{l}</Link>
        ))}
      </nav>

      {tasks.length === 0 ? (
        <div className="empty-state"><strong>{when === "hoy" ? "Nada pendiente para hoy." : "No hay tareas con este filtro."}</strong>
          <span className="meta">Las llamadas, pasos de LinkedIn y correos manuales de tus secuencias aparecerán aquí el día que toquen.</span></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Tarea</th><th>Contacto</th><th>Secuencia</th><th>Vence</th>{all && <th>Responsable</th>}<th><span className="sr-only">Acciones</span></th></tr></thead>
            <tbody>
              {tasks.map((t) => {
                const k = STEP_KINDS[t.step_kind as keyof typeof STEP_KINDS];
                return (
                  <tr key={t.activity_id}>
                    <td><span className={`step-chip ch-${k?.channel ?? "task"}`}><Icon name={k?.icon ?? "check"} />{k?.short ?? "Tarea"}</span>
                      {t.priority === "high" && <span className="badge warn" style={{ marginLeft: 6 }}>Alta</span>}
                      <div>{t.subject}</div></td>
                    <td><Link href={`/persons/${t.person_id}`}><strong>{t.person_name}</strong></Link>
                      <div className="meta">{[t.job_title, t.organization].filter(Boolean).join(" · ") || t.email || ""}</div></td>
                    <td><Link href={`/sequences/${t.sequence_id}?tab=tareas`}>{t.sequence_name}</Link><div className="meta">paso {t.step} de {t.steps}</div></td>
                    <td className={`nowrap${t.overdue ? " tone-bad" : ""}`}>{t.due_at ? dateTime(t.due_at) : "—"}{t.overdue && <div className="meta">vencida</div>}</td>
                    {all && <td className="meta">{t.owner_name ?? "—"}</td>}
                    <td className="row-actions">
                      <Link className="btn secondary small" href={`/sequences/tasks/hacer?tarea=${t.activity_id}${all ? "&todos=1" : ""}`}>Hacer</Link>
                      <ActionForm action={completeTaskAction.bind(null, t.activity_id, back)} submitLabel="Saltar" secondary className="form inline">
                        <input type="hidden" name="skip" value="1" />
                      </ActionForm>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
