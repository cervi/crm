import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  BOARD_SORTS, DEAL_FLAGS, getBoard, isBoardSort, isDealFlag, isListSort, listPipelineDeals, listPipelines, listStages, type ListSort,
} from "@/lib/pipelines";
import { HealthBadge } from "@/components/HealthBadge";
import { recomputeHealth } from "@/lib/health";
import { sql } from "@/lib/db";
import { DEAL_COLUMNS, DEFAULT_DEAL_COLUMNS, parseDealColumns, type DealColumn } from "@/lib/deal-columns";
import { formatCustomValue, listFieldDefinitions } from "@/lib/custom-fields";
import { listLostReasons } from "@/lib/deals";
import { activeActivityTypes } from "@/lib/activity-types";
import { requireUser } from "@/lib/auth";
import { listViews, normalizeQuery } from "@/lib/views";
import { listSequences } from "@/lib/sequences";
import { deleteViewAction, saveViewAction } from "@/app/actions/views";
import { ActionForm } from "@/components/ActionForm";
import { ColumnPicker } from "@/components/ColumnPicker";
import { BulkSelectAll, DealBulkBar } from "@/components/DealBulkBar";
import { Icon } from "@/components/Icon";
import { listUsers } from "@/lib/users";
import { isId } from "@/lib/validation";
import { date, dateTime, money, STATUS_LABELS } from "@/lib/format";
import { Board } from "@/components/Board";
import { PipelineToolbar } from "@/components/PipelineToolbar";
import { DealDetail } from "@/components/deal/DealDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deals" };

type Search = {
  owner?: string; sort?: string; view?: string; status?: string; dir?: string; deal?: string;
  q?: string; stage?: string; flag?: string; min?: string; max?: string; cols?: string;
};

