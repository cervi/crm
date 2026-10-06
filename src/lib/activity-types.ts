import { sql } from "./db";
import { UserError } from "./errors";
import { registerActivityTypes } from "./format";

// ===========================================================================
// Tipos de actividad configurables. Se guardan en memoria un minuto para que
// las etiquetas estén disponibles en todo el servidor (activityLabel).
// ===========================================================================

export type ActivityTypeRow = {
  key: string; label: string; is_session: boolean; is_active: boolean; is_builtin: boolean; position: number; usage: number;
};

let cache: { at: number; rows: ActivityTypeRow[] } | null = null;

/** Todos los tipos (activos e inactivos), en su orden. */
export async function activityTypes(force = false): Promise<ActivityTypeRow[]> {
  if (!cache || force || Date.now() - cache.at > 60_000) {
    const rows = await sql<ActivityTypeRow[]>`
      SELECT t.key, t.label, t.is_session, t.is_active, t.is_builtin, t.position,
             (SELECT count(*)::int FROM activities a WHERE a.type = t.key)
             + (SELECT count(*)::int FROM stages s WHERE s.required_activity_type = t.key) AS usage
      FROM activity_types t ORDER BY t.position, t.label`;
    registerActivityTypes(rows);
    cache = { at: Date.now(), rows };
  }
  return cache.rows;
}

/** Tipos que se pueden elegir al crear una actividad. */
export async function activeActivityTypes() {
  return (await activityTypes()).filter((t) => t.is_active);
}

/** Comprueba que el tipo existe y está activo (para validar formularios). */
export async function assertActivityType(key: string | null | undefined, allowInactive = false) {
  if (!key) return;
  const t = (await activityTypes()).find((x) => x.key === key);
  if (!t || (!t.is_active && !allowInactive)) throw new UserError("Tipo de actividad no válido.");
}

const slug = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

export async function createActivityType(data: Record<string, unknown>) {
  const label = String(data.label ?? "").trim();
  if (!label) throw new UserError("Indica el nombre del tipo.");
  if (label.length > 60) throw new UserError("El nombre es demasiado largo.");
  let key = slug(label);
  if (key.length < 2) key = `tipo_${Date.now().toString(36)}`;
  const existing = new Set((await activityTypes(true)).map((t) => t.key));
  for (let i = 2; existing.has(key); i++) key = `${slug(label).slice(0, 36)}_${i}`;
  await sql`
    INSERT INTO activity_types (key, label, is_session, position)
    VALUES (${key}, ${label}, ${data.is_session === "on"}, (SELECT coalesce(max(position), 0) + 1 FROM activity_types))`;
  await activityTypes(true);
  return key;
}

export async function updateActivityType(key: string, data: Record<string, unknown>) {
  const label = String(data.label ?? "").trim();
  if (!label) throw new UserError("Indica el nombre del tipo.");
  if (label.length > 60) throw new UserError("El nombre es demasiado largo.");
  const res = await sql`
    UPDATE activity_types SET label = ${label}, is_session = ${data.is_session === "on"}, is_active = ${data.is_active === "on"}
    WHERE key = ${key}`;
  if (res.count === 0) throw new UserError("El tipo no existe.");
  await activityTypes(true);
}

export async function moveActivityType(key: string, direction: "up" | "down") {
  const rows = await activityTypes(true);
  const i = rows.findIndex((t) => t.key === key);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return;
  await sql.begin(async (tx) => {
    await tx`UPDATE activity_types SET position = ${j} WHERE key = ${rows[i].key}`;
    await tx`UPDATE activity_types SET position = ${i} WHERE key = ${rows[j].key}`;
    for (const [n, r] of rows.entries()) if (n !== i && n !== j) await tx`UPDATE activity_types SET position = ${n} WHERE key = ${r.key}`;
  });
  await activityTypes(true);
}

/** Borra un tipo sin uso; si ya se usa, hay que desactivarlo (se conserva el histórico). */
export async function deleteActivityType(key: string) {
  const t = (await activityTypes(true)).find((x) => x.key === key);
  if (!t) return;
  if (t.is_builtin) throw new UserError("Los tipos de serie no se pueden borrar; puedes desactivarlos.");
  if (t.usage > 0) throw new UserError("Este tipo ya se usa en actividades o fases: desactívalo en lugar de borrarlo.");
  const [inRule] = await sql`SELECT 1 FROM automation_rules WHERE is_custom AND (trigger->>'activity_type' = ${key} OR action->>'activity_type' = ${key})`;
  if (inRule) throw new UserError("Este tipo se usa en una regla personalizada: cámbiala antes de borrarlo.");
  await sql`DELETE FROM activity_types WHERE key = ${key}`;
  await activityTypes(true);
}
