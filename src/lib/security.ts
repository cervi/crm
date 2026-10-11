import { sql } from "./db";
import { notify } from "./notifications";

// ===========================================================================
// Centro de seguridad: reglas (duración de las sesiones, quién descarga
// datos…) y alertas para los administradores.
// ===========================================================================

export type SecurityRules = { session_days: number; idle_hours: number | null; export_admin_only: boolean; alert_new_device: boolean };

let cache: { at: number; rules: SecurityRules } | null = null;

export async function getRules(fresh = false): Promise<SecurityRules> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.rules;
  const [r] = await sql<SecurityRules[]>`SELECT session_days, idle_hours, export_admin_only, alert_new_device FROM app_settings LIMIT 1`.catch(() => []);
  const rules = r ?? { session_days: 30, idle_hours: null, export_admin_only: false, alert_new_device: true };
  cache = { at: Date.now(), rules };
  return rules;
}

export async function saveRules(form: FormData) {
  const days = Math.round(Number(form.get("session_days")));
  const idleRaw = String(form.get("idle_hours") ?? "").trim();
  const idle = idleRaw ? Math.round(Number(idleRaw)) : null;
  if (!(days >= 1 && days <= 90)) throw new Error("Las sesiones duran entre 1 y 90 días.");
  if (idle !== null && !(idle >= 1 && idle <= 720)) throw new Error("La inactividad máxima va de 1 a 720 horas, o vacío.");
  await sql`UPDATE app_settings SET session_days = ${days}, idle_hours = ${idle}, export_admin_only = ${form.get("export_admin_only") === "on"},
                   alert_new_device = ${form.get("alert_new_device") === "on"}`;
  cache = null;
}

export const ALERT_TEXT: Record<string, string> = {
  failed_logins: "Muchos intentos fallidos", new_admin: "Nuevo administrador", export: "Descarga de datos", new_device: "Entrada desde un dispositivo nuevo",
  deactivated: "Usuario dado de baja", anonymized: "Datos personales borrados", rules_changed: "Reglas de seguridad cambiadas",
};

/** Apunta una alerta y avisa a los administradores (las de nivel medio o alto). */
export async function raiseAlert(a: { kind: string; title: string; severity?: "info" | "warn" | "high"; userId?: string | null; actorId?: string | null;
                                      detail?: Record<string, unknown>; dedupeMinutes?: number }) {
  if (a.dedupeMinutes) {
    const [dup] = await sql`SELECT 1 FROM security_alerts WHERE kind = ${a.kind} AND user_id IS NOT DISTINCT FROM ${a.userId ?? null}::uuid
                            AND detail->>'key' IS NOT DISTINCT FROM ${String(a.detail?.key ?? "") || null}
                            AND at > now() - make_interval(mins => ${a.dedupeMinutes})`;
    if (dup) return;
  }
  const severity = a.severity ?? "info";
  await sql`INSERT INTO security_alerts (kind, severity, user_id, actor_id, title, detail)
            VALUES (${a.kind}, ${severity}, ${a.userId ?? null}, ${a.actorId ?? null}, ${a.title.slice(0, 300)}, ${sql.json((a.detail ?? {}) as never)})`;
  if (severity === "info") return;
  const admins = await sql<{ id: string }[]>`SELECT id FROM users WHERE kind = 'human' AND is_active AND role = 'admin'`;
  for (const ad of admins) {
    if (ad.id === a.actorId) continue;
    await notify(sql, { userId: ad.id, kind: `security.${a.kind}`, title: a.title, body: "Revísalo en Ajustes → Seguridad.", link: "/settings/security?tab=alertas" })
      .catch(() => null);
  }
}

export async function listAlerts(open = false, limit = 200) {
  return sql<{ id: number; at: Date; kind: string; severity: string; title: string; detail: Record<string, unknown>; user_name: string | null;
               actor_name: string | null; acknowledged_at: Date | null; ack_name: string | null }[]>`
    SELECT a.id, a.at, a.kind, a.severity, a.title, a.detail, u.name AS user_name, ac.name AS actor_name, a.acknowledged_at, k.name AS ack_name
    FROM security_alerts a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN users ac ON ac.id = a.actor_id LEFT JOIN users k ON k.id = a.acknowledged_by
    WHERE (${!open} OR a.acknowledged_at IS NULL)
    ORDER BY a.at DESC LIMIT ${limit}`;
}

