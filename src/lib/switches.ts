import { sql } from "./db";
import { UserError } from "./errors";

// ===========================================================================
// Interruptores del CRM: módulos enteros que se encienden o apagan.
//
// Dos capas:
//  · Servidor (variables de entorno): OUTBOUND_DISABLED=1 apaga y bloquea todo
//    lo que llega a otras personas (correos, invitaciones, webhooks);
//    SWITCHES_OFF=clave,clave… apaga y bloquea los que se digan. Desde la
//    pantalla no se pueden encender.
//  · Ajustes → Interruptores: el resto, por un administrador.
//
// Lo que un interruptor impide salir queda apuntado en outbound_blocked.
// ===========================================================================

export const SWITCHES = {
  email_out: { group: "out", label: "Enviar correos", help: "Todos: secuencias, campañas, correos escritos a mano, avisos y resúmenes, invitaciones, contraseñas y firmas. Apagado, no sale ninguno (los programados esperan)." },
  calendar_invites: { group: "out", label: "Invitar a reuniones desde el calendario", help: "Apagado, la reunión se apunta en tu calendario pero sin invitados: nadie recibe la invitación." },
  webhooks: { group: "out", label: "Avisar a otras herramientas (webhooks)", help: "Llamadas a Zapier, Make, n8n, Slack… desde las reglas." },
  sequences: { group: "auto", label: "Motor de secuencias", help: "Avanza los pasos, programa correos y crea las tareas. Apagado, todo se queda donde está." },
  campaigns: { group: "auto", label: "Campañas de outbound", help: "Verificar correos, escribir la primera línea, meter a los aprobados en la secuencia y clasificar respuestas." },
  automations: { group: "auto", label: "Propuestas de la IA y reglas automáticas", help: "La revisión periódica que propone (o hace) acciones: tareas, correos, mover deals…" },
  team_mail: { group: "auto", label: "Avisos y resúmenes por correo al equipo", help: "Resumen diario, avisos por correo y resumen semanal. Los avisos dentro del CRM siguen." },
  ai: { group: "ai", label: "IA", help: "Redactar, resumir, clasificar respuestas, preparar reuniones, cualificar leads… Apagada, el CRM funciona sin ella." },
  mail_sync: { group: "in", label: "Leer correo y calendario", help: "Traer al CRM los correos y reuniones con contactos de las cuentas conectadas. Solo lee." },
  meeting_notes: { group: "in", label: "Importar notas de reuniones", help: "Notas de Google Meet (Gemini) y de Granola." },
  pipedrive_sync: { group: "in", label: "Sincronización automática con Pipedrive", help: "La puesta al día cada hora. La importación a mano sigue disponible." },
  web_enrichment: { group: "in", label: "Leer webs de empresas y verificar dominios", help: "Enriquecer empresas con su web y comprobar que los dominios reciben correo." },
  public_pages: { group: "public", label: "Páginas públicas", help: "Reservas, formularios y chat de la web, documentos y propuestas compartidos, encuestas y firma electrónica. Apagadas, muestran «no disponible»." },
  inbound_api: { group: "public", label: "API de entrada y agentes externos", help: "Leads desde la web o Zapier, notas de Granola, uso de clientes y agentes conectados por MCP." },
} as const;
export type SwitchKey = keyof typeof SWITCHES;
export const SWITCH_GROUPS = [
  ["out", "Lo que llega a otras personas"], ["auto", "Automatismos"], ["ai", "Inteligencia artificial"], ["in", "Integraciones (lectura)"], ["public", "Acceso desde fuera"],
] as const;
const KEYS = Object.keys(SWITCHES) as SwitchKey[];
const OUTBOUND: SwitchKey[] = ["email_out", "calendar_invites", "webhooks"];

/** Apagados (y bloqueados) por el servidor. */
export function serverLocked(): Set<SwitchKey> {
  const s = new Set<SwitchKey>();
  if (/^(1|true|yes|on|si|sí)$/i.test(process.env.OUTBOUND_DISABLED ?? "")) OUTBOUND.forEach((k) => s.add(k));
  for (const k of (process.env.SWITCHES_OFF ?? "").split(/[\s,;]+/)) if (k in SWITCHES) s.add(k as SwitchKey);
  return s;
}

/** Bloqueo de salida del servidor, sin base de datos (para la capa más baja). */
export const outboundHardOff = () => /^(1|true|yes|on|si|sí)$/i.test(process.env.OUTBOUND_DISABLED ?? "");

let cache: { at: number; v: Partial<Record<SwitchKey, boolean>> } | null = null;

async function stored(): Promise<Partial<Record<SwitchKey, boolean>>> {
  if (cache && Date.now() - cache.at < 15_000) return cache.v;
  const [r] = await sql<{ switches: Partial<Record<SwitchKey, boolean>> }[]>`SELECT switches FROM app_settings LIMIT 1`.catch(() => []);
  cache = { at: Date.now(), v: r?.switches ?? {} };
  return cache.v;
}

/** ¿Está encendido? Por defecto, sí (salvo que el servidor lo bloquee). */
export async function isOn(key: SwitchKey): Promise<boolean> {
  if (serverLocked().has(key)) return false;
  return (await stored())[key] !== false;
}

export type SwitchState = { key: SwitchKey; group: string; label: string; help: string; on: boolean; locked: boolean };

export async function allSwitches(): Promise<SwitchState[]> {
  const locked = serverLocked();
  const v = await stored();
  return KEYS.map((k) => ({ key: k, ...SWITCHES[k], on: !locked.has(k) && v[k] !== false, locked: locked.has(k) }));
}

export async function saveSwitches(form: FormData): Promise<{ changed: { key: SwitchKey; on: boolean }[] }> {
  const locked = serverLocked();
  const before = await stored();
  const next: Partial<Record<SwitchKey, boolean>> = { ...before };
  const changed: { key: SwitchKey; on: boolean }[] = [];
  for (const k of KEYS) {
    if (locked.has(k)) continue;
    const on = form.get(k) === "on";
    if ((before[k] !== false) !== on) changed.push({ key: k, on });
    next[k] = on;
  }
  await sql`UPDATE app_settings SET switches = ${sql.json(next as never)}`;
  cache = null;
  return { changed };
}

/** Apunta algo que no ha salido por un interruptor. */
export async function recordBlocked(sw: SwitchKey, kind: string, target: string | null, subject: string | null, source: string) {
  await sql`INSERT INTO outbound_blocked (switch, kind, target, subject, source)
            VALUES (${sw}, ${kind}, ${target?.slice(0, 300) ?? null}, ${subject?.slice(0, 300) ?? null}, ${source.slice(0, 120)})`.catch(() => null);
}

/** Para lo que sale: si está apagado, lo apunta y corta con un mensaje claro. */
export async function assertOn(sw: SwitchKey, what: { kind: string; target?: string | null; subject?: string | null; source: string }) {
  if (await isOn(sw)) return;
  await recordBlocked(sw, what.kind, what.target ?? null, what.subject ?? null, what.source);
  throw new UserError(serverLocked().has(sw)
    ? `No se ha enviado: este CRM está en modo sin envíos («${SWITCHES[sw].label}» apagado en el servidor).`
    : `No se ha enviado: «${SWITCHES[sw].label}» está apagado en Ajustes → Interruptores.`);
}

export async function recentBlocked(limit = 50) {
  return sql<{ at: Date; switch: SwitchKey; kind: string; target: string | null; subject: string | null; source: string | null }[]>`
    SELECT at, switch, kind, target, subject, source FROM outbound_blocked ORDER BY at DESC LIMIT ${limit}`;
}
