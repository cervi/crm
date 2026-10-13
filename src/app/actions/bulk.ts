"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { toUserMessage } from "@/lib/errors";
import { bulkEdit, bulkMessage, bulkQuick, type BulkEntity } from "@/lib/bulk-edit";

const PATHS: Record<BulkEntity, string[]> = {
  activity: ["/activities", "/"], deal: ["/deals", "/pipelines"], person: ["/persons"], organization: ["/organizations", "/accounts"], lead: ["/leads"],
};
const refresh = (e: BulkEntity) => PATHS[e].forEach((p) => revalidatePath(p, p === "/pipelines" ? "layout" : "page"));

/** Edición en grupo: los campos elegidos en el panel, en todos los marcados. */
export async function bulkEditAction(entity: BulkEntity, ids: string[], data: Record<string, string>): Promise<{ error?: string; message?: string }> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    const r = await bulkEdit(g.actor, entity, ids, data);
    refresh(entity);
    return r.done === 0 && r.firstError ? { error: r.firstError } : { message: bulkMessage(entity, r) };
  } catch (err) { return { error: toUserMessage(err) }; }
}

/** Acciones rápidas en bloque (marcar hechas, borrar, archivar, papelera). */
export async function bulkQuickAction(entity: BulkEntity, op: string, ids: string[]): Promise<{ error?: string; message?: string }> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    const r = await bulkQuick(g.actor, entity, op, ids);
    refresh(entity);
    const verb = { complete: "marcad", delete: "borrad", archive: "archivad", reopen: "reabiert", trash: "movid" }[op] ?? "actualizad";
    const tail = op === "complete" ? (g: "a" | "o", pl: boolean) => `como hech${g}${pl ? "s" : ""}` : op === "trash" ? () => "a la papelera" : undefined;
    return r.done === 0 && r.firstError ? { error: r.firstError } : { message: bulkMessage(entity, r, verb, tail) };
  } catch (err) { return { error: toUserMessage(err) }; }
}
