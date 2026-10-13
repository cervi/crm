import { sql, transaction } from "./db";
import { activeActivityTypes } from "./activity-types";
import { completeActivity, deleteActivity, reopenActivity } from "./activities";
import { coerce, listFieldDefinitions, type FieldDefinition } from "./custom-fields";
import { getCompany } from "./company";
import { moveDealToStage } from "./deals";
import { DEAL_TYPE_LABEL, ORIGIN_LABEL } from "./deal-types";
import { UserError, toUserMessage } from "./errors";
import { recordEvent, type Actor } from "./events";
import { moveToTrash } from "./trash";
import { UUID_RE } from "./validation";

// ===========================================================================
// Edición en grupo (como en Pipedrive): en cada tabla se marcan varios
// registros y se cambian a la vez los campos que se quieran. Cada campo empieza
// en «Mantener el valor actual». Solo se tocan los campos de esta lista; cada
// registro queda con su apunte en la historia.
// ===========================================================================

export type BulkEntity = "activity" | "deal" | "person" | "organization" | "lead";
export type BulkFieldKind = "select" | "date" | "time" | "number" | "text";
export type BulkField = {
  key: string; label: string; kind: BulkFieldKind; options?: { value: string; label: string }[];
  clearable?: boolean; help?: string;
};

const MAX = 500;
const CUSTOM = "cf_";
const COLUMN_TABLE: Record<BulkEntity, string> = { activity: "activities", deal: "deals", person: "persons", organization: "organizations", lead: "leads" };
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "MXN", "COP", "ARS", "CLP", "PEN", "BRL", "PLN"];

