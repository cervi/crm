import { sql } from "./db";
import { UserError } from "./errors";
import type { SessionUser } from "./session";

// ===========================================================================
// Vistas guardadas de los listados (filtros + orden + columnas).
// ===========================================================================

export type ViewEntity = "deals" | "leads" | "organizations" | "persons" | "activities";
export type SavedView = { id: string; name: string; query: string; shared: boolean; mine: boolean };

/** Parámetros que se guardan en una vista (lo demás —el panel abierto, la página— no). */
const KEYS: Record<ViewEntity, string[]> = {
  deals: ["owner", "status", "sort", "dir", "q", "stage", "flag", "min", "max", "cols"],
  leads: ["status", "source", "q", "owner"],
  organizations: ["q", "owner"],
  persons: ["q", "owner"],
  activities: ["view", "owner", "type"],
};

/** Normaliza una consulta: solo las claves admitidas, en orden fijo (para compararlas). */
export function normalizeQuery(entity: ViewEntity, input: URLSearchParams | Record<string, string | undefined>): string {
  const get = (k: string) => (input instanceof URLSearchParams ? input.get(k) : input[k]) ?? "";
  const out = new URLSearchParams();
  for (const k of KEYS[entity]) {
    const v = get(k).trim();
    if (v) out.set(k, v.slice(0, 300));
  }
  return out.toString();
}

export async function listViews(entity: ViewEntity, userId: string): Promise<SavedView[]> {
  return sql<SavedView[]>`
    SELECT id, name, query, user_id IS NULL AS shared, user_id = ${userId} AS mine
    FROM saved_views WHERE entity = ${entity} AND (user_id IS NULL OR user_id = ${userId})
    ORDER BY (user_id IS NULL), position, created_at`;
}

export async function saveView(user: SessionUser, entity: ViewEntity, name: string, query: string, shared: boolean) {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new UserError("Ponle un nombre a la vista.");
  if (!(entity in KEYS)) throw new UserError("Listado no válido.");
  const q = normalizeQuery(entity, new URLSearchParams(query));
  const owner = shared ? null : user.id;
  const [dup] = await sql`SELECT 1 FROM saved_views WHERE entity = ${entity} AND lower(name) = lower(${clean})
                          AND user_id IS NOT DISTINCT FROM ${owner}`;
  if (dup) throw new UserError("Ya hay una vista con ese nombre.");
  const [{ next }] = await sql<{ next: number }[]>`SELECT coalesce(max(position), 0) + 1 AS next FROM saved_views WHERE entity = ${entity}`;
  await sql`INSERT INTO saved_views (entity, name, query, user_id, position, created_by)
            VALUES (${entity}, ${clean}, ${q}, ${owner}, ${next}, ${user.id})`;
}

export async function deleteView(user: SessionUser, viewId: string) {
  const [v] = await sql<{ user_id: string | null }[]>`SELECT user_id FROM saved_views WHERE id = ${viewId}`;
  if (!v) return;
  if (v.user_id ? v.user_id !== user.id : user.role !== "admin") {
    throw new UserError(v.user_id ? "Esa vista no es tuya." : "Solo un administrador puede borrar las vistas compartidas.");
  }
  await sql`DELETE FROM saved_views WHERE id = ${viewId}`;
}
