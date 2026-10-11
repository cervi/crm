import Link from "next/link";
import { newSequenceAction } from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { aiReady, getAiSettings } from "@/lib/ai";
import { requireUser } from "@/lib/auth";
import { listSequencesFull, sequenceFolders } from "@/lib/sequence-reports";
import { queueCounts } from "@/lib/sequence-tasks";
import { SEQUENCE_TEMPLATES } from "@/lib/sequence-templates";

export const dynamic = "force-dynamic";
export const metadata = { title: "Secuencias" };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");
const CHANNEL_ICON = { email: "mail", call: "phone", linkedin: "users", task: "check" } as const;

export default async function SequencesPage({ searchParams }: { searchParams: Promise<{ ver?: string; carpeta?: string; q?: string; nueva?: string }> }) {
  const [user, sp] = await Promise.all([requireUser(), searchParams]);
  const view = sp.ver === "archivadas" ? "archivadas" : sp.ver === "pausadas" ? "pausadas" : sp.ver === "activas" ? "activas" : "todas";
  const [rows, folders, ai, tasks] = await Promise.all([
    listSequencesFull({ archived: view === "archivadas", folder: sp.carpeta || null, q: sp.q, status: view === "activas" ? "active" : view === "pausadas" ? "paused" : null }),
    sequenceFolders(), getAiSettings(), queueCounts(user.id, false),
  ]);
  const qs = (p: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ver: view === "todas" ? undefined : view, carpeta: sp.carpeta, q: sp.q, ...p })) if (v) u.set(k, v);
    return u.toString() ? `/sequences?${u}` : "/sequences";
  };
  const canEdit = user.role !== "viewer";

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Secuencias</h1>
          <p className="muted" style={{ margin: 0 }}>Correos, llamadas y LinkedIn en el orden y el ritmo que marques. Se paran solas cuando el contacto responde.</p>
        </div>
        <div className="head-actions">
          <Link className="btn secondary" href="/sequences/tasks"><Icon name="check" />Tareas{tasks.todas ? <span className="count" style={{ marginLeft: 6 }}>{tasks.todas}</span> : null}</Link>
          <Link className="btn secondary" href="/sequences/analitica"><Icon name="dashboards" />Analítica</Link>
          {canEdit && (
            <Drawer label={<><Icon name="plus" />Nueva secuencia</>} buttonClass="btn" title="Nueva secuencia" defaultOpen={sp.nueva === "1"}
                    subtitle="Empieza con una plantilla probada, pídesela a la IA o créala desde cero.">
              <ActionForm action={newSequenceAction} submitLabel="Crear secuencia" pendingLabel="Creando…">
                <div className="field"><span className="label">Cómo empezar</span>
                  <div className="template-cards">
                    <label><input type="radio" name="how" value="blank" defaultChecked /><strong>En blanco</strong><span className="meta">Añades tú los pasos.</span></label>
                    {SEQUENCE_TEMPLATES.map((t) => (
                      <label key={t.key}><input type="radio" name="how" value={`tpl:${t.key}`} /><strong>{t.name}</strong><span className="meta">{t.description}</span></label>
                    ))}
                    {aiReady(ai) && <label><input type="radio" name="how" value="ai" /><strong>Con IA</strong><span className="meta">Cuéntale qué quieres conseguir y te propone los pasos.</span></label>}
                  </div>
                </div>
                <label className="field"><span className="label">Nombre</span><input name="name" maxLength={120} placeholder="Si lo dejas vacío, el de la plantilla" /></label>
                <label className="field"><span className="label">Carpeta (opcional)</span><input name="folder" maxLength={60} list="seq-folders" placeholder="Outbound, Inbound, Clientes…" />
                  <datalist id="seq-folders">{folders.map((f) => <option key={f.folder} value={f.folder} />)}</datalist></label>
                {aiReady(ai) && (
                  <label className="field"><span className="label">Para la IA: a quién, qué vendes y qué quieres conseguir</span>
                    <textarea name="brief" rows={3} placeholder="Directores financieros de empresas de 50-500 empleados en España; vendemos software de cobros; queremos una reunión de 20 minutos." /></label>
                )}
                <p className="meta" style={{ margin: 0 }}>Se crea en pausa: revisa los pasos, añade contactos y actívala.</p>
              </ActionForm>
            </Drawer>
          )}
        </div>
      </div>

      <div className="filter-row">
        <nav className="chips" aria-label="Estado">
          {[["todas", "Todas"], ["activas", "Activas"], ["pausadas", "En pausa"], ["archivadas", "Archivadas"]].map(([k, l]) => (
            <Link key={k} href={qs({ ver: k === "todas" ? undefined : k })} aria-current={view === k ? "page" : undefined}>{l}</Link>
          ))}
        </nav>
        <form className="search-inline" role="search">
          {view !== "todas" && <input type="hidden" name="ver" value={view} />}
          {sp.carpeta && <input type="hidden" name="carpeta" value={sp.carpeta} />}
          <input name="q" defaultValue={sp.q} placeholder="Buscar secuencia" aria-label="Buscar secuencia" />
        </form>
      </div>
      {folders.length > 0 && (
        <nav className="chips" aria-label="Carpetas">
          <Link href={qs({ carpeta: undefined })} aria-current={!sp.carpeta ? "page" : undefined}><Icon name="folder" /> Todas las carpetas</Link>
          {folders.map((f) => <Link key={f.folder} href={qs({ carpeta: f.folder })} aria-current={sp.carpeta === f.folder ? "page" : undefined}>{f.folder} <span className="meta">{f.n}</span></Link>)}
        </nav>
      )}

      {rows.length === 0 ? (
        <div className="empty-state">
          <strong>{view === "archivadas" ? "No hay secuencias archivadas." : sp.q || sp.carpeta ? "Ninguna secuencia con ese filtro." : "Todavía no hay secuencias."}</strong>
          {view !== "archivadas" && !sp.q && <span className="meta">Empieza con una plantilla (prospección en frío, lead entrante, tras la demo…) y adáptala.</span>}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="seq-list">
            <thead>
              <tr><th>Secuencia</th><th className="num">Activos</th><th className="num">En pausa</th><th className="num">Terminados</th><th className="num">Rebotados</th>
                <th className="num">Entregados</th><th className="num">Abiertos</th><th className="num">Respondieron</th><th className="num">Interesados</th></tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link href={`/sequences/${s.id}`}><strong>{s.name}</strong></Link>
                    <span className="channels" aria-label={`Canales: ${s.channels.join(", ")}`}>{s.channels.map((c) => <Icon key={c} name={CHANNEL_ICON[c as keyof typeof CHANNEL_ICON] ?? "check"} />)}</span>
                    <div className="meta">
                      <span className={`badge ${s.archived_at ? "" : s.is_active ? "won" : "warn"}`}>{s.archived_at ? "Archivada" : s.is_active ? "Activa" : "En pausa"}</span>
                      {" "}{s.steps} paso{s.steps === 1 ? "" : "s"}{s.folder ? ` · ${s.folder}` : ""}{s.owner_name ? ` · ${s.owner_name}` : ""}
                    </div>
                  </td>
                  <td className="num">{s.active || "—"}</td>
                  <td className="num">{s.paused || "—"}</td>
                  <td className="num">{s.finished || "—"}</td>
                  <td className={`num${s.total >= 20 && s.bounced / s.total > 0.03 ? " tone-bad" : ""}`}>{s.bounced || "—"}</td>
                  <td className="num">{s.delivered || "—"}</td>
                  <td className="num">{pct(s.opened, s.delivered)}</td>
                  <td className="num">{pct(s.replied, s.delivered)}</td>
                  <td className="num">{pct(s.interested, s.delivered)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="meta">Los porcentajes son sobre los contactos a los que les llegó al menos un correo. <Link href="/sequences/horarios">Horarios de envío</Link></p>
    </main>
  );
}
