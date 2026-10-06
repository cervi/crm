import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { leadSources, listLeads } from "@/lib/leads";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { ScoreBadge } from "@/components/ScoreBadge";
import { FitBadge } from "@/components/FitBadge";
import { date, FUNNEL_STAGES, STATUS_LABELS } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leads" };

export default async function LeadsPage({ searchParams }: {
  searchParams: Promise<{ q?: string; status?: string; source?: string; funnel?: string; sort?: string; temp?: string; fit?: string }>;
}) {
  const sp = await searchParams;
  const status = ["open", "converted", "archived", "all"].includes(sp.status ?? "") ? sp.status! : "open";
  const [rows, sources] = await Promise.all([
    listLeads({ q: sp.q, status, source: sp.source, funnel: sp.funnel, sort: sp.sort, temp: sp.temp,
                fit: ["fit", "no_fit", "unknown"].includes(sp.fit ?? "") ? sp.fit : undefined }), leadSources(),
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
        <ExportLink dataset="leads" params={{ q: sp.q, status, source: sp.source, funnel: sp.funnel }} />
        <Link href="/settings/api" className="btn secondary"><Icon name="plug" />Conectar formularios</Link>
        <Link href="/leads/new" className="btn"><Icon name="plus" />Nuevo lead</Link>
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
        <select name="temp" defaultValue={sp.temp ?? ""} aria-label="Puntuación">
          <option value="">Cualquier puntuación</option>
          <option value="hot">Calientes (70+)</option>
          <option value="warm">Templados (40–69)</option>
          <option value="cold">Fríos (menos de 40)</option>
        </select>
        <select name="fit" defaultValue={sp.fit ?? ""} aria-label="Encaje">
          <option value="">Cualquier encaje</option>
          <option value="fit">Encajan</option>
          <option value="unknown">Falta saber</option>
          <option value="no_fit">No encajan</option>
        </select>
        <select name="sort" defaultValue={sp.sort ?? ""} aria-label="Orden">
          <option value="">Más recientes</option>
          <option value="score">Mejor puntuación</option>
        </select>
        <button className="btn secondary">Filtrar</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Contacto</th><th>Puntuación</th><th>Encaje</th><th>Empresa</th><th>Origen</th><th>Etapa</th><th>Etiquetas</th><th>Estado</th><th>Última actividad</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="empty-row">No hay leads con estos filtros.</td></tr>}
            {rows.map((l) => (
              <tr key={l.id}>
                <td><span className="cell-main"><Avatar name={l.person_name ?? l.title} size="sm" /><span><Link href={`/leads/${l.id}`}>{l.person_name ?? l.title}</Link><div className="meta">{l.email}</div></span></span></td>
                <td><ScoreBadge score={l.score} reasons={l.score_reasons} /></td>
                <td><FitBadge fit={l.fit} reason={l.fit_reason} /></td>
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
