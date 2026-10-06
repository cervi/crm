import { z } from "zod";
import { sql, transaction } from "./db";
import { createActivity } from "./activities";
import { loseDeal, moveDealToStage, winDeal } from "./deals";
import { UserError, toUserMessage } from "./errors";
import { recordEvent, type Actor } from "./events";
import { id, optText, parse, text, UUID_RE } from "./validation";

// ===========================================================================
// Acciones en bloque sobre varios deals a la vez (desde la lista).
// Cada deal pasa por la misma lógica que a mano (historia, reglas de la IA…).
// ===========================================================================

export const BULK_MAX = 500;

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("owner"), owner_id: z.union([id, z.literal("")]) }),
  z.object({ op: z.literal("stage"), stage_id: id }),
  z.object({ op: z.literal("won") }),
  z.object({ op: z.literal("lost"), lost_reason_id: id, lost_note: optText(1000) }),
  z.object({
    op: z.literal("activity"), type: z.string().trim().min(1), subject: text("El asunto", 300),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Indica la fecha"),
  }),
], { message: "Elige qué hacer con los deals seleccionados." });

export type BulkResult = { done: number; skipped: number; firstError: string | null };

export async function bulkDeals(actor: Actor, ids: unknown, data: unknown): Promise<BulkResult> {
  const list = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)))] : [];
  if (list.length === 0) throw new UserError("No hay deals seleccionados.");
  if (list.length > BULK_MAX) throw new UserError(`Como mucho ${BULK_MAX} deals a la vez.`);
  const v = parse(opSchema, data);

  let done = 0, skipped = 0, firstError: string | null = null;
  const skip = (err: unknown) => { skipped++; firstError ??= toUserMessage(err); };

  if (v.op === "owner") {
    const ownerId = v.owner_id || null;
    const [owner] = ownerId ? await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${ownerId} AND kind = 'human' AND is_active` : [{ name: null }];
    if (!owner) throw new UserError("Responsable no válido.");
    for (const dealId of list) {
      try {
        const changed = await transaction(async (tx) => {
          const [d] = await tx<{ owner_id: string | null; from_name: string | null }[]>`
            SELECT d.owner_id, u.name AS from_name FROM deals d LEFT JOIN users u ON u.id = d.owner_id
            WHERE d.id = ${dealId} AND d.deleted_at IS NULL FOR UPDATE OF d`;
          if (!d) throw new UserError("El deal no existe.");
          if (d.owner_id === ownerId) return false;
          await tx`UPDATE deals SET owner_id = ${ownerId} WHERE id = ${dealId}`;
          // Las actividades pendientes pasan al nuevo responsable.
          await tx`UPDATE activities SET owner_id = ${ownerId} WHERE deal_id = ${dealId} AND NOT done AND owner_id IS NOT DISTINCT FROM ${d.owner_id}`;
          await recordEvent(tx, actor, "deal", dealId, "deal.owner_changed", {
            from_owner_id: d.owner_id, to_owner_id: ownerId, from_name: d.from_name, to_name: owner.name,
          });
          return true;
        });
        if (changed) done++; else skipped++;
      } catch (err) { skip(err); }
    }
    return { done, skipped, firstError };
  }

  for (const dealId of list) {
    try {
      switch (v.op) {
        case "stage": {
          const [d] = await sql<{ stage_id: string; status: string }[]>`SELECT stage_id, status FROM deals WHERE id = ${dealId}`;
          if (d?.stage_id === v.stage_id) { skipped++; continue; }
          await moveDealToStage(actor, dealId, v.stage_id);
          break;
        }
        case "won": await winDeal(actor, dealId); break;
        case "lost": await loseDeal(actor, dealId, { lost_reason_id: v.lost_reason_id, lost_note: v.lost_note }); break;
        case "activity": {
          const [p] = await sql<{ person_id: string }[]>`
            SELECT person_id FROM deal_participants WHERE deal_id = ${dealId} ORDER BY is_primary DESC LIMIT 1`;
          await createActivity(actor, {
            type: v.type, subject: v.subject, deal_id: dealId, person_id: p?.person_id,
            due_at: `${v.due_date}T09:00:00`,
          });
          break;
        }
      }
      done++;
    } catch (err) { skip(err); }
  }
  return { done, skipped, firstError };
}

export function bulkSummary(r: BulkResult): string {
  const s = (n: number) => (n === 1 ? "" : "s");
  const parts = [`${r.done} deal${s(r.done)} actualizado${s(r.done)}`];
  if (r.skipped) parts.push(`${r.skipped} sin cambios${r.firstError ? ` (${r.firstError.replace(/\.$/, "")})` : ""}`);
  return `${parts.join(", ")}.`;
}
