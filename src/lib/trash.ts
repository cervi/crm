import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";

// ===========================================================================
// Papelera: deals, leads, contactos y empresas borrados se pueden recuperar
// durante 30 días; después se eliminan del todo.
// ===========================================================================

export type TrashKind = "deal" | "lead" | "person" | "organization";
export const TRASH_DAYS = 30;
export const TRASH_LABELS: Record<TrashKind, string> = { deal: "Deal", lead: "Lead", person: "Contacto", organization: "Empresa" };
const TABLE: Record<TrashKind, string> = { deal: "deals", lead: "leads", person: "persons", organization: "organizations" };
const NAME: Record<TrashKind, string> = { deal: "title", lead: "title", person: "full_name", organization: "name" };

export const isTrashKind = (v: unknown): v is TrashKind => typeof v === "string" && v in TABLE;

export async function moveToTrash(actor: Actor, kind: TrashKind, id: string): Promise<string> {
  const [row] = await sql<{ name: string }[]>`
    UPDATE ${sql(TABLE[kind])} SET deleted_at = now(), deleted_by = ${actor.id}
    WHERE id = ${id} AND deleted_at IS NULL RETURNING ${sql(NAME[kind])} AS name`;
  if (!row) throw new UserError("Ya estaba borrado.");
  await recordEvent(sql, actor, kind, id, `${kind}.deleted`, { name: row.name });
  return row.name;
}

export async function restore(actor: Actor, kind: TrashKind, id: string) {
  const res = await sql`UPDATE ${sql(TABLE[kind])} SET deleted_at = NULL, deleted_by = NULL WHERE id = ${id} AND deleted_at IS NOT NULL`;
  if (res.count === 0) throw new UserError("No está en la papelera.");
  await recordEvent(sql, actor, kind, id, `${kind}.restored`, {});
}

export type TrashItem = { kind: TrashKind; id: string; name: string; deleted_at: Date; deleted_by: string | null };

export async function listTrash(): Promise<TrashItem[]> {
  return sql<TrashItem[]>`
    SELECT * FROM (
      SELECT 'deal' AS kind, d.id, d.title AS name, d.deleted_at, u.name AS deleted_by FROM deals d LEFT JOIN users u ON u.id = d.deleted_by WHERE d.deleted_at IS NOT NULL
      UNION ALL
      SELECT 'lead', l.id, l.title, l.deleted_at, u.name FROM leads l LEFT JOIN users u ON u.id = l.deleted_by WHERE l.deleted_at IS NOT NULL
      UNION ALL
      SELECT 'person', p.id, p.full_name, p.deleted_at, u.name FROM persons p LEFT JOIN users u ON u.id = p.deleted_by
        WHERE p.deleted_at IS NOT NULL AND p.merged_into IS NULL
      UNION ALL
      SELECT 'organization', o.id, o.name, o.deleted_at, u.name FROM organizations o LEFT JOIN users u ON u.id = o.deleted_by
        WHERE o.deleted_at IS NOT NULL AND o.merged_into IS NULL
    ) t ORDER BY deleted_at DESC LIMIT 500`;
}

/** Elimina del todo lo que lleva más de 30 días en la papelera. */
export async function purgeTrash(): Promise<number> {
  let n = 0;
  for (const kind of ["deal", "lead", "person", "organization"] as TrashKind[]) {
    const old = await sql<{ id: string }[]>`
      SELECT id FROM ${sql(TABLE[kind])} WHERE deleted_at < now() - make_interval(days => ${TRASH_DAYS}) LIMIT 200`;
    for (const r of old) {
      try {
        await sql.begin((tx) => tx`DELETE FROM ${tx(TABLE[kind])} WHERE id = ${r.id}`);
        n++;
      } catch {
        // Aún lo usa algo que no se puede borrar en cascada: se queda en la papelera.
      }
    }
  }
  return n;
}
