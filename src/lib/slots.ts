// Cálculo de huecos libres a partir de lo ocupado en el calendario.
// Sin dependencias: las zonas horarias se resuelven con Intl.

export type Scheduling = {
  days: number[];        // 1 = lunes … 7 = domingo
  start: string;         // "09:00"
  end: string;           // "18:00"
  duration: number;      // minutos de la reunión
  buffer: number;        // minutos libres antes y después
  notice_hours: number;  // antelación mínima
  horizon_days: number;  // cuántos días mirar
  count: number;         // cuántos huecos ofrecer
  per_day: number;       // máximo por día (para repartirlos)
  timezone: string;      // IANA, p. ej. Europe/Madrid
};

export const DEFAULT_SCHEDULING: Scheduling = {
  days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00", duration: 30, buffer: 15,
  notice_hours: 24, horizon_days: 10, count: 3, per_day: 1, timezone: process.env.TZ || "Europe/Madrid",
};

export function normalizeScheduling(raw: unknown): Scheduling {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Scheduling>;
  const time = (v: unknown, d: string) => (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  const int = (v: unknown, d: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
  };
  const days = Array.isArray(r.days) ? [...new Set(r.days.map(Number).filter((d) => d >= 1 && d <= 7))].sort() : DEFAULT_SCHEDULING.days;
  const D = DEFAULT_SCHEDULING;
  return {
    days: days.length ? days : D.days,
    start: time(r.start, D.start),
    end: time(r.end, D.end),
    duration: int(r.duration, D.duration, 10, 240),
    buffer: int(r.buffer, D.buffer, 0, 120),
    notice_hours: int(r.notice_hours, D.notice_hours, 0, 24 * 14),
    horizon_days: int(r.horizon_days, D.horizon_days, 1, 60),
    count: int(r.count, D.count, 1, 10),
    per_day: int(r.per_day, D.per_day, 1, 10),
    timezone: isValidTimeZone(r.timezone) ? r.timezone! : D.timezone,
  };
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function parts(date: Date, tz: string) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    partsCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

/** Diferencia entre la hora local de `tz` y UTC en ese instante (ms). */
function offsetMs(date: Date, tz: string) {
  const p = parts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(date.getTime() / 60000) * 60000;
}

/** Hora local de una zona → instante UTC (tiene en cuenta el cambio de hora). */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = offsetMs(new Date(guess), tz);
  let t = guess - off;
  const off2 = offsetMs(new Date(t), tz);
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}

export type Interval = { start: Date; end: Date };

/** Huecos libres dentro del horario, evitando lo ocupado y con margen. */
export function freeSlots(busy: Interval[], s: Scheduling, now = new Date()): Interval[] {
  const earliest = now.getTime() + s.notice_hours * 3600000;
  const dur = s.duration * 60000, buf = s.buffer * 60000, step = 30 * 60000;
  const [sh, sm] = s.start.split(":").map(Number);
  const [eh, em] = s.end.split(":").map(Number);
  const today = parts(now, s.timezone);
  const out: Interval[] = [];
  for (let i = 0; i <= s.horizon_days && out.length < s.count; i++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + i));
    const weekday = ((day.getUTCDay() + 6) % 7) + 1;
    if (!s.days.includes(weekday)) continue;
    const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
    const dayStart = zonedToUtc(y, m, d, sh, sm, s.timezone).getTime();
    const dayEnd = zonedToUtc(y, m, d, eh, em, s.timezone).getTime();
    let perDay = 0;
    for (let t = dayStart; t + dur <= dayEnd && perDay < s.per_day && out.length < s.count; t += step) {
      if (t < earliest) continue;
      const end = t + dur;
      const clash = busy.some((b) => b.start.getTime() < end + buf && b.end.getTime() > t - buf);
      if (clash) continue;
      out.push({ start: new Date(t), end: new Date(end) });
      perDay++;
      t = end + buf - step; // el siguiente, después de este y su margen
    }
  }
  return out;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Lista para el correo: «- Martes 7 de octubre, 10:00 – 10:30». */
export function formatSlots(slots: Interval[], tz: string): string {
  if (slots.length === 0) return "";
  const day = new Intl.DateTimeFormat("es-ES", { timeZone: tz, weekday: "long", day: "numeric", month: "long" });
  const hour = new Intl.DateTimeFormat("es-ES", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const city = tz.split("/").pop()!.replace(/_/g, " ");
  return [
    ...slots.map((s) => `- ${cap(day.format(s.start))}, ${hour.format(s.start)} – ${hour.format(s.end)}`),
    `(hora de ${city})`,
  ].join("\n");
}

/** Texto cuando no hay calendario conectado o no quedan huecos. */
export const NO_SLOTS_TEXT = "Dime qué días y horas te vienen bien y lo cuadramos.";
