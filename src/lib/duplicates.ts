import { sql, type Db } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";
import { isId } from "./validation";

// ===========================================================================
// Duplicados de contactos y empresas: se detectan por nombre (normalizado) y
// se fusionan en uno. Todo lo que apuntaba al duplicado (deals, actividades,
// notas, correos, emails, teléfonos…) pasa al que se queda; el duplicado va a
// la papelera marcado como fusionado.
// ===========================================================================

type Kind = "person" | "organization";
const TABLE: Record<Kind, string> = { person: "persons", organization: "organizations" };

export type DupMember = { id: string; name: string; detail: string | null; deals: number; created_at: Date };
export type DupGroup = { key: string; members: DupMember[] };

/** Nombre normalizado: sin tildes, mayúsculas, puntuación ni formas societarias. */
const NORM = (col: string) => sql.unsafe(`
  trim(regexp_replace(regexp_replace(lower(translate(${col},
    'áàäâãéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ', 'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC')),
    '\\m(s\\.?\\s?l\\.?u?|s\\.?\\s?a\\.?|sl|sa|slu|inc|ltd|llc|gmbh|corp)\\M', '', 'g'), '[^a-z0-9]+', ' ', 'g'))`);

export async function findDuplicates(kind: Kind): Promise<DupGroup[]> {
  const rows = kind === "person"
    ? await sql<(DupMember & { key: string })[]>`
        SELECT ${NORM("p.full_name")} || '|' || coalesce(cur.organization_id::text, '') AS key,
               p.id, p.full_name AS name, p.created_at,
               concat_ws(' · ', (SELECT email FROM person_emails e WHERE e.person_id = p.id ORDER BY is_primary DESC LIMIT 1), o.name) AS detail,
               (SELECT count(*)::int FROM deal_participants dp WHERE dp.person_id = p.id) AS deals
        FROM persons p
        LEFT JOIN LATERAL (SELECT organization_id FROM person_organizations WHERE person_id = p.id AND status = 'current' LIMIT 1) cur ON true
        LEFT JOIN organizations o ON o.id = cur.organization_id
        WHERE p.deleted_at IS NULL AND length(${NORM("p.full_name")}) > 2`
    : await sql<(DupMember & { key: string })[]>`
        SELECT ${NORM("o.name")} AS key, o.id, o.name, o.created_at, concat_ws(' · ', o.domain, o.city) AS detail,
               (SELECT count(*)::int FROM deals d WHERE d.organization_id = o.id AND d.deleted_at IS NULL) AS deals
        FROM organizations o
        WHERE o.deleted_at IS NULL AND length(${NORM("o.name")}) > 1`;
  const groups = new Map<string, DupMember[]>();
  for (const r of rows) groups.set(r.key, [...(groups.get(r.key) ?? []), r]);
  return [...groups.entries()]
    .filter(([, m]) => m.length > 1)
    .map(([key, members]) => ({ key, members: members.sort((a, b) => b.deals - a.deals || +new Date(a.created_at) - +new Date(b.created_at)) }))
    .slice(0, 100);
}

/** Todas las columnas de otras tablas que apuntan a persons(id) u organizations(id). */
async function references(db: Db, table: string) {
  return db<{ table_name: string; column_name: string }[]>`
    SELECT kcu.table_name, kcu.column_name
    FROM information_schema.referential_constraints rc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = rc.constraint_name AND kcu.constraint_schema = rc.constraint_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name AND ccu.constraint_schema = rc.unique_constraint_schema
    WHERE ccu.table_name = ${table} AND ccu.column_name = 'id' AND kcu.table_schema = 'public'
      AND NOT (kcu.table_name = ${table} AND kcu.column_name = 'merged_into')`;
}

export async function merge(actor: Actor, kind: Kind, primaryId: string, duplicateIds: string[]) {
  const dups = [...new Set(duplicateIds)].filter((d) => isId(d) && d !== primaryId);
  if (!isId(primaryId) || dups.length === 0) throw new UserError("Elige cuál se queda y al menos un duplicado.");
  const table = TABLE[kind];
  await sql.begin(async (tx) => {
    const db = tx as unknown as Db & { savepoint: (f: (sp: Db) => Promise<unknown>) => Promise<unknown> };
    const [p] = await db`SELECT 1 FROM ${db(table)} WHERE id = ${primaryId} AND deleted_at IS NULL`;
    if (!p) throw new UserError("El que se queda ya no existe.");
    const refs = await references(db, table);
    for (const dup of dups) {
      if (kind === "person") {
        // El email y el teléfono principales siguen siendo los del que se queda.
        await db`UPDATE person_emails SET is_primary = false WHERE person_id = ${dup}`;
        await db`UPDATE person_phones SET is_primary = false WHERE person_id = ${dup}`;
        await db`UPDATE deal_participants SET is_primary = false
                 WHERE person_id = ${dup} AND deal_id IN (SELECT deal_id FROM deal_participants WHERE person_id = ${primaryId})`;
      }
      for (const r of refs) {
        const rows = await db<{ ctid: string }[]>`SELECT ctid::text FROM ${db(r.table_name)} WHERE ${db(r.column_name)} = ${dup}`;
        for (const row of rows) {
          // Fila a fila: si ya existe la misma para el que se queda (p. ej. el mismo deal), sobra.
          try {
            await db.savepoint((sp) => sp`UPDATE ${sp(r.table_name)} SET ${sp(r.column_name)} = ${primaryId} WHERE ctid = ${row.ctid}::tid`);
          } catch {
            await db`DELETE FROM ${db(r.table_name)} WHERE ctid = ${row.ctid}::tid`;
          }
        }
      }
      // Su historia también pasa al que se queda.
      await db`UPDATE events SET entity_id = ${primaryId} WHERE entity_type = ${kind} AND entity_id = ${dup}`;
      await db`UPDATE ${db(table)} SET deleted_at = now(), deleted_by = ${actor.id}, merged_into = ${primaryId} WHERE id = ${dup}`;
    }
    await recordEvent(db, actor, kind, primaryId, `${kind}.merged`, { merged: dups });
  });
}
