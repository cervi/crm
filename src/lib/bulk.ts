import { z } from "zod";
import { sql, transaction } from "./db";
import { createActivity } from "./activities";
import { enroll, enrollPerson } from "./sequences";
import { moveToTrash } from "./trash";
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
  z.object({ op: z.literal("sequence"), sequence_id: id }),
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
        case "sequence": await enroll(actor, v.sequence_id, dealId); break;
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

// ---------------------------------------------------------------------------
// Contactos y empresas en bloque (desde sus listas)

const recordOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("owner"), owner_id: z.union([id, z.literal("")]) }),
  z.object({ op: z.literal("tag"), tag: text("La etiqueta", 40) }),
  z.object({ op: z.literal("untag"), tag: text("La etiqueta", 40) }),
  z.object({ op: z.literal("sequence"), sequence_id: id }),
  z.object({
    op: z.literal("activity"), type: z.string().trim().min(1), subject: text("El asunto", 300),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Indica la fecha"),
  }),
  z.object({ op: z.literal("trash") }),
], { message: "Elige qué hacer con los seleccionados." });

export async function bulkRecords(actor: Actor, kind: "person" | "organization", ids: unknown, data: unknown): Promise<BulkResult> {
  const list = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)))] : [];
  if (list.length === 0) throw new UserError("No hay nada seleccionado.");
  if (list.length > BULK_MAX) throw new UserError(`Como mucho ${BULK_MAX} a la vez.`);
  const v = parse(recordOp, data);
  let done = 0, skipped = 0, firstError: string | null = null;
  const table = kind === "person" ? "persons" : "organizations";
  const tagTable = kind === "person" ? "person_tags" : "organization_tags";
  const col = kind === "person" ? "person_id" : "organization_id";
  for (const rid of list) {
    try {
      if (v.op === "owner") {
        await sql`UPDATE ${sql(table)} SET owner_id = ${v.owner_id || null}, updated_at = now() WHERE id = ${rid}`;
        await recordEvent(sql, actor, kind, rid, `${kind}.owner_changed`, { to_owner_id: v.owner_id || null });
      } else if (v.op === "tag" || v.op === "untag") {
        const [t] = await sql<{ id: string }[]>`
          INSERT INTO tags (name) VALUES (${v.tag.trim()}) ON CONFLICT ((lower(name))) DO UPDATE SET name = tags.name RETURNING id`;
        if (v.op === "tag") await sql`INSERT INTO ${sql(tagTable)} (${sql(col)}, tag_id) VALUES (${rid}, ${t.id}) ON CONFLICT DO NOTHING`;
        else await sql`DELETE FROM ${sql(tagTable)} WHERE ${sql(col)} = ${rid} AND tag_id = ${t.id}`;
      } else if (v.op === "sequence") {
        if (kind !== "person") throw new UserError("Solo los contactos entran en secuencias.");
        await enrollPerson(actor, v.sequence_id, rid);
      } else if (v.op === "activity") {
        await createActivity(actor, { type: v.type, subject: v.subject, due_at: `${v.due_date}T09:00:00`, [col]: rid, owner_id: actor.id ?? undefined });
      } else {
        await moveToTrash(actor, kind, rid);
      }
      done++;
    } catch (err) { skipped++; firstError ??= toUserMessage(err); }
  }
  return { done, skipped, firstError };
}
