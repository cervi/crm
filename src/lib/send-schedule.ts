import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { zonedToUtc } from "./slots";
import { parse } from "./validation";

// ===========================================================================
// Horarios de envío (como los «sending schedules» de Apollo): franjas por día
// de la semana, en la hora local del contacto si se conoce su país, saltando
// festivos. Los correos automáticos solo salen dentro de una franja; las
// tareas se crean en cuanto tocan.
// ===========================================================================

export type Blocks = Record<string, [string, string][]>;   // "1".."7" → [["09:00","18:00"], …]
export type SendSchedule = {
  id: string; name: string; timezone: string; use_contact_tz: boolean; blocks: Blocks; skip_holidays: boolean;
  holidays: string[]; is_default: boolean;
};

export const WEEKDAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

/** Festivos nacionales de España (los autonómicos y locales se añaden en cada horario). */
const NATIONAL_HOLIDAYS = [
  "2026-01-01", "2026-01-06", "2026-04-03", "2026-05-01", "2026-08-15", "2026-10-12", "2026-11-01", "2026-12-06", "2026-12-08", "2026-12-25",
  "2027-01-01", "2027-01-06", "2027-03-26", "2027-05-01", "2027-08-15", "2027-10-12", "2027-11-01", "2027-12-06", "2027-12-08", "2027-12-25",
  "2028-01-01", "2028-01-06", "2028-04-14", "2028-05-01", "2028-08-15", "2028-10-12", "2028-11-01", "2028-12-06", "2028-12-08", "2028-12-25",
];

/** Zona horaria principal de un país (por código ISO o por nombre en español o inglés). */
const COUNTRY_TZ: Record<string, string> = {
  es: "Europe/Madrid", españa: "Europe/Madrid", spain: "Europe/Madrid",
  pt: "Europe/Lisbon", portugal: "Europe/Lisbon",
  fr: "Europe/Paris", francia: "Europe/Paris", france: "Europe/Paris",
  de: "Europe/Berlin", alemania: "Europe/Berlin", germany: "Europe/Berlin",
  it: "Europe/Rome", italia: "Europe/Rome", italy: "Europe/Rome",
  gb: "Europe/London", uk: "Europe/London", "reino unido": "Europe/London", "united kingdom": "Europe/London", irlanda: "Europe/Dublin", ie: "Europe/Dublin", ireland: "Europe/Dublin",
  nl: "Europe/Amsterdam", "países bajos": "Europe/Amsterdam", holanda: "Europe/Amsterdam", netherlands: "Europe/Amsterdam",
  be: "Europe/Brussels", bélgica: "Europe/Brussels", belgium: "Europe/Brussels", ch: "Europe/Zurich", suiza: "Europe/Zurich", switzerland: "Europe/Zurich",
  at: "Europe/Vienna", austria: "Europe/Vienna", pl: "Europe/Warsaw", polonia: "Europe/Warsaw", poland: "Europe/Warsaw",
  se: "Europe/Stockholm", suecia: "Europe/Stockholm", dk: "Europe/Copenhagen", dinamarca: "Europe/Copenhagen", no: "Europe/Oslo", noruega: "Europe/Oslo",
  fi: "Europe/Helsinki", finlandia: "Europe/Helsinki", gr: "Europe/Athens", grecia: "Europe/Athens",
  mx: "America/Mexico_City", méxico: "America/Mexico_City", mexico: "America/Mexico_City",
  ar: "America/Argentina/Buenos_Aires", argentina: "America/Argentina/Buenos_Aires",
  co: "America/Bogota", colombia: "America/Bogota", cl: "America/Santiago", chile: "America/Santiago",
  pe: "America/Lima", perú: "America/Lima", peru: "America/Lima", ec: "America/Guayaquil", ecuador: "America/Guayaquil",
  uy: "America/Montevideo", uruguay: "America/Montevideo", py: "America/Asuncion", paraguay: "America/Asuncion",
  bo: "America/La_Paz", bolivia: "America/La_Paz", ve: "America/Caracas", venezuela: "America/Caracas",
  cr: "America/Costa_Rica", "costa rica": "America/Costa_Rica", pa: "America/Panama", panamá: "America/Panama", panama: "America/Panama",
  gt: "America/Guatemala", guatemala: "America/Guatemala", do: "America/Santo_Domingo", "república dominicana": "America/Santo_Domingo",
  pr: "America/Puerto_Rico", "puerto rico": "America/Puerto_Rico",
  br: "America/Sao_Paulo", brasil: "America/Sao_Paulo", brazil: "America/Sao_Paulo",
  us: "America/New_York", usa: "America/New_York", "estados unidos": "America/New_York", "united states": "America/New_York", eeuu: "America/New_York",
  ca: "America/Toronto", canadá: "America/Toronto", canada: "America/Toronto",
  ma: "Africa/Casablanca", marruecos: "Africa/Casablanca", morocco: "Africa/Casablanca",
  ae: "Asia/Dubai", "emiratos árabes unidos": "Asia/Dubai", uae: "Asia/Dubai", in: "Asia/Kolkata", india: "Asia/Kolkata",
  sg: "Asia/Singapore", singapur: "Asia/Singapore", singapore: "Asia/Singapore", jp: "Asia/Tokyo", japón: "Asia/Tokyo", japan: "Asia/Tokyo",
  au: "Australia/Sydney", australia: "Australia/Sydney",
};