const num = (v: string | undefined) => (v && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

export default async function PipelinePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const { id } = await params;
  const sp = await searchParams;
  if (!isId(id)) notFound();

  const view = sp.view === "list" ? "list" : "board";
  const ownerId = isId(sp.owner) ? sp.owner : null;
  const sort = isBoardSort(sp.sort) ? sp.sort : "attention";
  const status = (["all", "won", "lost"] as const).find((s) => s === sp.status) ?? "open";
  const listSort: ListSort = isListSort(sp.sort) ? sp.sort : "stage";
  const dir = sp.dir === "desc" ? "desc" : "asc";

  const [pipelines, users, me] = await Promise.all([listPipelines(), listUsers(), requireUser()]);
  if (!pipelines.some((p) => p.id === id)) notFound();
  // La salud la calcula la revisión periódica; si hay deals abiertos sin calcular (recién creados o importados), ahora.
  const [missing] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM open_deals_status o WHERE o.pipeline_id = ${id} AND NOT EXISTS (SELECT 1 FROM deal_health h WHERE h.deal_id = o.id)`;
  if (missing.n > 0) await recomputeHealth().catch((err) => console.error("[salud]", err));
  const stages = view === "board" ? await getBoard(id, ownerId, sort) : [];
  const filters = {
    q: sp.q?.trim() || null, stageId: isId(sp.stage) ? sp.stage : null, flag: isDealFlag(sp.flag) ? sp.flag : null,
    min: num(sp.min), max: num(sp.max),
  };
  const listData = view === "list"
    ? await Promise.all([
        listPipelineDeals(id, { ownerId, status, sort: listSort, dir, ...filters }), listFieldDefinitions("deal"),
        listViews("deals", me.id), listStages(id), listLostReasons(), activeActivityTypes(), listSequences(),
      ])
    : null;
  const [rows, defs, views, pipelineStages, reasons, types, seqs] = listData ?? [[], [], [], [], [], [], []];
  const columns = parseDealColumns(sp.cols, defs.map((d) => d.key));
  const currentQuery = normalizeQuery("deals", sp);
  const filtered = Boolean(filters.q || filters.stageId || filters.flag || filters.min !== null || filters.max !== null);

  // Orden de navegación del panel (anterior / siguiente): el que se ve en pantalla.
  const order = view === "board" ? stages.flatMap((s) => s.deals.map((d) => d.id)) : rows.map((r) => r.id);
  const total = view === "board" ? stages.reduce((n, s) => n + Number(s.total_value), 0) : rows.reduce((n, r) => n + Number(r.value ?? 0), 0);
  const count = order.length;
  const rotten = view === "board" ? stages.reduce((n, s) => n + s.deals.filter((d) => d.is_rotten).length, 0) : 0;

  const qs = (patch: Partial<Search>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...patch })) if (v) next.set(k, v);
    return `/pipelines/${id}${next.size ? `?${next}` : ""}`;
  };
  const selected = isId(sp.deal) ? sp.deal : null;
  const pos = selected ? order.indexOf(selected) : -1;

  const sortHeader = (key: ListSort, label: string, num = false) => {
    const active = listSort === key;
    const nextDir = active && dir === "asc" ? "desc" : "asc";
    return (
      <th key={key} className={num ? "num" : undefined} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}>
        <Link href={qs({ sort: key, dir: nextDir, deal: undefined })} className="th-sort">{label}{active && (dir === "asc" ? " ↑" : " ↓")}</Link>
      </th>
    );
  };

  return (
    <main className={`page-wide pipeline-page${selected ? " has-panel" : ""}`}>
      <Suspense>
        <PipelineToolbar
          pipelineId={id}
          view={view}
          pipelines={pipelines.map((p) => ({ value: p.id, label: p.name }))}
          users={users.filter((u) => u.kind === "human").map((u) => ({ value: u.id, label: u.name }))}
          sorts={Object.entries(BOARD_SORTS).map(([value, label]) => ({ value, label }))}
          actions={<ExportLink dataset="deals" label="Exportar" params={view === "board"
            ? { pipeline: id, owner: ownerId, status: "open" }
            : { pipeline: id, owner: ownerId, status, q: filters.q, stage: filters.stageId, flag: filters.flag, min: sp.min, max: sp.max }} />}
          summary={
            <>
              <strong>{money(total)}</strong> · {count} deal{count === 1 ? "" : "s"}
              {rotten > 0 && <> · <span className="badge warn">{rotten} parado{rotten === 1 ? "" : "s"}</span></>}
            </>
          }
        />
        {view === "board" ? (
          <Board key={`${id}:${ownerId ?? ""}:${sort}`} stages={stages} />
        ) : (
          <>
            <nav className="chips views" aria-label="Vistas guardadas">
              <Link href={`/pipelines/${id}?view=list`} aria-current={currentQuery === "" ? "page" : undefined}>Todos</Link>
              {views.map((v) => (
                <span key={v.id} className={v.mine || (v.shared && me.role === "admin") ? "view-chip deletable" : "view-chip"}>
                  <Link href={`/pipelines/${id}?view=list${v.query ? `&${v.query}` : ""}`} aria-current={currentQuery === v.query ? "page" : undefined}
                        title={v.shared ? "Vista compartida con el equipo" : "Vista personal"}>
                    {v.name}{!v.shared && <span className="meta"> · mía</span>}
                  </Link>
                  {(v.mine || (v.shared && me.role === "admin")) && (
                    <form action={deleteViewAction.bind(null, v.id, `/pipelines/${id}`)}>
                      <button type="submit" className="view-del" aria-label={`Borrar la vista ${v.name}`}><Icon name="x" /></button>
                    </form>
                  )}
                </span>
              ))}
              {currentQuery !== "" && !views.some((v) => v.query === currentQuery) && (
                <details className="save-view">
                  <summary>+ Guardar esta vista</summary>
                  <ActionForm action={saveViewAction.bind(null, "deals", currentQuery, `/pipelines/${id}`)} submitLabel="Guardar vista" className="form inline">
                    <label className="field"><span className="label">Nombre</span><input name="name" required maxLength={80} placeholder="Mis deals parados" /></label>
                    <label className="checkbox"><input type="checkbox" name="shared" />Compartir con el equipo</label>
                  </ActionForm>
                </details>
              )}
            </nav>

            <form method="get" className="list-filters" role="search" aria-label="Filtrar deals">
              <input type="hidden" name="view" value="list" />
              {ownerId && <input type="hidden" name="owner" value={ownerId} />}
              {status !== "open" && <input type="hidden" name="status" value={status} />}
              {sp.sort && <input type="hidden" name="sort" value={sp.sort} />}
              {sp.dir && <input type="hidden" name="dir" value={sp.dir} />}
              {sp.cols && <input type="hidden" name="cols" value={sp.cols} />}
              <input name="q" type="search" defaultValue={filters.q ?? ""} placeholder="Buscar deal, empresa o contacto" aria-label="Buscar en la lista" />
              <select name="stage" defaultValue={filters.stageId ?? ""} aria-label="Fase">
                <option value="">Todas las fases</option>
                {pipelineStages.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
              <select name="flag" defaultValue={filters.flag ?? ""} aria-label="Situación">
                <option value="">Cualquier situación</option>
                {Object.entries(DEAL_FLAGS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input name="min" type="number" min={0} step="any" defaultValue={sp.min ?? ""} placeholder="Importe desde" aria-label="Importe desde" className="num-input" />
              <input name="max" type="number" min={0} step="any" defaultValue={sp.max ?? ""} placeholder="hasta" aria-label="Importe hasta" className="num-input" />
              <button type="submit" className="btn secondary small">Filtrar</button>
              {filtered && <Link href={qs({ q: undefined, stage: undefined, flag: undefined, min: undefined, max: undefined, deal: undefined })} className="meta">Quitar filtros</Link>}
              <span className="spacer" />
              <ColumnPicker
                options={[
                  ...(Object.entries(DEAL_COLUMNS) as [DealColumn, string][]).map(([value, label]) => ({ value, label })),
                  ...defs.map((d) => ({ value: `cf:${d.key}`, label: d.label })),
                ]}
                selected={columns} defaults={DEFAULT_DEAL_COLUMNS} />
            </form>

            <DealBulkBar
              users={users.filter((u) => u.kind === "human").map((u) => ({ value: u.id, label: u.name }))}
              stages={pipelineStages.map((st) => ({ value: st.id, label: st.name }))}
              reasons={reasons.map((r) => ({ value: r.id, label: r.label }))}
              types={types.map((t) => ({ value: t.key, label: t.label }))}
              sequences={seqs.filter((q) => q.is_active && q.steps > 0).map((q) => ({ value: q.id, label: q.name }))} />

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="check-col"><BulkSelectAll /></th>
                    {sortHeader("title", "Deal")}
                    {columns.map((c) => {
                      if (c.startsWith("cf:")) return <th key={c}>{defs.find((d) => `cf:${d.key}` === c)?.label}</th>;
                      const col = c as DealColumn;
                      const label = DEAL_COLUMNS[col];
                      if (col === "status" || col === "source") return <th key={c}>{label}</th>;
                      return sortHeader(col, label, col === "value" || col === "days");
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={columns.length + 2} className="empty-row">No hay deals con estos filtros.</td></tr>}
                  {rows.map((r) => (
                    <tr key={r.id} className={selected === r.id ? "row-selected" : undefined}>
                      <td className="check-col"><input type="checkbox" className="bulk-check" value={r.id} aria-label={`Seleccionar ${r.title}`} /></td>
                      <td><Link href={qs({ deal: r.id })} scroll={false}><strong>{r.title}</strong></Link>{r.person_name && <div className="meta">{r.person_name}</div>}</td>
                      {columns.map((c) => {
                        if (c.startsWith("cf:")) {
                          const def = defs.find((d) => `cf:${d.key}` === c);
                          return <td key={c}>{def ? formatCustomValue(def, r.custom?.[def.key], users) || "—" : "—"}</td>;
                        }
                        switch (c as DealColumn) {
                          case "organization": return <td key={c}>{r.organization_id ? <Link href={`/organizations/${r.organization_id}`}>{r.organization_name}</Link> : "—"}</td>;
                          case "stage": return <td key={c}>{r.stage_name}</td>;
                          case "value": return <td key={c} className="num">{money(r.value, r.currency)}</td>;
                          case "days": return <td key={c} className="num">{r.status === "open" ? <>{r.days_in_stage}{r.is_rotten && <span className="badge warn" style={{ marginLeft: 6 }}>Parado</span>}</> : "—"}</td>;
                          case "next_activity": return <td key={c}>{r.status !== "open" ? "—"
                            : r.next_activity_at
                              ? <span className={new Date(r.next_activity_at) < new Date() ? "tone-bad" : undefined}>{dateTime(r.next_activity_at)}</span>
                              : <span className="badge">Sin actividad</span>}</td>;
                          case "close": return <td key={c}>{date(r.expected_close_date)}</td>;
                          case "owner": return <td key={c}>{r.owner_name ?? "—"}</td>;
                          case "status": return <td key={c}><span className={`badge ${r.status}`}>{STATUS_LABELS[r.status]}</span></td>;
                          case "created": return <td key={c}>{date(r.created_at)}</td>;
                          case "source": return <td key={c}>{r.source ?? "—"}</td>;
                          case "health": return <td key={c}>{r.status === "open" ? <HealthBadge score={r.health} compact /> : "—"}</td>;
                        }
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Suspense>

      {selected && (
        <aside className="deal-panel" aria-label="Deal">
          <DealDetail
            dealId={selected}
            back={`/pipelines/${id}`}
            panel={{
              closeHref: qs({ deal: undefined }),
              fullHref: `/deals/${selected}`,
              prevHref: pos > 0 ? qs({ deal: order[pos - 1] }) : null,
              nextHref: pos >= 0 && pos < order.length - 1 ? qs({ deal: order[pos + 1] }) : null,
            }}
          />
        </aside>
      )}
    </main>
  );
}
