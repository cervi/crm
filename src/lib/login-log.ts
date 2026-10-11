import { sql } from "./db";

/** Apunta una entrada (o un intento fallido) en el registro de accesos. */
export async function logLogin(v: { userId?: string | null; email?: string | null; method: "password" | "google" | "microsoft" | "reset"; success: boolean;
                                    reason?: string | null; ip?: string | null; ua?: string | null }) {
  await sql`INSERT INTO login_events (user_id, email, method, success, reason, ip, user_agent)
            VALUES (${v.userId ?? null}, ${v.email?.toLowerCase().slice(0, 320) ?? null}, ${v.method}, ${v.success}, ${v.reason?.slice(0, 200) ?? null},
                    ${v.ip ?? null}, ${v.ua?.slice(0, 300) ?? null})`.catch(() => null);
  // Centro de seguridad: intentos fallidos seguidos y entradas desde un dispositivo nuevo.
  const sec = await import("./security");
  if (!v.success && v.email && v.method !== "reset") await sec.checkFailedLogins(v.email).catch(() => null);
  if (v.success && v.userId && v.method !== "reset") await sec.checkNewDevice(v.userId, v.ua ?? null, v.ip ?? null).catch(() => null);
}

export type LoginEvent = { id: number; user_id: string | null; user_name: string | null; email: string | null; method: string; success: boolean;
                           reason: string | null; ip: string | null; user_agent: string | null; at: Date };

export async function listLoginEvents(opts: { failed?: boolean; userId?: string | null; limit?: number } = {}) {
  return sql<LoginEvent[]>`
    SELECT e.id, e.user_id, u.name AS user_name, e.email, e.method, e.success, e.reason, e.ip, e.user_agent, e.at
    FROM login_events e LEFT JOIN users u ON u.id = e.user_id
    WHERE (${opts.failed ?? false} = false OR NOT e.success) AND (${opts.userId ?? null}::uuid IS NULL OR e.user_id = ${opts.userId ?? null}::uuid)
    ORDER BY e.at DESC LIMIT ${opts.limit ?? 200}`;
}

export const METHOD_LABEL: Record<string, string> = { password: "Contraseña", google: "Google", microsoft: "Microsoft", reset: "Recuperar contraseña" };
