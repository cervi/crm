import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { sql, transaction } from "./db";
import { publicBase } from "./email-track";
import { UserError } from "./errors";
import { logLogin } from "./login-log";
import { mailHtml } from "./mail-html";
import { getCompany } from "./company";
import { listConnections, sendPlainEmail, type Connection } from "./mailbox";
import { hashPassword, passwordProblem, type Role } from "./session";
import { parse } from "./validation";

// ===========================================================================
// Ciclo de vida de los usuarios: invitación, «¿Has olvidado tu contraseña?»,
// baja con traspaso, reactivación y anonimización. Todo queda en user_audit.
// ===========================================================================

const ROLE_NAME: Record<Role, string> = { admin: "Administrador", member: "Comercial", viewer: "Solo lectura" };
const INVITE_DAYS = 7;
const RESET_MINUTES = 60;          // si la pide la persona
const ADMIN_RESET_HOURS = 24;      // si la envía un administrador

const hash = (t: string) => createHash("sha256").update(t).digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export async function audit(actorId: string | null, userId: string | null, action: string, detail: Record<string, unknown> = {}) {
  await sql`INSERT INTO user_audit (actor_id, user_id, action, detail) VALUES (${actorId}, ${userId}, ${action}, ${sql.json(detail as never)})`;
}

export const AUDIT_TEXT: Record<string, string> = {
  invited: "Invitado", invite_resent: "Invitación reenviada", invite_cancelled: "Invitación cancelada", invite_accepted: "Aceptó la invitación",
  access_given: "Acceso con contraseña inicial", role_changed: "Cambio de rol", data_changed: "Cambio de nombre o correo",
  reset_sent: "Enlace para cambiar la contraseña enviado", reset_requested: "Pidió cambiar su contraseña", password_reset: "Contraseña cambiada con el enlace",
  password_changed: "Cambió su contraseña", temp_password: "Contraseña temporal puesta por un administrador", sessions_closed: "Sesiones cerradas",
  deactivated: "Dado de baja", reactivated: "Reactivado", anonymized: "Datos personales borrados", sso_on: "Puede entrar con Google/Microsoft",
  sso_off: "Ya no entra con Google/Microsoft",
};

export async function userHistory(userId: string, limit = 30) {
  return sql<{ id: number; at: Date; action: string; detail: Record<string, unknown>; actor_name: string | null; actor_id: string | null }[]>`
    SELECT a.id, a.at, a.action, a.detail, u.name AS actor_name, a.actor_id FROM user_audit a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.user_id = ${userId} ORDER BY a.at DESC LIMIT ${limit}`;
}

// ---------------------------------------------------------------------------
// Correos del sistema

/**
 * Buzón para un correo del sistema. Primero el de la propia persona (así el
 * enlace solo queda en su bandeja de enviados), luego el elegido en Ajustes y,
 * si no, el de un administrador. Nunca el de otro comercial.
 */
export async function systemSender(preferUserId?: string | null): Promise<Connection | null> {
  const conns = (await listConnections()).filter((c) => c.status === "active");
  if (preferUserId) {
    const own = conns.find((c) => c.user_id === preferUserId);
    if (own) return own;
  }
  const admins = new Set((await sql<{ id: string }[]>`SELECT id FROM users WHERE kind = 'human' AND is_active AND role = 'admin'`).map((u) => u.id));
  const [s] = await sql<{ system_mail_user_id: string | null }[]>`SELECT system_mail_user_id FROM app_settings LIMIT 1`.catch(() => []);
  return conns.find((c) => c.user_id === s?.system_mail_user_id && admins.has(c.user_id))
    ?? conns.find((c) => admins.has(c.user_id)) ?? null;
}

async function sendSystemEmail(to: { email: string; name?: string | null }, subject: string, text: string,
                               cta?: { label: string; url: string }, foot?: string, preferUserId?: string | null) {
  const conn = await systemSender(preferUserId);
  if (!conn) return null;
  const body = [text, cta ? `${cta.label}: ${cta.url}` : "", foot ?? ""].filter(Boolean).join("\n\n");
  await sendPlainEmail(conn, to.email, subject, body, mailHtml(text, cta, foot), { toName: to.name ?? null, track: false });
  return conn.email;
}

