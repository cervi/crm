import Link from "next/link";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { ExportLink } from "@/components/ExportLink";
import { leadSources, listLeads } from "@/lib/leads";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { ScoreBadge } from "@/components/ScoreBadge";
import { FitBadge } from "@/components/FitBadge";
import { date, FUNNEL_STAGES, STATUS_LABELS } from "@/lib/format";
import { DataTable } from "@/components/DataTable";

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
        <AutoSubmitSelect name="status" defaultValue={status} aria-label="Estado">
          <option value="open">Abiertos</option>
          <option value="converted">Convertidos</option>
          <option value="archived">Archivados</option>
          <option value="all">Todos</option>
        </AutoSubmitSelect>
        <AutoSubmitSelect name="source" defaultValue={sp.source ?? ""} aria-label="Origen">
          <option value="">Todos los orígenes</option>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </AutoSubmitSelect>
        <AutoSubmitSelect name="funnel" defaultValue={sp.funnel ?? ""} aria-label="Etapa">
          <option value="">Todas las etapas</option>
          {FUNNEL_STAGES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </AutoSubmitSelect>
        <AutoSubmitSelect name="temp" defaultValue={sp.temp ?? ""} aria-label="Puntuación">
          <option value="">Cualquier puntuación</option>
          <option value="hot">Calientes (70+)</option>
          <option value="warm">Templados (40–69)</option>
          <option value="cold">Fríos (menos de 40)</option>
        </AutoSubmitSelect>
        <AutoSubmitSelect name="fit" defaultValue={sp.fit ?? ""} aria-label="Encaje">
          <option value="">Cualquier encaje</option>
          <option value="fit">Encajan</option>
          <option value="unknown">Falta saber</option>
          <option value="no_fit">No encajan</option>
        </AutoSubmitSelect>
        <AutoSubmitSelect name="sort" defaultValue={sp.sort ?? ""} aria-label="Orden">
          <option value="">Más recientes</option>
          <option value="score">Mejor puntuación</option>
        </AutoSubmitSelect>
        <button className="sr-only" tabIndex={-1}>Buscar</button>
      </form>
      <DataTable id="leads" empty={sp.q || sp.source || sp.funnel || sp.temp || sp.fit || status !== "open"
        ? <>No hay leads con estos filtros. <Link href="/leads">Quitar filtros</Link></>
        : <>Todavía no hay leads abiertos. Llegan solos desde tus formularios o puedes <Link href="/leads/new">crear uno a mano</Link>.</>}
        columns={[
          { key: "contact", label: "Contacto", required: true, pinned: true },
          { key: "score", label: "Puntuación" },
          { key: "fit", label: "Encaje" },
          { key: "org", label: "Empresa" },
          { key: "source", label: "Origen" },
          { key: "utm", label: "Campaña (UTM)", hidden: true },
          { key: "funnel", label: "Etapa" },
          { key: "tags", label: "Etiquetas" },
          { key: "status", label: "Estado" },
          { key: "owner", label: "Responsable", hidden: true },
          { key: "created", label: "Creado", hidden: true, className: "nowrap" },
          { key: "last", label: "Última actividad", className: "nowrap" },
        ]}
        rows={rows.map((l) => ({
          id: l.id, label: l.person_name ?? l.title,
          cells: {
            contact: <span className="cell-main"><Avatar name={l.person_name ?? l.title} size="sm" /><span><Link href={`/leads/${l.id}`}>{l.person_name ?? l.title}</Link>{l.email && l.email !== (l.person_name ?? l.title) && <div className="meta">{l.email}</div>}</span></span>,
            score: <ScoreBadge score={l.score} reasons={l.score_reasons} />,
            fit: <FitBadge fit={l.fit} reason={l.fit_reason} />,
            org: l.organization_id ? <Link href={`/organizations/${l.organization_id}`}>{l.organization_name}</Link> : null,
            source: l.source ? <>{l.source}{l.source_detail && <div className="meta">{l.source_detail}</div>}</> : null,
            utm: l.utm?.utm_campaign ?? l.utm?.utm_source ?? null,
            funnel: l.funnel_stage ? <span className={`badge ${l.funnel_stage}`}>{l.funnel_stage.toUpperCase()}</span> : null,
            tags: l.tags.length ? l.tags.map((t) => <span key={t} className="badge" style={{ marginRight: 4 }}>{t}</span>) : null,
            status: <><span className={`badge ${l.status}`}>{STATUS_LABELS[l.status]}</span>{l.converted_deal_id && <div className="meta"><Link href={`/deals/${l.converted_deal_id}`}>Ver deal</Link></div>}</>,
            owner: l.owner_name,
            created: date(l.created_at),
            last: date(l.last_activity_at),
          },
        }))} />
    </main>
  );
}
