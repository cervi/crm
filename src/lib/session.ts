import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { sql } from "./db";

// ===========================================================================
// Contraseñas y sesiones (sin dependencias de Next: lo usan tanto el proxy
// como las páginas y los scripts).
// ===========================================================================

export const SESSION_COOKIE = "crm_session";
export const SESSION_DAYS = 30;
export type Role = "admin" | "member" | "viewer";
export type SessionUser = { id: string; name: string; email: string; role: Role; must_change_password: boolean };

// --- Contraseñas: scrypt con sal aleatoria («scrypt$N$r$p$sal$hash»).
const N = 16384, R = 8, P = 1, KEYLEN = 64;

function derive(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Sin contraseña guardada también se calcula un hash: así tarda lo mismo y no
  // delata qué emails existen.
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    await derive(password, randomBytes(16));
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const key = await derive(password, Buffer.from(salt, "base64url"), Number(n), Number(r), Number(p));
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Reglas mínimas para una contraseña nueva; devuelve el problema o null. */
export function passwordProblem(password: string, email?: string | null): string | null {
  if (password.length < 10) return "La contraseña debe tener al menos 10 caracteres.";
  if (password.length > 200) return "La contraseña es demasiado larga.";
  if (/^(.)\1+$/.test(password)) return "La contraseña no puede ser un solo carácter repetido.";
  if (email && password.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) {
    return "La contraseña no puede contener tu email.";
  }
  return null;
}

// --- Sesiones
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createSession(userId: string, userAgent?: string | null): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await sql`
    INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
    VALUES (${tokenHash(token)}, ${userId}, ${expires}, ${userAgent?.slice(0, 300) ?? null})`;
  // Limpieza de paso: las sesiones caducadas no sirven para nada.
  await sql`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`;
  return { token, expires };
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** El usuario de una sesión válida (activo y humano), o null. */
export async function sessionUser(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || !TOKEN_RE.test(token)) return null;
  const [row] = await sql<(SessionUser & { session_id: string; stale: boolean })[]>`
    SELECT u.id, u.name, coalesce(u.email, '') AS email, u.role, u.must_change_password,
           s.id AS session_id, s.last_seen_at < now() - interval '1 hour' AS stale
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash(token)} AND s.expires_at > now()
      AND u.is_active AND u.kind = 'human' AND u.password_hash IS NOT NULL`;
  if (!row) return null;
  if (row.stale) await sql`UPDATE sessions SET last_seen_at = now() WHERE id = ${row.session_id}`;
  return { id: row.id, name: row.name, email: row.email, role: row.role, must_change_password: row.must_change_password };
}

export async function deleteSession(token: string | undefined | null) {
  if (token && TOKEN_RE.test(token)) await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash(token)}`;
}

// --- Inicio de sesión con bloqueo tras varios intentos fallidos.
const MAX_FAILED = 5, LOCK_MINUTES = 15;

export async function checkCredentials(emailInput: string, password: string): Promise<{ user: SessionUser } | { error: string }> {
  const email = emailInput.trim().toLowerCase();
  const [u] = email ? await sql<{ id: string; password_hash: string | null; locked: boolean }[]>`
    SELECT id, password_hash, coalesce(locked_until > now(), false) AS locked
    FROM users WHERE lower(email) = ${email} AND kind = 'human' AND is_active` : [];
  const valid = await verifyPassword(password, u?.password_hash ?? null);
  const generic = { error: "Email o contraseña incorrectos." };
  if (!u) return generic;
  if (u.locked) return { error: `Demasiados intentos fallidos: espera ${LOCK_MINUTES} minutos o pide a un administrador que te cambie la contraseña.` };
  if (!valid) {
    await sql`
      UPDATE users SET failed_logins = failed_logins + 1,
        locked_until = CASE WHEN failed_logins + 1 >= ${MAX_FAILED} THEN now() + make_interval(mins => ${LOCK_MINUTES}) END
      WHERE id = ${u.id}`;
    return generic;
  }
  const [user] = await sql<SessionUser[]>`
    UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = ${u.id}
    RETURNING id, name, coalesce(email, '') AS email, role, must_change_password`;
  return { user };
}

/** ¿Falta crear el primer administrador? (nadie tiene contraseña todavía). */
export async function needsSetup(): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE kind = 'human' AND password_hash IS NOT NULL`;
  return r.n === 0;
}
