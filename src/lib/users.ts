import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { hashPassword, passwordProblem, verifyPassword, type Role } from "./session";
import { parse } from "./validation";
import { audit, passwordChangedNotice } from "./user-lifecycle";

export type UserRow = { id: string; name: string; kind: "human" | "ai_agent" };

export async function listUsers(): Promise<UserRow[]> {
  return sql<UserRow[]>`
    SELECT id, name, kind FROM users WHERE is_active ORDER BY kind, name`;
}

// ---------------------------------------------------------------------------
// Gestión de usuarios (solo administradores)

export type AdminUserRow = {
  id: string; name: string; email: string | null; role: Role; is_active: boolean;
  has_password: boolean; last_login_at: Date | null; locked: boolean; must_change_password: boolean;
  open_deals: number; sessions: number; sso_enabled: boolean; last_login_method: string | null; failed_logins: number;
  invited_at: Date | null; invite_expires_at: Date | null; invite_sent_from: string | null; deactivated_at: Date | null;
  deactivated_by_name: string | null; anonymized_at: Date | null;
};

export async function listAllUsers(): Promise<AdminUserRow[]> {
  return sql<AdminUserRow[]>`
    SELECT u.id, u.name, u.email, u.role, u.is_active, u.password_hash IS NOT NULL AS has_password,
           u.last_login_at, coalesce(u.locked_until > now(), false) AS locked, u.must_change_password, u.sso_enabled, u.last_login_method, u.failed_logins,
           (SELECT count(*)::int FROM deals d WHERE d.owner_id = u.id AND d.status = 'open' AND d.deleted_at IS NULL) AS open_deals,
           (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS sessions,
           u.invited_at, inv.expires_at AS invite_expires_at, inv.sent_from AS invite_sent_from,
           u.deactivated_at, db.name AS deactivated_by_name, u.anonymized_at
    FROM users u
    LEFT JOIN LATERAL (SELECT expires_at, sent_from FROM user_tokens t WHERE t.user_id = u.id AND t.purpose = 'invite' AND t.used_at IS NULL
                       ORDER BY created_at DESC LIMIT 1) inv ON true
    LEFT JOIN users db ON db.id = u.deactivated_by
    WHERE u.kind = 'human'
    ORDER BY u.is_active DESC, u.name`;
}

const ROLE = z.enum(["admin", "member", "viewer"], { message: "Rol no válido" });
const NAME = z.string().trim().min(1, "Falta el nombre").max(120);
const EMAIL = z.string().trim().toLowerCase().pipe(z.email("Email no válido"));

function checkPassword(password: string, email: string | null) {
  const problem = passwordProblem(password, email);
  if (problem) throw new UserError(problem);
}

/** Alta de un usuario con una contraseña inicial que tendrá que cambiar al entrar. */
export async function createUser(input: Record<string, unknown>, actorId: string | null = null): Promise<string> {
  const v = parse(z.object({ name: NAME, email: EMAIL, role: ROLE, password: z.string() }), input);
  checkPassword(v.password, v.email);
  const hash = await hashPassword(v.password);
  // Si ya existía sin acceso (p. ej. traído de Pipedrive), se le da acceso.
  const [existing] = await sql<{ id: string; password_hash: string | null }[]>`
    SELECT id, password_hash FROM users WHERE lower(email) = ${v.email} AND kind = 'human'`;
  if (existing?.password_hash) throw new UserError("Ya hay un usuario con ese email. Si está dado de baja, reactívalo desde su ficha.");
  if (existing) {
    await sql`
      UPDATE users SET name = ${v.name}, role = ${v.role}, is_active = true, password_hash = ${hash},
             must_change_password = true, failed_logins = 0, locked_until = NULL, deactivated_at = NULL, updated_at = now()
      WHERE id = ${existing.id}`;
    await audit(actorId, existing.id, "access_given", { role: v.role });
    return existing.id;
  }
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (name, email, kind, role, password_hash, must_change_password)
    VALUES (${v.name}, ${v.email}, 'human', ${v.role}, ${hash}, true) RETURNING id`;
  await audit(actorId, row.id, "access_given", { role: v.role });
  return row.id;
}

async function adminsLeft(exceptId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM users
    WHERE kind = 'human' AND role = 'admin' AND is_active AND (password_hash IS NOT NULL OR sso_enabled) AND id <> ${exceptId}`;
  return r.n;
}

