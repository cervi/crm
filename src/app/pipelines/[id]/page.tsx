import Link from "next/link";
import { notFound } from "next/navigation";
import { getBoard, listPipelines } from "@/lib/pipelines";
import { listUsers } from "@/lib/users";
import { isId } from "@/lib/validation";
import { money } from "@/lib/format";
import { Board } from "@/components/Board";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Deals" };

export default async function PipelineBoard({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ owner?: string }>;
}) {
  const { id } = await params;
  const { owner } = await searchParams;
  if (!isId(id)) notFound();

  const ownerId = isId(owner) ? owner : null;
  const [pipelines, stages, users] = await Promise.all([listPipelines(), getBoard(id, ownerId), listUsers()]);
  const current = pipelines.find((p) => p.id === id);
  if (!current) notFound();

  const total = stages.reduce((sum, s) => sum + Number(s.total_value), 0);
  const count = stages.reduce((n, s) => n + s.deals.length, 0);
  const rotten = stages.reduce((n, s) => n + s.deals.filter((d) => d.is_rotten).length, 0);

  return (
    <main className="page-wide">
      <div className="page-head">
        <h1>Deals</h1>
        <nav className="pipeline-tabs" aria-label="Pipelines">
          {pipelines.map((p) => (
            <Link key={p.id} href={`/pipelines/${p.id}`} aria-current={p.id === id ? "page" : undefined}>{p.name}</Link>
          ))}
        </nav>
        <span className="spacer" />
        <form className="toolbar" style={{ margin: 0 }}>
          <select name="owner" defaultValue={ownerId ?? ""} aria-label="Responsable">
            <option value="">Todos los responsables</option>
            {users.filter((u) => u.kind === "human").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button className="btn secondary">Filtrar</button>
        </form>
        <Link href={`/deals/new?pipeline=${id}`} className="btn"><Icon name="plus" />Nuevo deal</Link>
      </div>
      <div className="board-summary">
        <span><strong>{money(total)}</strong> en {count} deal{count === 1 ? " abierto" : "s abiertos"}</span>
        {rotten > 0 && <span className="badge warn">{rotten} parado{rotten === 1 ? "" : "s"}</span>}
        <span className="meta">Arrastra un deal para cambiarlo de fase.</span>
      </div>
      <Board key={`${id}:${ownerId ?? ""}`} stages={stages} />
    </main>
  );
}
