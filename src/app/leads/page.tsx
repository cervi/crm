import Link from "next/link";
import { leadSources, listLeads } from "@/lib/leads";
import { date, FUNNEL_STAGES, STATUS_LABELS } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leads" };

export default async function LeadsPage({ searchParams }: {
  searchParams: Promise<{ q?: string; status?: string; source?: string; funnel?: string }>;
}) {
  const sp = await searchParams;
  const status = ["open", "converted", "archived", "all"].includes(sp.status ?? "") ? sp.status! : "open";
  const [rows, sources] = await Promise.all([
    listLeads({ q: sp.q, status, source: sp.source, funnel: sp.funnel }), leadSources(),
  ]);
  const byFunnel = (f: string) => rows.filter((r) => r.funnel_stage === f).length;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Leads</h1>
        <span className="muted">
          {rows.length} · {FUNNEL_STAGES.map((f) => `${f.label} ${byFunnel(f.value)}`).join(" · ")}
        </span>
        <span className="spacer" />
        <Link href="/settings/api" className="btn secondary">Conectar formularios</Link>
        <Link href="/leads/new" className="btn">Nuevo lead</Link>
      </div>
      <form className="toolbar">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Nombre, email o empresa" aria-label="Buscar" />
        <select name="status" defaultValue={status} aria-label="Estado">
          <option value="open">Abiertos</option>
          <option value="converted">Convertidos</option>
          <option value="archived">Archivados</option>
          <option value="all">Todos</option>
        </select>
        <select name="source" defaultValue={sp.source ?? ""} aria-label="Origen">
          <option value="">Todos los orígenes</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select name="funnel" defaultValue={sp.funnel ?? ""} aria-label="Etapa">
          <option value="">Todas las etapas</option>
          {FUNNEL_STAGES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <button className="btn secondary">Filtrar</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Contacto</th><th>Empresa</th><th>Origen</th><th>Etapa</th><th>Etiquetas</th><th>Estado</th><th>Última actividad</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="empty-row">No hay leads con estos filtros.</td></tr>}
            {rows.map((l) => (
              <tr key={l.id}>
                <td><Link href={`/leads/${l.id}`}>{l.person_name ?? l.title}</Link><div className="meta">{l.email}</div></td>
                <td>{l.organization_id ? <Link href={`/organizations/${l.organization_id}`}>{l.organization_name}</Link> : "—"}</td>
                <td>{l.source ?? "—"}{l.source_detail && <div className="meta">{l.source_detail}</div>}</td>
                <td>{l.funnel_stage ? <span className={`badge ${l.funnel_stage}`}>{l.funnel_stage.toUpperCase()}</span> : "—"}</td>
                <td>{l.tags.length ? l.tags.map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>) : "—"}</td>
                <td>
                  <span className={`badge ${l.status}`}>{STATUS_LABELS[l.status]}</span>
                  {l.converted_deal_id && <div className="meta"><Link href={`/deals/${l.converted_deal_id}`}>Ver deal</Link></div>}
                </td>
                <td>{date(l.last_activity_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