/** Nombre de la empresa (Ajustes de empresa) o, si no hay, APP_NAME. */
const appName = async () => (await getCompany()).name || process.env.APP_NAME?.trim() || null;
/** «del CRM» / «de Aikit», «al CRM» / «a Aikit»: sin artículos raros en asuntos y textos. */
const appDel = async () => { const n = await appName(); return n ? `de ${n}` : "del CRM"; };
const appAl = async () => { const n = await appName(); return n ? `a ${n}` : "al CRM"; };

/** Enlace público de un token. Sin APP_URL, el del navegador del administrador (para copiarlo). */
export function accessLink(token: string, origin?: string | null) {
  const base = publicBase() ?? (origin && /^https?:\/\/[^/\s]+$/.test(origin) ? origin : null);
  return base ? `${base}/acceso/${token}` : `/acceso/${token}`;
}

async function issueToken(userId: string, purpose: "invite" | "reset", createdBy: string | null, minutes: number, ip?: string | null) {
  const token = randomBytes(32).toString("base64url");
  await transaction(async (tx) => {
    // Solo vale el último enlace de cada tipo.
    await tx`UPDATE user_tokens SET used_at = now() WHERE user_id = ${userId} AND purpose = ${purpose} AND used_at IS NULL`;
    await tx`INSERT INTO user_tokens (user_id, purpose, token_hash, created_by, expires_at, ip)
             VALUES (${userId}, ${purpose}, ${hash(token)}, ${createdBy}, now() + make_interval(mins => ${minutes}), ${ip ?? null})`;
  });
  return token;
}

const markSent = (token: string, from: string | null) => sql`UPDATE user_tokens SET sent_from = ${from} WHERE token_hash = ${hash(token)}`;

// ---------------------------------------------------------------------------
// Alta por invitación

const NAME = z.string().trim().min(1, "Falta el nombre").max(120);
const EMAIL = z.string().trim().toLowerCase().pipe(z.email("Email no válido"));
const ROLE = z.enum(["admin", "member", "viewer"], { message: "Rol no válido" });

export type InviteResult = { userId: string; link: string; sentFrom: string | null; name: string; email: string };

