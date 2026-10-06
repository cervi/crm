import { z } from "zod";
import { sql, transaction, type Db } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";
import { id, parse, text } from "./validation";

// ===========================================================================
// Catálogo de productos y líneas de producto de cada deal. Con productos, el
// importe del deal es la suma de sus líneas.
// ===========================================================================

export type Product = {
  id: string; name: string; code: string | null; description: string | null; unit_price: string | null; currency: string;
  billing: "one_off" | "monthly" | "yearly"; is_active: boolean; deals: number;
};
export const BILLING_LABELS: Record<Product["billing"], string> = { one_off: "Pago único", monthly: "Mensual", yearly: "Anual" };

export async function listProducts(includeInactive = false): Promise<Product[]> {
  return sql<Product[]>`
    SELECT p.id, p.name, p.code, p.description, p.unit_price::text, p.currency, p.billing, p.is_active,
           (SELECT count(DISTINCT dp.deal_id)::int FROM deal_products dp WHERE dp.product_id = p.id) AS deals
    FROM products p WHERE ${includeInactive} OR p.is_active ORDER BY p.is_active DESC, lower(p.name)`;
}

const productSchema = z.object({
  name: text("El nombre", 200),
  code: z.string().trim().max(60).optional(),
  description: z.string().trim().max(2000).optional(),
  unit_price: z.coerce.number().min(0, "El precio no puede ser negativo").max(1e10),
  billing: z.enum(["one_off", "monthly", "yearly"]),
  is_active: z.string().optional(),
});

export async function saveProduct(productId: string | null, data: unknown) {
  const v = parse(productSchema, data);
  const values = { name: v.name, code: v.code || null, description: v.description || null, unit_price: v.unit_price, billing: v.billing };
  if (productId) {
    await sql`UPDATE products SET ${sql({ ...values, is_active: v.is_active === "on" })} WHERE id = ${productId}`;
  } else {
    await sql`INSERT INTO products ${sql(values)}`;
  }
}

export type DealLine = {
  id: string; product_id: string; name: string; billing: Product["billing"]; quantity: string; unit_price: string;
  discount_pct: string; subtotal: number;
};

export async function dealLines(dealId: string): Promise<DealLine[]> {
  return sql<DealLine[]>`
    SELECT dp.id, dp.product_id, p.name, p.billing, dp.quantity::text, dp.unit_price::text, dp.discount_pct::text,
           (dp.quantity * dp.unit_price * (1 - dp.discount_pct / 100))::float8 AS subtotal
    FROM deal_products dp JOIN products p ON p.id = dp.product_id
    WHERE dp.deal_id = ${dealId} ORDER BY dp.created_at`;
}

/** Recalcula el importe del deal con sus líneas (si tiene). */
async function syncValue(tx: Db, actor: Actor, dealId: string) {
  const [t] = await tx<{ total: number | null; n: number; value: string | null }[]>`
    SELECT (SELECT sum(quantity * unit_price * (1 - discount_pct / 100)) FROM deal_products WHERE deal_id = ${dealId})::float8 AS total,
           (SELECT count(*)::int FROM deal_products WHERE deal_id = ${dealId}) AS n,
           (SELECT value::text FROM deals WHERE id = ${dealId}) AS value`;
  if (!t.n) return;
  const total = Math.round((t.total ?? 0) * 100) / 100;
  if (Number(t.value ?? -1) === total) return;
  await tx`UPDATE deals SET value = ${total} WHERE id = ${dealId}`;
  await recordEvent(tx, actor, "deal", dealId, "deal.updated", { changes: { value: total }, from: "productos" });
}

const lineSchema = z.object({
  product_id: id,
  quantity: z.coerce.number().positive("La cantidad tiene que ser mayor que 0").max(1e6),
  unit_price: z.union([z.literal(""), z.coerce.number().min(0)]).optional(),
  discount_pct: z.union([z.literal(""), z.coerce.number().min(0).max(100, "El descuento va de 0 a 100")]).optional(),
});

export async function addLine(actor: Actor, dealId: string, data: unknown) {
  const v = parse(lineSchema, data);
  await transaction(async (tx) => {
    const [p] = await tx<{ unit_price: string | null; is_active: boolean }[]>`SELECT unit_price::text, is_active FROM products WHERE id = ${v.product_id}`;
    if (!p?.is_active) throw new UserError("Ese producto no está disponible.");
    const price = v.unit_price === "" || v.unit_price === undefined ? Number(p.unit_price ?? 0) : v.unit_price;
    const discount = v.discount_pct === "" || v.discount_pct === undefined ? 0 : v.discount_pct;
    await tx`INSERT INTO deal_products (deal_id, product_id, quantity, unit_price, discount_pct)
             VALUES (${dealId}, ${v.product_id}, ${v.quantity}, ${price}, ${discount})`;
    await syncValue(tx, actor, dealId);
  });
}

export async function removeLine(actor: Actor, dealId: string, lineId: string) {
  await transaction(async (tx) => {
    await tx`DELETE FROM deal_products WHERE id = ${lineId} AND deal_id = ${dealId}`;
    await syncValue(tx, actor, dealId);
  });
}
