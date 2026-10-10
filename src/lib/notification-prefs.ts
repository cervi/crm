import { json, sql } from "./db";
import { UserError } from "./errors";

// ===========================================================================
// Preferencias de avisos de cada persona: qué recibe, por dónde y cuándo no
// molestar. Lo urgente (te responden, abren la propuesta) puede llegar al
// momento; el resto, agrupado en un resumen para no ir goteando correos.
// ===========================================================================

export const CATEGORIES = {
  replies: { label: "Clientes que responden o reservan", hint: "Te responden un correo, reservan una reunión, abren tu correo varias veces.", def: "now" },
  proposals: { label: "Propuestas y contratos", hint: "El cliente abre, acepta o rechaza una propuesta; alguien firma, rechaza o deja esperando un contrato.", def: "now" },
  assigned: { label: "Te asignan algo", hint: "Un deal o un lead nuevo pasa a ser tuyo.", def: "digest" },
  mentions: { label: "Menciones", hint: "Alguien te menciona con @ en una nota.", def: "now" },
  following: { label: "Deals que sigues", hint: "Cambios de fase, notas, archivos y salud de deals y cuentas que sigues.", def: "app" },
  ai: { label: "La IA y los agentes", hint: "Descuentos por aprobar, campañas, secuencias, fichas de reunión.", def: "app" },
} as const;
export type Category = keyof typeof CATEGORIES;
export type Channel = "now" | "digest" | "app" | "off";
export const CHANNELS: Record<Channel, string> = {
  now: "App y correo al momento", digest: "App y correo agrupado", app: "Solo en la app", off: "No avisarme",
};

export type NotificationPrefs = {
  channels: Record<Category, Channel>;
  quietFrom: number | null; quietTo: number | null;   // horas locales; null = sin silencio
  daily: boolean;          // parte del día por correo
  weekPlan: boolean;       // lunes: la semana que empieza
  weekReview: boolean;     // viernes: cómo ha ido
  teamWeek: boolean;       // lunes: el equipo (para quien lo lleva)
  meetingPrep: boolean;    // ficha de la reunión 30 min antes
  noReplyDays: number;     // recordar si un correo no tiene respuesta en N días (0 = no)
};

export function categoryOf(kind: string): Category {
  if (/^(email\.(received|opened|reopened)|deal\.booked)$/.test(kind)) return "replies";
  if (kind.startsWith("proposal.") || kind.startsWith("sign.")) return "proposals";
  if (kind === "assigned") return "assigned";
  if (kind === "mention") return "mentions";
  if (["discount", "campaign", "sequence", "meeting_prep", "no_reply"].includes(kind)) return kind === "no_reply" ? "replies" : "ai";
  return "following";
}

export function withDefaults(raw: Partial<NotificationPrefs> | null | undefined, role?: string): NotificationPrefs {
  const r = raw ?? {};
  const channels = Object.fromEntries((Object.keys(CATEGORIES) as Category[]).map((c) => [c, (r.channels?.[c] ?? CATEGORIES[c].def) as Channel])) as Record<Category, Channel>;
  return {
    channels,
    quietFrom: r.quietFrom ?? 20, quietTo: r.quietTo ?? 8,
    daily: r.daily ?? true, weekPlan: r.weekPlan ?? true, weekReview: r.weekReview ?? true,
    teamWeek: r.teamWeek ?? role === "admin", meetingPrep: r.meetingPrep ?? true, noReplyDays: r.noReplyDays ?? 4,
  };
}

export async function getPrefs(userId: string): Promise<NotificationPrefs> {
  const [u] = await sql<{ notification_prefs: Partial<NotificationPrefs>; role: string }[]>`SELECT notification_prefs, role FROM users WHERE id = ${userId}`;
  return withDefaults(u?.notification_prefs, u?.role);
}

export async function savePrefs(userId: string, data: Record<string, unknown>) {
  const channels = {} as Record<Category, Channel>;
  for (const c of Object.keys(CATEGORIES) as Category[]) {
    const v = String(data[`ch_${c}`] ?? CATEGORIES[c].def) as Channel;
    if (!(v in CHANNELS)) throw new UserError("Opción de aviso no válida.");
    channels[c] = v;
  }
  const hour = (v: unknown) => (v === "" || v === undefined || v === null ? null : Number(v));
  const quietFrom = data.quiet === "on" ? hour(data.quiet_from) : null, quietTo = data.quiet === "on" ? hour(data.quiet_to) : null;
  for (const h of [quietFrom, quietTo]) if (h !== null && (!Number.isInteger(h) || h < 0 || h > 23)) throw new UserError("Hora de silencio no válida.");
  const days = Number(data.no_reply_days ?? 0);
  if (!Number.isInteger(days) || days < 0 || days > 30) throw new UserError("Días sin respuesta: entre 0 y 30.");
  const prefs: NotificationPrefs = {
    channels, quietFrom, quietTo,
    daily: data.daily === "on", weekPlan: data.week_plan === "on", weekReview: data.week_review === "on",
    teamWeek: data.team_week === "on", meetingPrep: data.meeting_prep === "on", noReplyDays: days,
  };
  await sql`UPDATE users SET notification_prefs = ${json(prefs)} WHERE id = ${userId}`;
}

/** ¿Es hora de silencio para esta persona? */
export function isQuiet(p: NotificationPrefs, localHour: number) {
  if (p.quietFrom === null || p.quietTo === null || p.quietFrom === p.quietTo) return false;
  return p.quietFrom < p.quietTo ? localHour >= p.quietFrom && localHour < p.quietTo : localHour >= p.quietFrom || localHour < p.quietTo;
}