/** Nombre, correo y rol. Las bajas y reactivaciones tienen su propio flujo (user-lifecycle). */
export async function updateUser(byId: string, userId: string, input: Record<string, unknown>): Promise<{ inviteVoided: boolean }> {
  const v = parse(z.object({ name: NAME, email: EMAIL, role: ROLE }), input);
  const [cur] = await sql<{ role: Role; is_active: boolean; name: string; email: string | null }[]>`
    SELECT role, is_active, name, email FROM users WHERE id = ${userId} AND kind = 'human'`;
  if (!cur) throw new UserError("Ese usuario no existe.");
  if (cur.role === "admin" && cur.is_active && v.role !== "admin" && (await adminsLeft(userId)) === 0) {
    throw new UserError("Tiene que quedar al menos un administrador.");
  }
  const [dup] = await sql`SELECT 1 FROM users WHERE lower(email) = ${v.email} AND id <> ${userId} AND kind = 'human'`;
  if (dup) throw new UserError("Ya hay otra persona con ese correo.");
  await sql`UPDATE users SET name = ${v.name}, email = ${v.email}, role = ${v.role}, updated_at = now() WHERE id = ${userId}`;
  // Si cambia el correo, los enlaces enviados a la dirección anterior dejan de servir.
  let inviteVoided = false;
  if ((cur.email ?? "") !== v.email) {
    const voided = await sql`UPDATE user_tokens SET used_at = now() WHERE user_id = ${userId} AND used_at IS NULL RETURNING purpose`;
    inviteVoided = voided.some((t) => t.purpose === "invite");
  }
  if (cur.role !== v.role) await audit(byId, userId, "role_changed", { from: cur.role, to: v.role });
  if (cur.name !== v.name || (cur.email ?? "") !== v.email) await audit(byId, userId, "data_changed", { email_changed: (cur.email ?? "") !== v.email });
  // Si baja de administrador, que vuelva a entrar con sus permisos nuevos.
  if (cur.role === "admin" && v.role !== "admin") await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  return { inviteVoided };
}

/** Un administrador pone una contraseña nueva (temporal) y desbloquea la cuenta. */
export async function resetPassword(userId: string, password: string, actorId: string | null = null) {
  const [u] = await sql<{ email: string | null }[]>`SELECT email FROM users WHERE id = ${userId} AND kind = 'human'`;
  if (!u) throw new UserError("Ese usuario no existe.");
  checkPassword(password, u.email);
  await sql`
    UPDATE users SET password_hash = ${await hashPassword(password)}, must_change_password = true,
           failed_logins = 0, locked_until = NULL, updated_at = now()
    WHERE id = ${userId}`;
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  await sql`UPDATE user_tokens SET used_at = now() WHERE user_id = ${userId} AND used_at IS NULL`;
  await audit(actorId, userId, "temp_password");
}

export async function signOutEverywhere(userId: string, actorId: string | null = null) {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  await audit(actorId, userId, "sessions_closed");
}

/** Cada usuario cambia su contraseña (pide la actual). Cierra sus otras sesiones. */
export async function changeOwnPassword(userId: string, current: string, next: string, repeat: string, keepTokenHash?: string) {
  const [u] = await sql<{ email: string | null; password_hash: string | null }[]>`SELECT email, password_hash FROM users WHERE id = ${userId}`;
  if (!u || !(await verifyPassword(current, u.password_hash))) throw new UserError("La contraseña actual no es correcta.");
  if (next !== repeat) throw new UserError("Las dos contraseñas nuevas no coinciden.");
  if (next === current) throw new UserError("La contraseña nueva tiene que ser distinta de la actual.");
  checkPassword(next, u.email);
  await sql`UPDATE users SET password_hash = ${await hashPassword(next)}, must_change_password = false, updated_at = now() WHERE id = ${userId}`;
  await sql`DELETE FROM sessions WHERE user_id = ${userId} AND token_hash <> ${keepTokenHash ?? ""}`;
  await sql`UPDATE user_tokens SET used_at = now() WHERE user_id = ${userId} AND purpose = 'reset' AND used_at IS NULL`;
  await audit(userId, userId, "password_changed");
  await passwordChangedNotice(userId).catch(() => null);
}

export async function updateOwnName(userId: string, name: unknown) {
  const v = parse(NAME, name);
  await sql`UPDATE users SET name = ${v}, updated_at = now() WHERE id = ${userId}`;
}

/** Primer administrador: solo mientras nadie tenga contraseña. */
export async function createFirstAdmin(input: Record<string, unknown>): Promise<string> {
  const v = parse(z.object({ name: NAME, email: EMAIL, password: z.string(), repeat: z.string() }), input);
  if (v.password !== v.repeat) throw new UserError("Las dos contraseñas no coinciden.");
  checkPassword(v.password, v.email);
  const hash = await hashPassword(v.password);
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4201339)`;
    const [{ n }] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE kind = 'human' AND password_hash IS NOT NULL`;
    if (n > 0) throw new UserError("La aplicación ya está en marcha: entra con tu usuario.");
    const [existing] = await tx<{ id: string }[]>`SELECT id FROM users WHERE lower(email) = ${v.email} AND kind = 'human'`;
    if (existing) {
      await tx`UPDATE users SET name = ${v.name}, role = 'admin', is_active = true, password_hash = ${hash}, last_login_at = now(), updated_at = now() WHERE id = ${existing.id}`;
      return existing.id;
    }
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO users (name, email, kind, role, password_hash, last_login_at) VALUES (${v.name}, ${v.email}, 'human', 'admin', ${hash}, now()) RETURNING id`;
    return row.id;
  }) as Promise<string>;
}