export async function inviteUser(actorId: string, input: Record<string, unknown>, origin?: string | null): Promise<InviteResult> {
  const v = parse(z.object({ name: NAME, email: EMAIL, role: ROLE }), input);
  const sso = input.sso === "on" || input.sso === true;
  const [existing] = await sql<{ id: string; password_hash: string | null; is_active: boolean; anonymized_at: Date | null }[]>`
    SELECT id, password_hash, is_active, anonymized_at FROM users WHERE lower(email) = ${v.email} AND kind = 'human'`;
  if (existing?.password_hash && existing.is_active) throw new UserError("Esa persona ya tiene acceso. Si no recuerda la contraseña, envíale un enlace para cambiarla.");
  if (existing && !existing.is_active && existing.password_hash) throw new UserError("Esa persona está dada de baja: reactívala desde su ficha.");
  let userId: string;
  if (existing) {
    await sql`UPDATE users SET name = ${v.name}, role = ${v.role}, is_active = true, invited_at = now(), invited_by = ${actorId},
                    sso_enabled = sso_enabled OR ${sso}, deactivated_at = NULL, deactivated_by = NULL, updated_at = now() WHERE id = ${existing.id}`;
    userId = existing.id;
  } else {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO users (name, email, kind, role, invited_at, invited_by, sso_enabled, must_change_password)
      VALUES (${v.name}, ${v.email}, 'human', ${v.role}, now(), ${actorId}, ${sso}, false) RETURNING id`;
    userId = row.id;
  }
  const r = await sendInvite(actorId, userId, origin);
  await audit(actorId, userId, "invited", { role: v.role, sent_from: r.sentFrom, sso });
  if (v.role === "admin") {
    const { raiseAlert } = await import("./security");
    await raiseAlert({ kind: "new_admin", severity: "warn", userId, actorId, title: `${v.name} ha sido invitado como administrador` });
  }
  return r;
}

async function sendInvite(actorId: string, userId: string, origin?: string | null): Promise<InviteResult> {
  const [u] = await sql<{ name: string; email: string | null; role: Role; sso_enabled: boolean }[]>`
    SELECT name, email, role, sso_enabled FROM users WHERE id = ${userId} AND kind = 'human'`;
  if (!u?.email) throw new UserError("Esa persona no tiene correo.");
  const [inviter] = await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${actorId}`;
  const token = await issueToken(userId, "invite", actorId, INVITE_DAYS * 24 * 60);
  const link = accessLink(token, origin);
  let sentFrom: string | null = null;
  if (link.startsWith("http")) {
    const first = u.name.split(" ")[0];
    const text = `Hola, ${first}:\n\n${inviter?.name ?? "Tu equipo"} te ha dado acceso ${await appAl()} como ${ROLE_NAME[u.role].toLowerCase()}.`
      + `\n\nCrea tu contraseña con este botón${u.sso_enabled ? " o entra directamente con tu cuenta de Google o Microsoft" : ""}.`;
    sentFrom = await sendSystemEmail({ email: u.email, name: u.name }, `${inviter?.name ?? "Tu equipo"} te invita ${await appAl()}`, text,
      { label: "Crear mi contraseña", url: link }, `El enlace caduca en ${INVITE_DAYS} días y solo sirve una vez. Si no esperabas este correo, ignóralo.`, actorId)
      .catch((err) => { console.error("[invitación]", err); return null; });
    await markSent(token, sentFrom);
  }
  return { userId, link, sentFrom, name: u.name, email: u.email };
}

export async function resendInvite(actorId: string, userId: string, origin?: string | null) {
  const [u] = await sql<{ password_hash: string | null; is_active: boolean }[]>`SELECT password_hash, is_active FROM users WHERE id = ${userId}`;
  if (!u) throw new UserError("Ese usuario no existe.");
  if (u.password_hash) throw new UserError("Ya ha creado su contraseña.");
  if (!u.is_active) throw new UserError("Está dado de baja.");
  await sql`UPDATE users SET invited_at = now(), invited_by = ${actorId} WHERE id = ${userId}`;
  const r = await sendInvite(actorId, userId, origin);
  await audit(actorId, userId, "invite_resent", { sent_from: r.sentFrom });
  return r;
}

export async function cancelInvite(actorId: string, userId: string) {
  await sql`UPDATE user_tokens SET used_at = now() WHERE user_id = ${userId} AND purpose = 'invite' AND used_at IS NULL`;
  await sql`UPDATE users SET invited_at = NULL WHERE id = ${userId} AND password_hash IS NULL`;
  await audit(actorId, userId, "invite_cancelled");
}

// ---------------------------------------------------------------------------
// Contraseña: enlace para cambiarla (lo pide la persona o se lo envía un administrador)

/** Lo envía un administrador (por ejemplo, si se ha bloqueado). Devuelve el enlace por si hay que copiarlo. */
export async function sendResetLink(actorId: string, userId: string, origin?: string | null) {
  const [u] = await sql<{ name: string; email: string | null; is_active: boolean; has_password: boolean }[]>`
    SELECT name, email, is_active, password_hash IS NOT NULL AS has_password FROM users WHERE id = ${userId} AND kind = 'human'`;
  const [admin] = await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${actorId}`;
  if (!u?.email) throw new UserError("Esa persona no tiene correo.");
  if (!u.is_active) throw new UserError("Está dada de baja: reactívala primero.");
  const token = await issueToken(userId, "reset", actorId, ADMIN_RESET_HOURS * 60);
  const link = accessLink(token, origin);
  let sentFrom: string | null = null;
  if (link.startsWith("http")) {
    sentFrom = await sendSystemEmail({ email: u.email, name: u.name }, u.has_password ? `Cambia tu contraseña ${await appDel()}` : `Crea tu contraseña ${await appDel()}`,
      `Hola, ${u.name.split(" ")[0]}:\n\n${admin?.name ?? "Un administrador"} te ha enviado este enlace para que ${u.has_password ? "pongas una contraseña nueva" : "crees tu contraseña"}.`,
      { label: u.has_password ? "Poner una contraseña nueva" : "Crear mi contraseña", url: link }, `El enlace caduca en ${ADMIN_RESET_HOURS} horas y solo sirve una vez.`, actorId)
      .catch((err) => { console.error("[contraseña]", err); return null; });
    await markSent(token, sentFrom);
  }
  await audit(actorId, userId, "reset_sent", { sent_from: sentFrom });
  return { link, sentFrom, name: u.name, email: u.email };
}

/**
 * «¿Has olvidado tu contraseña?». Responde siempre lo mismo (no dice si el
 * correo existe) y limita los intentos: 3 por persona y hora, 20 por IP y hora.
 */
export async function requestPasswordReset(emailRaw: string, ip: string | null, ua: string | null, origin?: string | null) {
  const email = emailRaw.trim().toLowerCase();
  if (!z.email().safeParse(email).success) throw new UserError("Escribe un correo válido.");
  const [{ n: byIp }] = ip
    ? await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM user_tokens WHERE purpose = 'reset' AND ip = ${ip} AND created_at > now() - interval '1 hour'`
    : [{ n: 0 }];
  if (byIp >= 20) throw new UserError("Demasiadas peticiones. Inténtalo dentro de un rato.");
  const [u] = await sql<{ id: string; name: string; email: string; has_password: boolean; sso_enabled: boolean }[]>`
    SELECT id, name, email, password_hash IS NOT NULL AS has_password, sso_enabled FROM users
    WHERE lower(email) = ${email} AND kind = 'human' AND is_active AND anonymized_at IS NULL`;
  await logLogin({ userId: u?.id ?? null, email, method: "reset", success: Boolean(u), reason: u ? "pidió cambiar la contraseña" : "correo desconocido", ip, ua });
  if (!u) return;
  const [{ n: recent }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM user_tokens WHERE user_id = ${u.id} AND purpose = 'reset' AND created_at > now() - interval '1 hour'`;
  if (recent >= 3) return;
  const token = await issueToken(u.id, "reset", null, RESET_MINUTES, ip);
  const link = accessLink(token, origin);
  if (!link.startsWith("http")) return;
  const via = !u.has_password && u.sso_enabled ? "\n\nRecuerda que también puedes entrar con tu cuenta de Google o Microsoft, sin contraseña." : "";
  const sentFrom = await sendSystemEmail({ email: u.email, name: u.name }, u.has_password ? `Cambia tu contraseña ${await appDel()}` : `Crea tu contraseña ${await appDel()}`,
    `Hola, ${u.name.split(" ")[0]}:\n\n${u.has_password ? "Hemos recibido una petición para cambiar tu contraseña" : "Nos has pedido un enlace para crear tu contraseña"}. Si has sido tú, usa este botón.${via}`,
    { label: u.has_password ? "Poner una contraseña nueva" : "Crear mi contraseña", url: link },
    `El enlace caduca en ${RESET_MINUTES} minutos y solo sirve una vez. Si no lo has pedido tú, ignora este correo: no cambia nada.`, null)
    .catch((err) => { console.error("[contraseña]", err); return null; });
  await markSent(token, sentFrom);
  await audit(null, u.id, "reset_requested", { sent: Boolean(sentFrom) });
}

export type TokenInfo =
  | { ok: true; purpose: "invite" | "reset"; name: string; email: string; inviter: string | null; expires_at: Date; sso: boolean; has_password: boolean }
  | { ok: false; reason: "invalid" | "expired" | "used" | "inactive"; purpose?: "invite" | "reset"; inviter?: string | null; has_password?: boolean };

export async function tokenInfo(token: string): Promise<TokenInfo> {
  if (!TOKEN_RE.test(token)) return { ok: false, reason: "invalid" };
  const [t] = await sql<{ purpose: "invite" | "reset"; expires_at: Date; used_at: Date | null; name: string; email: string | null;
                          is_active: boolean; sso_enabled: boolean; inviter: string | null; has_password: boolean }[]>`
    SELECT t.purpose, t.expires_at, t.used_at, u.name, u.email, u.is_active, u.sso_enabled, i.name AS inviter, u.password_hash IS NOT NULL AS has_password
    FROM user_tokens t JOIN users u ON u.id = t.user_id LEFT JOIN users i ON i.id = t.created_by
    WHERE t.token_hash = ${hash(token)}`;
  if (!t || !t.email) return { ok: false, reason: "invalid" };
  const more = { purpose: t.purpose, inviter: t.inviter, has_password: t.has_password };
  if (t.used_at) return { ok: false, reason: "used", ...more };
  if (t.expires_at < new Date()) return { ok: false, reason: "expired", ...more };
  if (!t.is_active) return { ok: false, reason: "inactive", ...more };
  return { ok: true, purpose: t.purpose, name: t.name, email: t.email, inviter: t.inviter, expires_at: t.expires_at, sso: t.sso_enabled, has_password: t.has_password };
}

/** Crea o cambia la contraseña con el enlace. Devuelve el usuario para abrirle sesión. */
export async function completeToken(token: string, password: string, repeat: string, ip: string | null, ua: string | null): Promise<string> {
  // Devuelve el id; el tipo de enlace y si ya tenía contraseña se leen con tokenInfo antes de llamar.
  const info = await tokenInfo(token);
  if (!info.ok) {
    throw new UserError(info.reason === "expired" ? "El enlace ha caducado. Pide otro." : info.reason === "used" ? "Este enlace ya se ha usado. Pide otro si lo necesitas."
      : "El enlace no es válido.");
  }
  if (password !== repeat) throw new UserError("Las dos contraseñas no coinciden.");
  const problem = passwordProblem(password, info.email);
  if (problem) throw new UserError(problem);
  const pwHash = await hashPassword(password);
  const userId = await transaction(async (tx) => {
    const [t] = await tx<{ user_id: string; purpose: string }[]>`
      UPDATE user_tokens SET used_at = now() WHERE token_hash = ${hash(token)} AND used_at IS NULL AND expires_at > now() RETURNING user_id, purpose`;
    if (!t) throw new UserError("Este enlace ya se ha usado. Pide otro si lo necesitas.");
    await tx`UPDATE user_tokens SET used_at = now() WHERE user_id = ${t.user_id} AND used_at IS NULL`;
    await tx`UPDATE users SET password_hash = ${pwHash}, must_change_password = false, failed_logins = 0, locked_until = NULL,
                    last_login_at = now(), last_login_method = 'password', updated_at = now() WHERE id = ${t.user_id}`;
    // Con la contraseña nueva se cierran las sesiones que hubiera abiertas (por si alguien la conocía).
    await tx`DELETE FROM sessions WHERE user_id = ${t.user_id}`;
    return t.user_id;
  });
  await audit(userId, userId, info.purpose === "invite" ? "invite_accepted" : "password_reset");
  await logLogin({ userId, email: info.email, method: "password", success: true, reason: info.purpose === "invite" ? "primera entrada (invitación)" : "contraseña nueva con enlace", ip, ua });
  // Aviso de seguridad solo si ya tenía contraseña (crearla por primera vez no es un cambio).
  if (info.purpose === "reset" && info.has_password) await passwordChangedNotice(userId).catch(() => null);
  return userId;
}

/** Aviso de seguridad cuando cambia la contraseña. */
export async function passwordChangedNotice(userId: string) {
  const [u] = await sql<{ name: string; email: string | null }[]>`SELECT name, email FROM users WHERE id = ${userId}`;
  if (!u?.email) return;
  await sendSystemEmail({ email: u.email, name: u.name }, `Tu contraseña ${await appDel()} ha cambiado`,
    `Hola, ${u.name.split(" ")[0]}:\n\nTu contraseña acaba de cambiar y se han cerrado tus otras sesiones.\n\nSi no has sido tú, avisa cuanto antes a un administrador de tu empresa.`,
    undefined, undefined, null);
}

// ---------------------------------------------------------------------------
// Baja, reactivación y borrado de datos personales

export type OffboardPreview = {
  deals: number; leads: number; activities: number; persons: number; organizations: number; campaigns: number;
  enrollments: number; rules: number; mailbox: string | null; booking: boolean; outbound: number; solo_rules: number;
};

export async function offboardPreview(userId: string): Promise<OffboardPreview> {
  const [r] = await sql<(Omit<OffboardPreview, "booking"> & { booking: boolean })[]>`
    SELECT
      (SELECT count(*)::int FROM deals WHERE owner_id = ${userId} AND status = 'open' AND deleted_at IS NULL) AS deals,
      (SELECT count(*)::int FROM leads WHERE owner_id = ${userId} AND status = 'open' AND deleted_at IS NULL) AS leads,
      (SELECT count(*)::int FROM activities WHERE owner_id = ${userId} AND NOT done) AS activities,
      (SELECT count(*)::int FROM persons WHERE owner_id = ${userId} AND deleted_at IS NULL) AS persons,
      (SELECT count(*)::int FROM organizations WHERE owner_id = ${userId} AND deleted_at IS NULL) AS organizations,
      (SELECT count(*)::int FROM campaigns WHERE owner_id = ${userId} AND status IN ('draft', 'active', 'paused')) AS campaigns,
      (SELECT count(*)::int FROM sequence_enrollments WHERE user_id = ${userId} AND status = 'active') AS enrollments,
      (SELECT count(*)::int FROM assignment_rules WHERE ${userId}::uuid = ANY(user_ids) AND is_active) AS rules,
      (SELECT email FROM mailbox_connections WHERE user_id = ${userId} AND purpose = 'main' LIMIT 1) AS mailbox,
      (SELECT count(*)::int FROM mailbox_connections WHERE user_id = ${userId} AND purpose = 'outbound') AS outbound,
      (SELECT count(*)::int FROM assignment_rules WHERE user_ids = ARRAY[${userId}::uuid] AND is_active) AS solo_rules,
      EXISTS (SELECT 1 FROM booking_pages WHERE user_id = ${userId} AND is_active) AS booking`;
  return r;
}

/** ¿Lleva algo que tenga que pasar a otra persona? */
export const needsReceiver = (p: OffboardPreview) =>
  p.deals + p.leads + p.activities + p.persons + p.organizations + p.campaigns + p.enrollments + p.outbound > 0;

async function adminsLeft(exceptId: string) {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM users
    WHERE kind = 'human' AND role = 'admin' AND is_active AND (password_hash IS NOT NULL OR sso_enabled) AND id <> ${exceptId}`;
  return r.n;
}

/**
 * Da de baja a alguien: deja de poder entrar y lo que llevaba pasa a otra
 * persona (deals y leads abiertos, actividades pendientes, contactos,
 * empresas, campañas, secuencias y reparto automático). Su historia se queda.
 */
export async function offboardUser(actorId: string, userId: string, input: Record<string, unknown>) {
  if (userId === actorId) throw new UserError("No puedes darte de baja a ti mismo.");
  const to = String(input.to ?? "").trim() || null;
  const [u] = await sql<{ role: Role; is_active: boolean; name: string }[]>`SELECT role, is_active, name FROM users WHERE id = ${userId} AND kind = 'human'`;
  if (!u) throw new UserError("Ese usuario no existe.");
  if (!u.is_active) throw new UserError("Ya está dado de baja.");
  if (u.role === "admin" && (await adminsLeft(userId)) === 0) throw new UserError("Tiene que quedar al menos un administrador.");
  const preview = await offboardPreview(userId);
  if (needsReceiver(preview) && !to) throw new UserError("Elige a quién pasa lo que lleva.");
  if (to) {
    const [t] = await sql<{ ok: boolean }[]>`SELECT (is_active AND kind = 'human' AND role <> 'viewer') AS ok FROM users WHERE id = ${to}`;
    if (!t?.ok || to === userId) throw new UserError("Elige a una persona activa que pueda llevar deals.");
  }
  await transaction(async (tx) => {
    if (to) {
      await tx`UPDATE deals SET owner_id = ${to}, updated_at = now() WHERE owner_id = ${userId} AND status = 'open' AND deleted_at IS NULL`;
      await tx`UPDATE leads SET owner_id = ${to}, updated_at = now() WHERE owner_id = ${userId} AND status = 'open' AND deleted_at IS NULL`;
      await tx`UPDATE activities SET owner_id = ${to} WHERE owner_id = ${userId} AND NOT done`;
      await tx`UPDATE persons SET owner_id = ${to} WHERE owner_id = ${userId} AND deleted_at IS NULL`;
      await tx`UPDATE organizations SET owner_id = ${to} WHERE owner_id = ${userId} AND deleted_at IS NULL`;
      await tx`UPDATE campaigns SET owner_id = ${to} WHERE owner_id = ${userId} AND status IN ('draft', 'active', 'paused')`;
      await tx`UPDATE sequence_enrollments SET user_id = ${to} WHERE user_id = ${userId} AND status = 'active'`;
      // Buzones de outbound: son de la empresa, cambian de responsable.
      await tx`UPDATE mailbox_connections SET user_id = ${to} WHERE user_id = ${userId} AND purpose = 'outbound'`;
      await tx`UPDATE assignment_rules SET user_ids = CASE WHEN ${to}::uuid = ANY(user_ids) THEN array_remove(user_ids, ${userId}::uuid)
                                                          ELSE array_replace(user_ids, ${userId}::uuid, ${to}::uuid) END
               WHERE ${userId}::uuid = ANY(user_ids)`;
    } else {
      await tx`UPDATE assignment_rules SET user_ids = array_remove(user_ids, ${userId}::uuid)
               WHERE ${userId}::uuid = ANY(user_ids) AND cardinality(user_ids) > 1`;
      await tx`UPDATE assignment_rules SET is_active = false WHERE ${userId}::uuid = ANY(user_ids)`;
    }
    await tx`DELETE FROM mailbox_connections WHERE user_id = ${userId} AND purpose = 'main'`;
    await tx`UPDATE booking_pages SET is_active = false WHERE user_id = ${userId}`;
    await tx`DELETE FROM followers WHERE user_id = ${userId}`;
    await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
    await tx`UPDATE user_tokens SET used_at = now() WHERE user_id = ${userId} AND used_at IS NULL`;
    await tx`UPDATE users SET is_active = false, deactivated_at = now(), deactivated_by = ${actorId}, updated_at = now() WHERE id = ${userId}`;
  });
  const [toName] = to ? await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${to}` : [];
  await audit(actorId, userId, "deactivated", { to, to_name: toName?.name ?? null, ...preview });
  const { raiseAlert } = await import("./security");
  await raiseAlert({ kind: "deactivated", userId, actorId, title: `${u.name} ha sido dado de baja` });
  return { preview, toName: toName?.name ?? null, name: u.name };
}

export async function reactivateUser(actorId: string, userId: string) {
  const [u] = await sql<{ anonymized_at: Date | null; is_active: boolean }[]>`SELECT anonymized_at, is_active FROM users WHERE id = ${userId} AND kind = 'human'`;
  if (!u) throw new UserError("Ese usuario no existe.");
  if (u.anonymized_at) throw new UserError("Sus datos personales se borraron: invítala de nuevo como una persona nueva.");
  if (u.is_active) return;
  await sql`UPDATE users SET is_active = true, deactivated_at = NULL, deactivated_by = NULL, failed_logins = 0, locked_until = NULL, updated_at = now()
            WHERE id = ${userId}`;
  await audit(actorId, userId, "reactivated");
}

/**
 * Borra los datos personales de alguien dado de baja (RGPD). Sus deals y su
 * historia se conservan a nombre de «Usuario eliminado». No se puede deshacer.
 */
export async function anonymizeUser(actorId: string, userId: string) {
  const [u] = await sql<{ is_active: boolean; anonymized_at: Date | null }[]>`SELECT is_active, anonymized_at FROM users WHERE id = ${userId} AND kind = 'human'`;
  if (!u) throw new UserError("Ese usuario no existe.");
  if (u.is_active) throw new UserError("Primero hay que darle de baja.");
  if (u.anonymized_at) return;
  await transaction(async (tx) => {
    await tx`UPDATE users SET name = 'Usuario eliminado', email = NULL, password_hash = NULL, sso_enabled = false, notification_prefs = '{}'::jsonb,
                    anonymized_at = now(), updated_at = now() WHERE id = ${userId}`;
    await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
    await tx`DELETE FROM user_tokens WHERE user_id = ${userId}`;
    await tx`DELETE FROM notifications WHERE user_id = ${userId}`;
    await tx`DELETE FROM saved_views WHERE user_id = ${userId}`;
    await tx`UPDATE login_events SET email = NULL, ip = NULL, user_agent = NULL WHERE user_id = ${userId}`;
  });
  await audit(actorId, userId, "anonymized");
  const { raiseAlert } = await import("./security");
  await raiseAlert({ kind: "anonymized", userId, actorId, title: "Se han borrado los datos personales de un usuario dado de baja" });
}
