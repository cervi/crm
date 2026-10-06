import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { money } from "@/lib/format";
import { HealthBadge } from "@/components/HealthBadge";

export const dynamic = "force-dynamic";
export const metadata = { title: "Matriz de productos" };

/** Qué tiene cada cliente y qué le falta del catálogo: cada hueco es una oportunidad de cross-sell. */
export default async function MatrixPage() {
  await requireUser();
  const [products, rows] = await Promise.all([
    sql<{ id: string; name: string; unit_price: string | null }[]>`SELECT id, name, unit_price::text FROM products WHERE is_active ORDER BY lower(name)`,
    sql<{ id: string; name: string; health: number | null; owned: string[]; open: string[]; arr: number }[]>`
      SELECT o.id, o.name, h.score AS health,
        coalesce((SELECT array_agg(DISTINCT i.product_id::text) FROM contract_items i JOIN contracts c ON c.id = i.contract_id
                  WHERE c.organization_id = o.id AND c.status = 'active'), '{}') AS owned,
        coalesce((SELECT array_agg(DISTINCT dp.product_id::text) FROM deal_products dp JOIN deals d ON d.id = dp.deal_id
                  WHERE d.organization_id = o.id AND d.status = 'open' AND d.deleted_at IS NULL AND d.deal_type IN ('upsell', 'cross_sell')), '{}') AS open,
        (SELECT coalesce(sum(c.annual_value), 0)::float8 FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active') AS arr
      FROM organizations o LEFT JOIN account_health h ON h.organization_id = o.id
      WHERE o.deleted_at IS NULL AND EXISTS (SELECT 1 FROM contracts c WHERE c.organization_id = o.id AND c.status = 'active')
      ORDER BY o.name LIMIT 500`,
  ]);
  const gaps = rows.reduce((n, r) => n + products.filter((p) => !r.owned.includes(p.id) && !r.open.includes(p.id)).length, 0);
  return (
    <main className="page">
      <div className="crumbs"><Link href="/accounts">Clientes</Link></div>
      <div className="page-head">
        <div>
          <h1>Matriz de productos</h1>
          <p className="muted" style={{ margin: 0 }}>Qué tiene cada cliente de vuestro catálogo. Los huecos ({gaps}) son oportunidades de cross-sell; el agente de cuenta las propone cuando el cliente está sano o pregunta por ellas.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="matrix">
          <thead><tr><th>Cliente</th><th>Salud</th><th className="num">Importe anual</th>{products.map((p) => <th key={p.id} className="center">{p.name}<div className="meta">{money(p.unit_price)}</div></th>)}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={products.length + 3} className="empty-row">Todavía no hay clientes con contrato.</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/organizations/${r.id}`}>{r.name}</Link></td>
                <td><HealthBadge score={r.health} compact /></td>
                <td className="num">{money(r.arr)}</td>
                {products.map((p) => (
                  <td key={p.id} className="center">
                    {r.owned.includes(p.id) ? <span className="badge won" title="Lo tiene">✓</span>
                      : r.open.includes(p.id) ? <span className="badge warn" title="Oportunidad abierta">En curso</span>
                      : <span className="matrix-gap" title="No lo tiene: oportunidad de cross-sell">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
