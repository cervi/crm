import Link from "next/link";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { DataTable } from "@/components/DataTable";
import { HealthBadge } from "@/components/HealthBadge";
import { Icon } from "@/components/Icon";
import { requireUser } from "@/lib/auth";
import { activityTypes } from "@/lib/activity-types";
import { activityLabel, date, dateTime, money } from "@/lib/format";
import { listMyDeals, myDealCounts, MY_DEAL_FILTERS, type MyDealFilter } from "@/lib/my-deals";
import { listPipelines } from "@/lib/pipelines";
import { listUsers } from "@/lib/users";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mis deals" };

export default async function MyDealsPage({ searchParams }: {
  searchParams: Promise<{ f?: string; owner?: string; pipeline?: string; q?: string }>;
}) {
  const [me, sp] = await Promise.all([requireUser(), searchParams]);
  await activityTypes();
  const filter = (MY_DEAL_FILTERS.some((x) => x.key === sp.f) ? sp.f : "open") as MyDealFilter;
  // Por defecto, los tuyos; «all» = todo el equipo.
  const ownerId = sp.owner === "all" ? null : isId(sp.owner) ? sp.owner : me.id;
  const pipelineId = isId(sp.pipeline) ? sp.pipeline : null;
  const [rows, counts, pipelines, users] = await Promise.all([
    listMyDeals({ ownerId, filter, pipelineId, q: sp.q }), myDealCounts(ownerId, pipelineId), listPipelines(), listUsers(),
  ]);
  const humans = users.filter((u) => u.kind === "human");
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { f: filter === "open" ? undefined : filter, owner: sp.owner, pipeline: sp.pipeline, q: sp.q, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `/deals?${s}` : "/deals";
  };
  const closed = filter === "won" || filter === "lost";
  const who = ownerId === me.id ? "Tus deals" : ownerId ? `Deals de ${humans.find((u) => u.id === ownerId)?.name ?? "otra persona"}` : "Deals de todo el equipo";
  const countOf = (k: MyDealFilter) => (k in counts ? counts[k as keyof typeof counts] : null);

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>{ownerId === me.id ? "Mis deals" : who}</h1>
          <p className="muted" style={{ margin: 0 }}>{who} de todos los pipelines: {counts.open} abiertos · {money(counts.value)}. Primero los que no tienen siguiente paso.</p>
        </div>
        <div className="head-actions">
          <Link href="/deals/new" className="btn"><Icon name="plus" />Nuevo deal</Link>
        </div>
      </div>

      <nav className="chips" aria-label="Filtrar deals">
        {MY_DEAL_FILTERS.map((x) => {
          const n = countOf(x.key);
          return (
            <Link key={x.key} href={qs({ f: x.key === "open" ? undefined : x.key })} aria-current={filter === x.key ? "page" : undefined} title={x.hint}
                  className={(x.key === "no_next" || x.key === "overdue") && n ? "warn" : undefined}>
              {x.label}{n !== null && <span className="chip-count">{n}</span>}
            </Link>
          );
        })}
      </nav>

      <form className="toolbar">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Deal, empresa o contacto" aria-label="Buscar" />
        {filter !== "open" && <input type="hidden" name="f" value={filter} />}
        <AutoSubmitSelect name="owner" defaultValue={sp.owner === "all" ? "all" : ownerId ?? me.id} aria-label="Responsable">
          <option value={me.id}>Míos</option>
          <option value="all">Todo el equipo</option>
          {humans.filter((u) => u.id !== me.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </AutoSubmitSelect>
        <AutoSubmitSelect name="pipeline" defaultValue={pipelineId ?? ""} aria-label="Pipeline">
          <option value="">Todos los pipelines</option>
          {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </AutoSubmitSelect>
        <button className="btn secondary">Buscar</button>
      </form>

      <DataTable id="my-deals"
        empty={filter === "no_next" ? <>Todos tienen un siguiente paso. Así da gusto.</>
          : filter === "overdue" ? <>Nada vencido.</>
          : sp.q || pipelineId ? <>No hay deals con estos filtros. <Link href={qs({ q: undefined, pipeline: undefined })}>Quitar filtros</Link></>
          : <>No hay deals aquí.</>}
        columns={[
          { key: "deal", label: "Deal", required: true, pinned: true },
          { key: "next", label: closed ? "Cerrado" : "Siguiente paso" },
          { key: "value", label: "Importe", className: "num" },
          { key: "stage", label: "Fase" },
          { key: "pipeline", label: "Pipeline" },
          { key: "health", label: "Salud" },
          { key: "close", label: "Cierre previsto", className: "nowrap" },
          { key: "last", label: "Última actividad", className: "nowrap" },
          { key: "person", label: "Contacto", hidden: true },
          { key: "owner", label: "Responsable", hidden: ownerId !== null },
          { key: "created", label: "Creado", hidden: true, className: "nowrap" },
        ]}
        rows={rows.map((r) => {
          const late = r.expected_close_date && new Date(r.expected_close_date) < new Date(new Date().toDateString());
          return {
            id: r.id, label: r.title, className: !closed && !r.next_id ? "row-attn" : undefined,
            cells: {
              deal: <span><Link href={`/deals/${r.id}`}><strong>{r.title}</strong></Link>{r.organization && <div className="meta">{r.organization}</div>}</span>,
              next: closed ? date(r.closed_at)
                : r.next_id ? (
                  <span className={r.overdue ? "tone-bad" : undefined}>
                    {activityLabel(r.next_type)}: {r.next_subject}
                    <div className="meta">{r.next_due ? dateTime(r.next_due) : "sin fecha"}{r.overdue ? ` · ${r.overdue} vencida${r.overdue === 1 ? "" : "s"}` : ""}</div>
                  </span>
                ) : <Link href={`/deals/${r.id}#nueva-actividad`} className="badge warn">Sin siguiente paso · programar</Link>,
              value: money(r.value, r.currency),
              stage: <>{r.stage}<div className={r.is_rotten ? "meta tone-bad" : "meta"}>{r.days_in_stage} día{r.days_in_stage === 1 ? "" : "s"}{r.is_rotten ? " · parado" : ""}</div></>,
              pipeline: <Link href={`/pipelines/${r.pipeline_id}`}>{r.pipeline}</Link>,
              health: <HealthBadge score={r.health} compact />,
              close: r.expected_close_date ? <span className={late && !closed ? "tone-bad" : undefined}>{date(r.expected_close_date)}</span> : <span className="muted">—</span>,
              last: r.last_done ? date(r.last_done) : <span className="muted">nunca</span>,
              person: r.person,
              owner: r.owner,
              created: date(r.created_at),
            },
          };
        })}
      />
    </main>
  );
}
