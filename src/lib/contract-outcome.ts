import type { Db } from "./db";

// ===========================================================================
// Qué pasa con el contrato cuando se cierra un deal de cliente (sin más
// dependencias que la base de datos: lo llaman ganar y perder un deal).
//
//   · Renovación ganada: el contrato renueva un año más con el nuevo importe.
//   · Renovación perdida: el contrato queda cancelado (baja del cliente).
//   · Upsell o cross-sell ganado: sus productos se suman al contrato.
// ===========================================================================

/** Importe anual de unas líneas: lo mensual ×12, lo anual tal cual, los pagos únicos no cuentan. */
export const ANNUAL = `CASE p.billing WHEN 'monthly' THEN 12 WHEN 'yearly' THEN 1 ELSE 0 END`;

export async function applyContractOutcome(db: Db, dealId: string, status: "won" | "lost") {
  const [d] = await db<{ deal_type: string; contract_id: string | null; organization_id: string | null; value: string | null }[]>`
    SELECT deal_type, contract_id, organization_id, value::text FROM deals WHERE id = ${dealId}`;
  if (!d || !["renewal", "upsell", "cross_sell"].includes(d.deal_type)) return;
  let contractId = d.contract_id;
  if (!contractId && d.organization_id) {
    const [c] = await db<{ id: string }[]>`
      SELECT id FROM contracts WHERE organization_id = ${d.organization_id} AND status = 'active' ORDER BY renewal_date NULLS LAST LIMIT 1`;
    contractId = c?.id ?? null;
  }
  if (!contractId) return;
  if (d.deal_type === "renewal") {
    if (status === "won") {
      await db`UPDATE contracts SET status = 'active', renewal_date = coalesce(renewal_date, current_date) + interval '1 year',
                      annual_value = coalesce(${d.value}::numeric, annual_value), updated_at = now() WHERE id = ${contractId}`;
    } else {
      await db`UPDATE contracts SET status = 'cancelled', updated_at = now() WHERE id = ${contractId}`;
    }
    return;
  }
  if (status !== "won") return;
  // Ampliación ganada: sus productos pasan al contrato.
  const lines = await db<{ product_id: string; quantity: string; unit_price: string; discount_pct: string; annual: string }[]>`
    SELECT dp.product_id, dp.quantity::text, dp.unit_price::text, dp.discount_pct::text,
           (dp.quantity * dp.unit_price * (1 - dp.discount_pct / 100) * ${db.unsafe(ANNUAL)})::text AS annual
    FROM deal_products dp JOIN products p ON p.id = dp.product_id WHERE dp.deal_id = ${dealId}`;
  for (const l of lines) {
    await db`INSERT INTO contract_items (contract_id, product_id, quantity, unit_price, discount_pct)
             VALUES (${contractId}, ${l.product_id}, ${l.quantity}, ${l.unit_price}, ${l.discount_pct})`;
  }
  const added = lines.length ? lines.reduce((n, l) => n + Number(l.annual), 0) : Number(d.value ?? 0);
  await db`UPDATE contracts SET annual_value = annual_value + ${added}, updated_at = now() WHERE id = ${contractId}`;
  await db`UPDATE deals SET contract_id = ${contractId} WHERE id = ${dealId} AND contract_id IS NULL`;
}
