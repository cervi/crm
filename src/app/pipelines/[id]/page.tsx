import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  BOARD_SORTS, getBoard, isBoardSort, isListSort, listPipelineDeals, listPipelines, type ListSort,
} from "@/lib/pipelines";
import { listUsers } from "@/lib/users";
import { isId } from "@/lib/validation";
import { date, dateTime, money, STATUS_LABELS } from "@/lib/format";
import { Board } from "@/components/Board";
import { PipelineToolbar } from "@/components/PipelineToolbar";
import { DealDetail } from "@/components/deal/DealDetail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deals" };

type Search = { owner?: string; sort?: string; view?: string; status?: string; dir?: string; deal?: string };

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

  const [pipelines, users] = await Promise.all([listPipelines(), listUsers()]);
  if (!pipelines.some((p) => p.id === id)) notFound();
  const stages = view === "board" ? await getBoard(id, ownerId, sort) : [];
  const rows = view === "list" ? await listPipelineDeals(id, { ownerId, status, sort: listSort, dir }) : [];

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
      <th className={num ? "num" : undefined} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined}>
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
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {sortHeader("title", "Deal")}
                  {sortHeader("organization", "Empresa")}
                  {sortHeader("stage", "Fase")}
                  {sortHeader("value", "Importe", true)}
                  {sortHeader("days", "Días en la fase", true)}
                  {sortHeader("next_activity", "Próxima actividad")}
                  {sortHeader("close", "Cierre previsto")}
                  {sortHeader("owner", "Responsable")}
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={9} className="empty-row">No hay deals con estos filtros.</td></tr>}
                {rows.map((r) => (
                  <tr key={r.id} className={selected === r.id ? "row-selected" : undefined}>
                    <td><Link href={qs({ deal: r.id })} scroll={false}><strong>{r.title}</strong></Link>{r.person_name && <div className="meta">{r.person_name}</div>}</td>
                    <td>{r.organization_id ? <Link href={`/organizations/${r.organization_id}`}>{r.organization_name}</Link> : "—"}</td>
                    <td>{r.stage_name}</td>
                    <td className="num">{money(r.value, r.currency)}</td>
                    <td className="num">{r.status === "open" ? <>{r.days_in_stage}{r.is_rotten && <span className="badge warn" style={{ marginLeft: 6 }}>Parado</span>}</> : "—"}</td>
                    <td>{r.status !== "open" ? "—"
                      : r.next_activity_at
                        ? <span className={new Date(r.next_activity_at) < new Date() ? "tone-bad" : undefined}>{dateTime(r.next_activity_at)}</span>
                        : <span className="badge">Sin actividad</span>}</td>
                    <td>{date(r.expected_close_date)}</td>
                    <td>{r.owner_name ?? "—"}</td>
                    <td><span className={`badge ${r.status}`}>{STATUS_LABELS[r.status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
