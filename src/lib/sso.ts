import { sql } from "./db";
import { logLogin } from "./login-log";

// ===========================================================================
// Entrar con Google o Microsoft: el correo de la cuenta tiene que ser el de
// un usuario del CRM con acceso. Si un administrador lo permite, también
// pueden entrar (y se dan de alta solos) los del dominio de la empresa.
// ===========================================================================

export type SsoSettings = { domain: string | null; defaultRole: "member" | "viewer"; passwordLogin: boolean };

export async function getSsoSettings(): Promise<SsoSettings> {
  const [s] = await sql<{ sso_domain: string | null; sso_default_role: "member" | "viewer"; password_login: boolean }[]>`
    SELECT sso_domain, sso_default_role, password_login FROM app_settings LIMIT 1`.catch(() => []);
  return { domain: s?.sso_domain ?? null, defaultRole: s?.sso_default_role ?? "member", passwordLogin: s?.password_login ?? true };
}

export async function saveSsoSettings(data: Record<string, unknown>) {
  const domain = String(data.sso_domain ?? "").trim().toLowerCase().replace(/^@/, "") || null;
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error("Dominio no válido (p. ej. aikit.io).");
  const role = data.sso_default_role === "viewer" ? "viewer" : "member";
  await sql`UPDATE app_settings SET sso_domain = ${domain}, sso_default_role = ${role}, password_login = ${data.password_login !== "off"}`;
}

export async function ssoLogin(method: "google" | "microsoft", emailRaw: string, displayName: string | null, ip: string | null, ua: string | null):
  Promise<{ userId: string; mustChange: boolean } | { error: string }> {
  const email = emailRaw.trim().toLowerCase();
  const fail = async (reason: string, userId?: string) => { await logLogin({ userId, email, method, success: false, reason, ip, ua }); return { error: reason }; };
  if (!email) return fail("La cuenta no tiene correo.");
  const [u] = await sql<{ id: string; is_active: boolean; has_access: boolean; must_change_password: boolean }[]>`
    SELECT id, is_active, (password_hash IS NOT NULL OR sso_enabled) AS has_access, must_change_password
    FROM users WHERE lower(email) = ${email} AND kind = 'human' ORDER BY is_active DESC LIMIT 1`;
  const s = await getSsoSettings();
  const ofDomain = Boolean(s.domain) && email.endsWith(`@${s.domain}`);
  if (u && !u.is_active) return fail("Tu usuario está desactivado. Habla con un administrador.", u.id);
  if (u && !u.has_access && !ofDomain) return fail("Todavía no tienes acceso al CRM. Pide a un administrador que te lo dé.", u.id);
  let id = u?.id;
  if (!u) {
    if (!ofDomain) return fail(`No hay ningún usuario del CRM con el correo ${email}.`);
    const name = (displayName?.trim() || email.split("@")[0]).slice(0, 120);
    const [n] = await sql<{ id: string }[]>`
      INSERT INTO users (name, email, kind, role, sso_enabled, must_change_password) VALUES (${name}, ${email}, 'human', ${s.defaultRole}, true, false) RETURNING id`;
    id = n.id;
  }
  await sql`UPDATE users SET sso_enabled = true, must_change_password = false, last_login_at = now(), last_login_method = ${method}, failed_logins = 0, locked_until = NULL WHERE id = ${id!}`;
  await logLogin({ userId: id, email, method, success: true, reason: u ? null : "alta automática por dominio", ip, ua });
  // Con Google/Microsoft no hace falta cambiar una contraseña temporal.
  return { userId: id!, mustChange: false };
}