export function countryTz(country: string | null | undefined): string | null {
  const k = (country ?? "").trim().toLowerCase();
  return k ? COUNTRY_TZ[k] ?? null : null;
}

/** Zona horaria del contacto, por el país de su empresa actual. */
export async function contactTz(personId: string): Promise<string | null> {
  const [r] = await sql<{ country: string | null }[]>`
    SELECT o.country FROM person_organizations po JOIN organizations o ON o.id = po.organization_id
    WHERE po.person_id = ${personId} AND po.status = 'current' ORDER BY po.created_at DESC LIMIT 1`;
  return countryTz(r?.country);
}

export async function listSchedules(): Promise<SendSchedule[]> {
  return sql<SendSchedule[]>`
    SELECT id, name, timezone, use_contact_tz, blocks, skip_holidays, holidays::text[] AS holidays, is_default
    FROM send_schedules ORDER BY is_default DESC, lower(name)`;
}

export async function getSchedule(id: string | null | undefined): Promise<SendSchedule> {
  const [s] = await sql<SendSchedule[]>`
    SELECT id, name, timezone, use_contact_tz, blocks, skip_holidays, holidays::text[] AS holidays, is_default
    FROM send_schedules WHERE ${id ? sql`id = ${id}` : sql`is_default`} ORDER BY is_default DESC LIMIT 1`;
  if (s) return s;
  const [d] = await sql<SendSchedule[]>`
    SELECT id, name, timezone, use_contact_tz, blocks, skip_holidays, holidays::text[] AS holidays, is_default
    FROM send_schedules ORDER BY is_default DESC LIMIT 1`;
  return d ?? { id: "", name: "Horario laboral", timezone: process.env.TZ || "Europe/Madrid", use_contact_tz: true,
                blocks: { 1: [["09:00", "18:00"]], 2: [["09:00", "18:00"]], 3: [["09:00", "18:00"]], 4: [["09:00", "18:00"]], 5: [["09:00", "15:00"]] },
                skip_holidays: true, holidays: [], is_default: true };
}

const hm = (s: string) => { const [h, m] = s.split(":").map(Number); return { h: h || 0, m: m || 0 }; };

function localDay(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), wd: ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[p.weekday as string] ?? 1,
           iso: `${p.year}-${p.month}-${p.day}` };
}

/** Zona en la que se aplican las franjas para un contacto. */
export const scheduleTz = (s: SendSchedule, contact: string | null | undefined) => (s.use_contact_tz && contact ? contact : s.timezone);

/**
 * Siguiente momento en el que puede salir un correo automático (ahora mismo
 * si ya estamos dentro de una franja). Mira hasta tres semanas por delante.
 */
export function nextSlot(s: SendSchedule, contactZone: string | null | undefined, now = new Date()): Date {
  const tz = scheduleTz(s, contactZone);
  const holidays = new Set([...(s.skip_holidays ? NATIONAL_HOLIDAYS : []), ...s.holidays]);
  for (let i = 0; i < 21; i++) {
    const day = localDay(new Date(now.getTime() + i * 86400000), tz);
    if (holidays.has(day.iso)) continue;
    const blocks = [...(s.blocks[String(day.wd)] ?? [])].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [from, to] of blocks) {
      const a = hm(from), b = hm(to);
      const start = zonedToUtc(day.y, day.m, day.d, a.h, a.m, tz);
      const end = zonedToUtc(day.y, day.m, day.d, b.h, b.m, tz);
      if (end <= now) continue;
      // Pequeño margen aleatorio al abrir la franja: que no salgan todos a la misma hora en punto.
      return start > now ? new Date(start.getTime() + Math.floor(Math.random() * 20) * 60000) : now;
    }
  }
  return new Date(now.getTime() + 86400000);
}

