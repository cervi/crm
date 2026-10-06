import { z } from "zod";
import { UserError } from "./errors";

// Acepta cualquier UUID (z.uuid() de zod 4 exige la versión RFC y rechaza
// identificadores válidos de PostgreSQL).
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const id = z.string().regex(UUID_RE, "Identificador no válido");
export const isId = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/** Convierte vacíos (null, "" o solo espacios) en undefined antes de validar. */
export const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (v) => (v === null || (typeof v === "string" && v.trim() === "") ? undefined : v),
    schema.optional(),
  );

export const text = (label: string, max = 500) =>
  z.string().trim().min(1, `${label} es obligatorio`).max(max, `${label} es demasiado largo`);

export const optText = (max = 2000) => optional(z.string().trim().max(max));
export const optId = optional(id);
export const optMoney = optional(z.coerce.number().min(0, "El importe no puede ser negativo"));
export const optDate = optional(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha no válida"));
export const optEmail = optional(z.string().trim().toLowerCase().pipe(z.email("Email no válido")));
export const checkbox = z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean());

/** Valida los campos de un FormData; lanza UserError con el primer problema. */
export function parseForm<T extends z.ZodTypeAny>(schema: T, form: FormData): z.infer<T> {
  return parse(schema, Object.fromEntries(form));
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) throw new UserError(result.error.issues[0]?.message ?? "Datos no válidos");
  return result.data;
}

/** Normaliza un dominio: sin protocolo, sin www, sin ruta, en minúsculas. */
export function normalizeDomain(input?: string | null): string | null {
  if (!input) return null;
  const d = input.trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

// Dominios de correo personal: no identifican a la empresa.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "outlook.com", "outlook.es",
  "live.com", "yahoo.com", "yahoo.es", "icloud.com", "me.com", "protonmail.com", "proton.me",
  "aol.com", "gmx.com", "gmx.es", "msn.com",
]);

export function companyDomainFromEmail(email?: string | null): string | null {
  const domain = email?.split("@")[1]?.toLowerCase();
  if (!domain || FREE_EMAIL_DOMAINS.has(domain)) return null;
  return normalizeDomain(domain);
}