async function users() {
  return (await sql<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE kind = 'human' AND is_active ORDER BY name`)
    .map((u) => ({ value: u.id, label: u.name }));
}

/** Campos personalizados que se pueden poner en grupo (los de varias opciones o usuario, como opción única). */
function customFields(defs: FieldDefinition[], people: { value: string; label: string }[]): BulkField[] {
  return defs.filter((d) => !d.is_archived && d.field_type !== "long_text").map((d) => {
    const base = { key: `${CUSTOM}${d.key}`, label: d.label, clearable: !d.is_required };
    switch (d.field_type) {
      case "single_option": case "multi_option": return { ...base, kind: "select" as const, options: (d.options ?? []).map((o) => ({ value: o.key, label: o.label })) };
      case "boolean": return { ...base, kind: "select" as const, options: [{ value: "true", label: "Sí" }, { value: "false", label: "No" }] };
      case "user": return { ...base, kind: "select" as const, options: people };
      case "number": case "money": return { ...base, kind: "number" as const };
      case "date": return { ...base, kind: "date" as const };
      default: return { ...base, kind: "text" as const };
    }
  });
}

/** Los campos que ofrece el panel «Editar en grupo» de cada tabla. */
export async function bulkFields(entity: BulkEntity): Promise<BulkField[]> {
  const people = await users();
  const owner: BulkField = { key: "owner_id", label: "Responsable", kind: "select", options: people, clearable: true };
  switch (entity) {
    case "activity": {
      const types = await activeActivityTypes();
      return [
        { key: "type", label: "Tipo", kind: "select", options: types.map((t) => ({ value: t.key, label: t.label })) },
        owner,
        { key: "due_date", label: "Fecha de vencimiento", kind: "date", help: "Mantiene la hora de cada una." },
        { key: "due_time", label: "Hora de vencimiento", kind: "time", help: "Mantiene el día de cada una." },
        { key: "postpone", label: "Posponer", kind: "number", help: "Días que se mueve cada una (negativo, para adelantar)." },
        { key: "duration_minutes", label: "Duración (minutos)", kind: "number", clearable: true },
        { key: "priority", label: "Prioridad", kind: "select", clearable: true, options: [{ value: "high", label: "Alta" }, { value: "medium", label: "Media" }, { value: "low", label: "Baja" }] },
        { key: "done", label: "Estado", kind: "select", options: [{ value: "true", label: "Hecha" }, { value: "false", label: "Pendiente" }] },
      ];
    }
    case "deal": {
      const stages = await sql<{ id: string; name: string; pipeline: string }[]>`
        SELECT s.id, s.name, p.name AS pipeline FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
        WHERE s.is_active AND p.is_active ORDER BY p.position, s.position`;
      return [
        owner,
        { key: "stage_id", label: "Fase", kind: "select", options: stages.map((s) => ({ value: s.id, label: `${s.pipeline} · ${s.name}` })) },
        { key: "expected_close_date", label: "Cierre previsto", kind: "date", clearable: true },
        { key: "value", label: "Importe", kind: "number", clearable: true },
        { key: "currency", label: "Moneda", kind: "select", options: CURRENCIES.map((c) => ({ value: c, label: c })) },
        { key: "source", label: "Origen", kind: "text", clearable: true },
        { key: "deal_type", label: "Tipo de deal", kind: "select", options: Object.entries(DEAL_TYPE_LABEL).map(([value, label]) => ({ value, label })) },
        { key: "origin", label: "Lo trajo", kind: "select", options: Object.entries(ORIGIN_LABEL).map(([value, label]) => ({ value, label })) },
        ...customFields(await listFieldDefinitions("deal"), people),
      ];
    }
    case "person":
      return [
        owner,
        { key: "marketing_consent", label: "Acepta comunicaciones comerciales", kind: "select", options: [{ value: "true", label: "Sí" }, { value: "false", label: "No" }] },
        ...customFields(await listFieldDefinitions("person"), people),
      ];
    case "organization":
      return [
        owner,
        { key: "cs_owner_id", label: "Responsable de cliente (CS)", kind: "select", options: people, clearable: true },
        { key: "industry", label: "Sector", kind: "text", clearable: true },
        { key: "country", label: "País", kind: "text", clearable: true },
        { key: "city", label: "Ciudad", kind: "text", clearable: true },
        { key: "employee_count", label: "Empleados", kind: "number", clearable: true },
        ...customFields(await listFieldDefinitions("organization"), people),
      ];
    case "lead":
      return [
        owner,
        { key: "source", label: "Origen", kind: "text", clearable: true },
        { key: "source_detail", label: "Contenido de origen", kind: "text", clearable: true },
        { key: "funnel_stage", label: "Etapa del embudo", kind: "select", clearable: true, options: [{ value: "tofu", label: "TOFU" }, { value: "mofu", label: "MOFU" }, { value: "bofu", label: "BOFU" }] },
        { key: "status", label: "Estado", kind: "select", options: [{ value: "open", label: "Abierto" }, { value: "archived", label: "Archivado" }] },
        ...customFields(await listFieldDefinitions("lead"), people),
      ];
  }
}

export type BulkResult = { done: number; skipped: number; firstError: string | null };

function idsOf(ids: unknown): string[] {
  const list = Array.isArray(ids) ? [...new Set(ids.filter((x): x is string => typeof x === "string" && UUID_RE.test(x)))] : [];
  if (!list.length) throw new UserError("No hay nada seleccionado.");
  if (list.length > MAX) throw new UserError(`Como mucho ${MAX} a la vez.`);
  return list;
}

type Change = { field: BulkField; clear: boolean; value: unknown };

/** Lee del formulario qué campos cambian («m_<campo>» = keep | set | clear, «v_<campo>» = valor) y los valida. */
async function readChanges(entity: BulkEntity, data: Record<string, string>): Promise<Change[]> {
  const fields = await bulkFields(entity);
  const defs = entity === "activity" ? [] : await listFieldDefinitions(entity);
  const out: Change[] = [];
  for (const f of fields) {
    const mode = data[`m_${f.key}`] ?? "keep";
    if (mode === "keep") continue;
    if (mode === "clear") {
      if (!f.clearable) throw new UserError(`«${f.label}» no se puede dejar vacío.`);
      out.push({ field: f, clear: true, value: null });
      continue;
    }
    const raw = String(data[`v_${f.key}`] ?? "").trim();
    if (!raw) throw new UserError(`Indica el nuevo valor de «${f.label}» (o déjalo en «Mantener el valor actual»).`);
    let value: unknown = raw;
    if (f.key.startsWith(CUSTOM)) {
      const def = defs.find((d) => `${CUSTOM}${d.key}` === f.key)!;
      value = def.field_type === "boolean" ? raw === "true" : def.field_type === "multi_option" ? [raw] : coerce(def, raw);
    } else if (f.kind === "select") {
      if (!f.options?.some((o) => o.value === raw)) throw new UserError(`«${f.label}»: opción no válida.`);
      if (raw === "true" || raw === "false") value = raw === "true";
    } else if (f.kind === "number") {
      const n = Number(raw.replace(",", "."));
      if (!Number.isFinite(n)) throw new UserError(`«${f.label}» debe ser un número.`);
      if (f.key !== "postpone" && n < 0) throw new UserError(`«${f.label}» no puede ser negativo.`);
      value = f.key === "value" ? n : Math.round(n);
    } else if (f.kind === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new UserError(`«${f.label}»: fecha no válida.`);
    } else if (f.kind === "time") {
      if (!/^\d{2}:\d{2}$/.test(raw)) throw new UserError(`«${f.label}»: hora no válida.`);
    } else if (raw.length > 300) throw new UserError(`«${f.label}» es demasiado largo.`);
    out.push({ field: f, clear: false, value });
  }
  if (!out.length) throw new UserError("No has cambiado ningún campo: elige al menos uno.");
  return out;
}

/** Aplica la edición en grupo a cada registro marcado. */
export async function bulkEdit(actor: Actor, entity: BulkEntity, ids: unknown, data: Record<string, string>): Promise<BulkResult> {
  const list = idsOf(ids);
  const changes = await readChanges(entity, data);
  const table = COLUMN_TABLE[entity];
  const tz = (await getCompany()).timezone || "Europe/Madrid";
  const labels = changes.map((c) => c.field.label);
  let done = 0, skipped = 0, firstError: string | null = null;

  for (const rid of list) {
    try {
      // Fase y estado de una actividad pasan por su propia lógica (historia, reglas…).
      const special = changes.filter((c) => ["stage_id", "done"].includes(c.field.key));
      const plain = changes.filter((c) => !special.includes(c) && !["due_date", "due_time", "postpone"].includes(c.field.key) && !c.field.key.startsWith(CUSTOM));
      const custom = changes.filter((c) => c.field.key.startsWith(CUSTOM));
      const when = changes.filter((c) => ["due_date", "due_time", "postpone"].includes(c.field.key));

      await transaction(async (tx) => {
        const [exists] = await tx`SELECT 1 FROM ${tx(table)} WHERE id = ${rid} ${entity === "activity" ? tx`` : tx`AND deleted_at IS NULL`} FOR UPDATE`;
        if (!exists) throw new UserError("Ya no existe.");
        if (plain.length) {
          const set: Record<string, unknown> = {};
          for (const c of plain) set[c.field.key] = c.clear ? null : c.value;
          await tx`UPDATE ${tx(table)} SET ${tx(set as Record<string, never>)} WHERE id = ${rid}`;
          // Al cambiar el responsable de un deal, sus actividades pendientes pasan al nuevo.
          if (entity === "deal" && "owner_id" in set) {
            await tx`UPDATE activities SET owner_id = ${set.owner_id as string | null} WHERE deal_id = ${rid} AND NOT done`;
          }
        }
        for (const c of custom) {
          const key = c.field.key.slice(CUSTOM.length);
          if (c.clear) await tx`UPDATE ${tx(table)} SET custom = custom - ${key} WHERE id = ${rid}`;
          else await tx`UPDATE ${tx(table)} SET custom = custom || ${tx.json({ [key]: c.value } as never)} WHERE id = ${rid}`;
        }
        for (const c of when) {
          if (c.field.key === "postpone") {
            await tx`UPDATE activities SET due_at = coalesce(due_at, now()) + make_interval(days => ${c.value as number}) WHERE id = ${rid}`;
          } else if (c.field.key === "due_date") {
            await tx`UPDATE activities SET due_at = ((${c.value as string}::date + coalesce((due_at AT TIME ZONE ${tz})::time, '09:00'::time)) AT TIME ZONE ${tz}) WHERE id = ${rid}`;
          } else {
            await tx`UPDATE activities SET due_at = ((coalesce((due_at AT TIME ZONE ${tz})::date, (now() AT TIME ZONE ${tz})::date) + ${c.value as string}::time) AT TIME ZONE ${tz}) WHERE id = ${rid}`;
          }
        }
        if (plain.length || custom.length || when.length) {
          await recordEvent(tx, actor, entity, rid, `${entity}.updated`, { changed: labels, bulk: true });
        }
      });
      for (const c of special) {
        if (c.field.key === "stage_id") {
          const [d] = await sql<{ stage_id: string }[]>`SELECT stage_id FROM deals WHERE id = ${rid}`;
          if (d?.stage_id !== c.value) await moveDealToStage(actor, rid, c.value as string);
        } else if (c.value === true) await completeActivity(actor, rid, {});
        else await reopenActivity(rid);
      }
      done++;
    } catch (err) { skipped++; firstError ??= toUserMessage(err); }
  }
  return { done, skipped, firstError };
}

/** Acciones rápidas que no son «editar un campo»: marcar como hechas, borrar, archivar, papelera. */
export async function bulkQuick(actor: Actor, entity: BulkEntity, op: string, ids: unknown): Promise<BulkResult> {
  const list = idsOf(ids);
  let done = 0, skipped = 0, firstError: string | null = null;
  for (const rid of list) {
    try {
      if (entity === "activity" && op === "complete") {
        const [a] = await sql<{ done: boolean }[]>`SELECT done FROM activities WHERE id = ${rid}`;
        if (!a || a.done) { skipped++; continue; }
        await completeActivity(actor, rid, {});
      } else if (entity === "activity" && op === "delete") {
        await deleteActivity(actor, rid);
      } else if (entity === "lead" && (op === "archive" || op === "reopen")) {
        const r = await sql`UPDATE leads SET status = ${op === "archive" ? "archived" : "open"} WHERE id = ${rid} AND status <> 'converted' AND deleted_at IS NULL`;
        if (!r.count) { skipped++; continue; }
        await recordEvent(sql, actor, "lead", rid, "lead.updated", { status: op === "archive" ? "archived" : "open", bulk: true });
      } else if (op === "trash" && entity !== "activity") {
        await moveToTrash(actor, entity, rid);
      } else throw new UserError("Acción no válida.");
      done++;
    } catch (err) { skipped++; firstError ??= toUserMessage(err); }
  }
  return { done, skipped, firstError };
}

const NOUN: Record<BulkEntity, [string, string, "a" | "o"]> = {
  activity: ["actividad", "actividades", "a"], deal: ["deal", "deals", "o"], person: ["contacto", "contactos", "o"],
  organization: ["empresa", "empresas", "a"], lead: ["lead", "leads", "o"],
};
export function bulkMessage(entity: BulkEntity, r: BulkResult, verb = "actualizad", tail?: (g: "a" | "o", plural: boolean) => string): string {
  const [one, many, g] = NOUN[entity];
  const plural = r.done !== 1;
  const parts = [`${r.done} ${plural ? many : one} ${verb}${g}${plural ? "s" : ""}${tail ? ` ${tail(g, plural)}` : ""}`];
  if (r.skipped) parts.push(`${r.skipped} sin cambios${r.firstError ? ` (${r.firstError.replace(/\.$/, "")})` : ""}`);
  return `${parts.join(", ")}.`;
}
