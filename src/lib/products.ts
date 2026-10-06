import { z } from "zod";
import { sql, transaction, type Db } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";
import { notify } from "./notifications";
import { id, parse, text } from "./validation";

// ===========================================================================
// Catálogo de productos y líneas de producto de cada deal. Con productos, el
// importe del deal es la suma de sus líneas.
// ===========================================================================

export type Product = {
  id: string; name: string; code: string | null; description: string | null; unit_price: string | null; currency: string;
  billing: "one_off" | "monthly" | "yearly"; is_active: boolean; deals: number; max_discount_pct: string | null;
};
export const BILLING_LABELS: Record<Product["billing"], string> = { one_off: "Pago único", monthly: "Mensual", yearly: "Anual" };

export async function listProducts(includeInactive = false): Promise<Product[]> {
  return sql<Product[]>`
    SELECT p.id, p.name, p.code, p.description, p.unit_price::text, p.currency, p.billing, p.is_active, p.max_discount_pct::text,
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
  max_discount_pct: z.union([z.literal(""), z.coerce.number().min(0).max(100, "El descuento máximo va de 0 a 100")]).optional(),
});

export async function saveProduct(productId: string | null, data: unknown) {
  const v = parse(productSchema, data);
  const values = { name: v.name, code: v.code || null, description: v.description || null, unit_price: v.unit_price, billing: v.billing,
                   max_discount_pct: v.max_discount_pct === "" || v.max_discount_pct === undefined ? null : v.max_discount_pct };
  if (productId) {
    await sql`UPDATE products SET ${sql({ ...values, is_active: v.is_active === "on" })} WHERE id = ${productId}`;
  } else {
    await sql`INSERT INTO products ${sql(values)}`;
  }
}

export type DiscountStatus = "ok" | "pending" | "approved" | "rejected";
export type DealLine = {
  id: string; product_id: string; name: string; billing: Product["billing"]; quantity: string; unit_price: string;
  discount_pct: string; subtotal: number; discount_status: DiscountStatus; discount_limit: string | null; requested_by_name: string | null;
};

export async function dealLines(dealId: string): Promise<DealLine[]> {
  return sql<DealLine[]>`
    SELECT dp.id, dp.product_id, p.name, p.billing, dp.quantity::text, dp.unit_price::text, dp.discount_pct::text,
           (dp.quantity * dp.unit_price * (1 - dp.discount_pct / 100))::float8 AS subtotal,
           dp.discount_status, dp.discount_limit::text, u.name AS requested_by_name
    FROM deal_products dp JOIN products p ON p.id = dp.product_id LEFT JOIN users u ON u.id = dp.requested_by
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
    const [p] = await tx<{ unit_price: string | null; is_active: boolean; name: string; limit: string | null }[]>`
      SELECT p.unit_price::text, p.is_active, p.name, coalesce(p.max_discount_pct, (SELECT max_discount_pct FROM app_settings LIMIT 1))::text AS limit
      FROM products p WHERE p.id = ${v.product_id}`;
    if (!p?.is_active) throw new UserError("Ese producto no está disponible.");
    const price = v.unit_price === "" || v.unit_price === undefined ? Number(p.unit_price ?? 0) : v.unit_price;
    const discount = v.discount_pct === "" || v.discount_pct === undefined ? 0 : v.discount_pct;
    // Por encima del límite (del producto o el general), el descuento espera la aprobación de un administrador.
    const over = p.limit !== null && discount > Number(p.limit);
    const [line] = await tx<{ id: string }[]>`
      INSERT INTO deal_products (deal_id, product_id, quantity, unit_price, discount_pct, discount_status, discount_limit, requested_by)
      VALUES (${dealId}, ${v.product_id}, ${v.quantity}, ${price}, ${discount}, ${over ? "pending" : "ok"}, ${over ? Number(p.limit) : null},
              ${over ? actor.id : null})
      RETURNING id`;
    await syncValue(tx, actor, dealId);
    if (over) {
      await recordEvent(tx, actor, "deal", dealId, "deal.discount_requested", { line_id: line.id, product: p.name, discount, limit: Number(p.limit) });
      const [d] = await tx<{ title: string }[]>`SELECT title FROM deals WHERE id = ${dealId}`;
      const admins = await tx<{ id: string }[]>`SELECT id FROM users WHERE role = 'admin' AND is_active AND kind = 'human' AND id IS DISTINCT FROM ${actor.id}`;
      for (const a of admins) {
        await notify(tx, { userId: a.id, kind: "discount", title: `Descuento del ${discount} % en «${d?.title}» pide aprobación`,
                           body: `${p.name}: el límite sin aprobación es del ${Number(p.limit)} %.`, link: `/deals/${dealId}#productos`, actorId: actor.id });
      }
    }
  });
}