export async function acknowledgeAlerts(userId: string, ids: number[] | "all") {
  if (ids === "all") await sql`UPDATE security_alerts SET acknowledged_at = now(), acknowledged_by = ${userId} WHERE acknowledged_at IS NULL`;
  else if (ids.length) await sql`UPDATE security_alerts SET acknowledged_at = now(), acknowledged_by = ${userId} WHERE id IN ${sql(ids)} AND acknowledged_at IS NULL`;
}

/** Tras un intento fallido: si van 5 o más en una hora con ese correo, alerta (una por hora). */
export async function checkFailedLogins(email: string) {
  const e = email.trim().toLowerCase();
  if (!e) return;
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM login_events WHERE lower(email) = ${e} AND NOT success AND at > now() - interval '1 hour'`;
  if (n < 5) return;
  const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE lower(email) = ${e} AND kind = 'human'`;
  await raiseAlert({ kind: "failed_logins", severity: u ? "warn" : "info", userId: u?.id ?? null, title: `${n} intentos fallidos de entrar como ${e} en la última hora`,
                     detail: { key: e, attempts: n }, dedupeMinutes: 60 });
}

/** «Chrome en Mac»: lo bastante para reconocer un dispositivo sin guardar huellas. */
export function deviceOf(ua: string | null | undefined) {
  if (!ua) return "desconocido";
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} en ${os}` : b;
}

/** Tras entrar bien: si es un dispositivo que esa persona no había usado, alerta (y queda en el registro). */
export async function checkNewDevice(userId: string, ua: string | null, ip: string | null) {
  const rules = await getRules();
  if (!rules.alert_new_device) return;
  const device = deviceOf(ua);
  const seen = await sql<{ user_agent: string | null }[]>`
    SELECT DISTINCT user_agent FROM login_events WHERE user_id = ${userId} AND success AND at < now() - interval '5 seconds' LIMIT 200`;
  if (!seen.length || seen.some((s) => deviceOf(s.user_agent) === device)) return;
  const [u] = await sql<{ name: string; role: string }[]>`SELECT name, role FROM users WHERE id = ${userId}`;
  await raiseAlert({ kind: "new_device", severity: u?.role === "admin" ? "warn" : "info", userId, title: `${u?.name ?? "Alguien"} ha entrado desde un dispositivo nuevo (${device})`,
                     detail: { device, ip } });
}

/** Panel: cómo está la seguridad de un vistazo. */
export async function securityPosture() {
  const [r] = await sql<{ admins: number; users: number; sso_users: number; stale: number; sessions: number; failed7: number; exports30: number; open_alerts: number;
                          locked: number; temp_pass: number }[]>`
    SELECT (SELECT count(*)::int FROM users WHERE kind = 'human' AND is_active AND role = 'admin') AS admins,
           (SELECT count(*)::int FROM users WHERE kind = 'human' AND is_active AND (password_hash IS NOT NULL OR sso_enabled)) AS users,
           (SELECT count(*)::int FROM users WHERE kind = 'human' AND is_active AND sso_enabled) AS sso_users,
           (SELECT count(*)::int FROM users WHERE kind = 'human' AND is_active AND (password_hash IS NOT NULL OR sso_enabled)
              AND coalesce(last_login_at, created_at) < now() - interval '60 days') AS stale,
           (SELECT count(*)::int FROM sessions WHERE expires_at > now()) AS sessions,
           (SELECT count(*)::int FROM login_events WHERE NOT success AND at > now() - interval '7 days') AS failed7,
           (SELECT count(*)::int FROM export_log WHERE at > now() - interval '30 days') AS exports30,
           (SELECT count(*)::int FROM security_alerts WHERE acknowledged_at IS NULL AND severity <> 'info') AS open_alerts,
           (SELECT count(*)::int FROM users WHERE locked_until > now()) AS locked,
           (SELECT count(*)::int FROM users WHERE kind = 'human' AND is_active AND must_change_password) AS temp_pass`;
  return r;
}

export async function recentExports(limit = 50) {
  return sql<{ at: Date; dataset: string; rows: number; user_name: string | null; ip: string | null }[]>`
    SELECT e.at, e.dataset, e.rows, u.name AS user_name, e.ip FROM export_log e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.at DESC LIMIT ${limit}`;
}
