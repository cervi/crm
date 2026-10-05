import Link from "next/link";
import { notFound } from "next/navigation";
import { getBoard, listPipelines } from "@/lib/pipelines";

export const dynamic = "force-dynamic";

const money = (value: string | null, currency = "EUR") =>
  value === null
    ? "—"
    : new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 0 })
        .format(Number(value));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Tablero tipo Pipedrive: una columna por fase con sus deals abiertos.
export default async function PipelineBoard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();

  const [pipelines, stages] = await Promise.all([listPipelines(), getBoard(id)]);
  const current = pipelines.find((p) => p.id === id);
  if (!current) notFound();

  return (
    <main>
      <header className="topbar">
        <h1>Deals</h1>
        <nav className="pipeline-tabs" aria-label="Pipelines">
          {pipelines.map((p) => (
            <Link key={p.id} href={`/pipelines/${p.id}`} aria-current={p.id === id ? "page" : undefined}>
              {p.name}
            </Link>
          ))}
        </nav>
      </header>

      <section className="board">
        {stages.map((stage) => (
          <div key={stage.id} className="stage">
            <div className="stage-head">
              <h2>{stage.name}</h2>
              <span>
                {money(stage.total_value)} · {stage.deals.length} deal{stage.deals.length === 1 ? "" : "s"}
              </span>
            </div>
            <ul>
              {stage.deals.map((deal) => (
                <li key={deal.id} className={deal.is_rotten ? "deal rotten" : "deal"}>
                  <strong>{deal.title}</strong>
                  <span className="muted">{deal.organization_name ?? "Sin empresa"}</span>
                  <span>{money(deal.value, deal.currency)}</span>
                  <span className="meta">
                    {deal.days_in_stage} d en la fase
                    {deal.is_rotten && " · parado"}
                    {!deal.has_upcoming_session && " · sin sesión agendada"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </main>
  );
}