/** Aprueba el descuento de una línea o lo deja en el límite permitido. */
export async function decideDiscount(actor: Actor, dealId: string, lineId: string, approve: boolean) {
  await transaction(async (tx) => {
    const [l] = await tx<{ discount_pct: string; discount_limit: string | null; requested_by: string | null; name: string }[]>`
      SELECT dp.discount_pct::text, dp.discount_limit::text, dp.requested_by, p.name FROM deal_products dp JOIN products p ON p.id = dp.product_id
      WHERE dp.id = ${lineId} AND dp.deal_id = ${dealId} AND dp.discount_status = 'pending' FOR UPDATE`;
    if (!l) throw new UserError("Ese descuento ya no está pendiente.");
    if (approve) {
      await tx`UPDATE deal_products SET discount_status = 'approved', discount_by = ${actor.id}, discount_at = now() WHERE id = ${lineId}`;
    } else {
      await tx`UPDATE deal_products SET discount_status = 'rejected', discount_pct = coalesce(discount_limit, 0), discount_by = ${actor.id}, discount_at = now()
               WHERE id = ${lineId}`;
      await syncValue(tx, actor, dealId);
    }
    await recordEvent(tx, actor, "deal", dealId, approve ? "deal.discount_approved" : "deal.discount_rejected",
                      { line_id: lineId, product: l.name, discount: Number(l.discount_pct), limit: l.discount_limit === null ? null : Number(l.discount_limit) });
    if (l.requested_by && l.requested_by !== actor.id) {
      const [d] = await tx<{ title: string }[]>`SELECT title FROM deals WHERE id = ${dealId}`;
      await notify(tx, { userId: l.requested_by, kind: "discount", link: `/deals/${dealId}#productos`, actorId: actor.id,
                         title: approve ? `Aprobado el descuento del ${Number(l.discount_pct)} % en «${d?.title}»`
                                        : `Descuento ajustado al ${Number(l.discount_limit ?? 0)} % en «${d?.title}»` });
    }
  });
}

/** Descuentos esperando aprobación (para la bandeja de los administradores). */
export async function pendingDiscounts() {
  return sql<{ id: string; deal_id: string; deal_title: string; product: string; discount_pct: string; discount_limit: string | null;
               requested_by_name: string | null; subtotal: number; currency: string }[]>`
    SELECT dp.id, dp.deal_id, d.title AS deal_title, p.name AS product, dp.discount_pct::text, dp.discount_limit::text, u.name AS requested_by_name,
           (dp.quantity * dp.unit_price * (1 - dp.discount_pct / 100))::float8 AS subtotal, d.currency
    FROM deal_products dp JOIN deals d ON d.id = dp.deal_id AND d.deleted_at IS NULL JOIN products p ON p.id = dp.product_id
    LEFT JOIN users u ON u.id = dp.requested_by
    WHERE dp.discount_status = 'pending' ORDER BY dp.created_at`;
}

export async function removeLine(actor: Actor, dealId: string, lineId: string) {
  await transaction(async (tx) => {
    await tx`DELETE FROM deal_products WHERE id = ${lineId} AND deal_id = ${dealId}`;
    await syncValue(tx, actor, dealId);
  });
}