/** Fin del día laborable de hoy en esa zona (vencimiento de las tareas de la secuencia). */
export function endOfDay(tz: string, now = new Date()) {
  const d = localDay(now, tz);
  return zonedToUtc(d.y, d.m, d.d, 23, 59, tz);
}

// ---------------------------------------------------------------------------
// Edición

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function saveSchedule(id: string | null, form: FormData): Promise<string> {
  const v = parse(z.object({
    name: z.string().trim().min(1, "Ponle un nombre").max(80),
    timezone: z.string().trim().min(1),
    use_contact_tz: z.string().optional(),
    skip_holidays: z.string().optional(),
    holidays: z.string().optional(),
    is_default: z.string().optional(),
  }), Object.fromEntries(form));
  try { new Intl.DateTimeFormat("en", { timeZone: v.timezone }); } catch { throw new UserError("Zona horaria no válida."); }
  const blocks: Blocks = {};
  for (let wd = 1; wd <= 7; wd++) {
    const froms = form.getAll(`from_${wd}`).map(String), tos = form.getAll(`to_${wd}`).map(String);
    const list: [string, string][] = [];
    froms.forEach((f, i) => {
      const t = tos[i] ?? "";
      if (!f && !t) return;
      if (!TIME.test(f) || !TIME.test(t)) throw new UserError(`${WEEKDAYS[wd - 1]}: escribe las horas como 09:00.`);
      if (t <= f) throw new UserError(`${WEEKDAYS[wd - 1]}: la hora de fin debe ser posterior a la de inicio.`);
      list.push([f, t]);
    });
    if (list.length) blocks[String(wd)] = list.sort((a, b) => a[0].localeCompare(b[0]));
  }
  if (!Object.keys(blocks).length) throw new UserError("Añade al menos una franja de envío.");
  const holidays = (v.holidays ?? "").split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  for (const h of holidays) if (!/^\d{4}-\d{2}-\d{2}$/.test(h)) throw new UserError(`Fecha de festivo no válida: ${h} (usa 2026-12-24).`);
  const row = {
    name: v.name, timezone: v.timezone, use_contact_tz: v.use_contact_tz === "on", skip_holidays: v.skip_holidays === "on",
    blocks: sql.json(blocks), holidays,
  };
  return sql.begin(async (tx) => {
    if (v.is_default === "on") await tx`UPDATE send_schedules SET is_default = false WHERE is_default`;
    if (id) {
      const r = await tx`UPDATE send_schedules SET ${tx(row as never)}, is_default = is_default OR ${v.is_default === "on"} WHERE id = ${id} RETURNING id`;
      if (!r.length) throw new UserError("Ese horario ya no existe.");
      return id;
    }
    const [n] = await tx<{ id: string }[]>`INSERT INTO send_schedules ${tx({ ...row, is_default: v.is_default === "on" } as never)} RETURNING id`;
    return n.id;
  }) as Promise<string>;
}

export async function deleteSchedule(id: string) {
  const [s] = await sql<{ is_default: boolean }[]>`SELECT is_default FROM send_schedules WHERE id = ${id}`;
  if (!s) return;
  if (s.is_default) throw new UserError("Es el horario por defecto: marca otro como predeterminado antes de borrarlo.");
  await sql`DELETE FROM send_schedules WHERE id = ${id}`;   // las secuencias que lo usaban pasan al predeterminado
}

/** Texto corto: «L–J 09:00–18:00 · V 09:00–15:00 · hora del contacto». */
export function describeSchedule(s: SendSchedule) {
  const short = ["L", "M", "X", "J", "V", "S", "D"];
  const groups: { days: number[]; text: string }[] = [];
  for (let wd = 1; wd <= 7; wd++) {
    const text = (s.blocks[String(wd)] ?? []).map(([a, b]) => `${a}–${b}`).join(", ");
    if (!text) continue;
    const last = groups[groups.length - 1];
    if (last && last.text === text && last.days[last.days.length - 1] === wd - 1) last.days.push(wd);
    else groups.push({ days: [wd], text });
  }
  const g = groups.map((x) => `${x.days.length > 1 ? `${short[x.days[0] - 1]}–${short[x.days[x.days.length - 1] - 1]}` : short[x.days[0] - 1]} ${x.text}`).join(" · ");
  return `${g}${s.use_contact_tz ? " · hora del contacto" : ` · ${s.timezone}`}${s.skip_holidays ? " · sin festivos" : ""}`;
}
