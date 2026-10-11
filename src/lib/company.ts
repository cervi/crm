import { sql } from "./db";
import { UserError } from "./errors";

// ===========================================================================
// Ajustes de empresa: nombre y logo (pantalla de entrada y correos), moneda y
// zona horaria por defecto.
// ===========================================================================

export type Company = { name: string | null; logo: string | null; currency: string; timezone: string };

export async function getCompany(): Promise<Company> {
  const [s] = await sql<{ company_name: string | null; company_logo: string | null; default_currency: string; company_timezone: string }[]>`
    SELECT company_name, company_logo, default_currency, company_timezone FROM app_settings LIMIT 1`.catch(() => []);
  return { name: s?.company_name ?? null, logo: s?.company_logo ?? null, currency: s?.default_currency?.trim() || "EUR", timezone: s?.company_timezone ?? "Europe/Madrid" };
}

const LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);   // sin SVG: podría llevar código

export async function saveCompany(form: FormData) {
  const name = String(form.get("company_name") ?? "").trim().slice(0, 80) || null;
  const currency = String(form.get("default_currency") ?? "EUR").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new UserError("Moneda no válida (p. ej. EUR, USD, MXN).");
  const tz = String(form.get("company_timezone") ?? "Europe/Madrid").trim();
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { throw new UserError("Zona horaria no válida."); }
  let logo: string | null | undefined;
  const file = form.get("logo");
  if (form.get("remove_logo") === "on") logo = null;
  else if (file instanceof File && file.size > 0) {
    if (!LOGO_TYPES.has(file.type)) throw new UserError("El logo tiene que ser PNG, JPG o WebP.");
    if (file.size > 300 * 1024) throw new UserError("El logo pesa demasiado (máximo 300 KB).");
    logo = `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
  }
  await sql`UPDATE app_settings SET company_name = ${name}, default_currency = ${currency}, company_timezone = ${tz},
                   company_logo = ${logo === undefined ? sql`company_logo` : logo}`;
}
