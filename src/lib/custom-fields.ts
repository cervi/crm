import { sql, type Db } from "./db";
import { UserError } from "./errors";

export type CustomEntity = "organization" | "person" | "lead" | "deal";
export type FieldType =
  | "text" | "long_text" | "number" | "money" | "date" | "datetime" | "boolean"
  | "single_option" | "multi_option" | "user" | "url" | "email" | "phone";

export const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: "text", label: "Texto" },
  { value: "long_text", label: "Texto largo" },
  { value: "number", label: "Número" },
  { value: "money", label: "Importe" },
  { value: "date", label: "Fecha" },
  { value: "datetime", label: "Fecha y hora" },
  { value: "boolean", label: "Sí / no" },
  { value: "single_option", label: "Opción única" },
  { value: "multi_option", label: "Varias opciones" },
  { value: "user", label: "Usuario" },
  { value: "url", label: "Enlace" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Teléfono" },
];

export const ENTITY_LABELS: Record<CustomEntity, string> = {
  organization: "Empresas",
  person: "Contactos",
  lead: "Leads",
  deal: "Deals",
};

export type FieldOption = { key: string; label: string };
export type FieldDefinition = {
  id: string;
  entity_type: CustomEntity;
  key: string;
  label: string;
  field_type: FieldType;
  options: FieldOption[] | null;
  is_required: boolean;
  position: number;
  is_archived: boolean;
};

export async function listFieldDefinitions(entity: CustomEntity, includeArchived = false, db: Db = sql) {
  return db<FieldDefinition[]>`
    SELECT id, entity_type, key, label, field_type, options, is_required, position, is_archived
    FROM custom_field_definitions
    WHERE entity_type = ${entity} AND (${includeArchived} OR NOT is_archived)
    ORDER BY position, label`;
}

/** Nombre del input de formulario para un campo personalizado. */
export const inputName = (def: Pick<FieldDefinition, "key">) => `cf_${def.key}`;

/**
 * Lee y valida los valores de los campos personalizados de un formulario.
 * Devuelve el objeto a guardar en la columna `custom` (solo campos activos;
 * conserva los valores de campos archivados que ya existían).
 */
export function readCustomValues(
  defs: FieldDefinition[],
  form: FormData,
  previous: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...previous };
  for (const def of defs) {
    if (def.is_archived) continue;
    const name = inputName(def);
    let value: unknown;

    if (def.field_type === "multi_option") {
      const allowed = new Set((def.options ?? []).map((o) => o.key));
      const picked = form.getAll(name).map(String).filter((v) => allowed.has(v));
      value = picked.length ? picked : undefined;
    } else if (def.field_type === "boolean") {
      value = form.get(name) === "on";
    } else {
      const raw = String(form.get(name) ?? "").trim();
      value = raw === "" ? undefined : coerce(def, raw);
    }

    if (value === undefined) {
      if (def.is_required) throw new UserError(`El campo «${def.label}» es obligatorio.`);
      delete out[def.key];
    } else {
      out[def.key] = value;
    }
  }
  return out;
}

function coerce(def: FieldDefinition, raw: string): unknown {
  const fail = (what: string) => new UserError(`«${def.label}»: ${what}.`);
  switch (def.field_type) {
    case "number":
    case "money": {
      const n = Number(raw.replace(",", "."));
      if (!Number.isFinite(n)) throw fail("debe ser un número");
      return n;
    }
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw fail("fecha no válida");
      return raw;
    case "datetime":
      if (Number.isNaN(Date.parse(raw))) throw fail("fecha y hora no válidas");
      return raw;
    case "single_option":
      if (!(def.options ?? []).some((o) => o.key === raw)) throw fail("opción no válida");
      return raw;
    case "email":
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw fail("email no válido");
      return raw.toLowerCase();
    case "url":
      try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString(); }
      catch { throw fail("enlace no válido"); }
    default:
      if (raw.length > 5000) throw fail("demasiado largo");
      return raw;
  }
}

/** Texto para mostrar un valor de campo personalizado. */
export function formatCustomValue(def: FieldDefinition, value: unknown, users: { id: string; name: string }[] = []): string {
  if (value === undefined || value === null || value === "") return "—";
  const optLabel = (k: unknown) => def.options?.find((o) => o.key === k)?.label ?? String(k);
  switch (def.field_type) {
    case "boolean": return value ? "Sí" : "No";
    case "single_option": return optLabel(value);
    case "multi_option": return Array.isArray(value) ? value.map(optLabel).join(", ") : "—";
    case "money": return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(Number(value));
    case "number": return new Intl.NumberFormat("es-ES").format(Number(value));
    case "date": return new Date(`${value}T00:00:00`).toLocaleDateString("es-ES");
    case "datetime": return new Date(String(value)).toLocaleString("es-ES");
    case "user": return users.find((u) => u.id === value)?.name ?? "—";
    default: return String(value);
  }
}

// ---------------------------------------------------------------------------
// Administración de definiciones

export function slugifyKey(label: string): string {
  const base = label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  return /^[a-z]/.test(base) ? base : `campo_${base || "nuevo"}`;
}

/** Convierte un texto con una opción por línea en la lista de opciones. */
export function parseOptions(text: string): FieldOption[] {
  const seen = new Set<string>();
  const out: FieldOption[] = [];
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    let key = slugifyKey(line);
    while (seen.has(key)) key = `${key}_2`;
    seen.add(key);
    out.push({ key, label: line });
  }
  return out;
}
