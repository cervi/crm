"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { adminOnly, currentUser, endSession, safeNext, startSession } from "@/lib/auth";
import { attempt, toUserMessage, UserError, type ActionState } from "@/lib/errors";
import { logLogin } from "@/lib/login-log";
import { getSsoSettings, saveSsoSettings } from "@/lib/sso";
import { SESSION_COOKIE, checkCredentials, needsSetup, tokenHash } from "@/lib/session";
import {
  changeOwnPassword, createFirstAdmin, createUser, resetPassword, signOutEverywhere, updateOwnName, updateUser,
} from "@/lib/users";
import {
  anonymizeUser, audit, cancelInvite, completeToken, inviteUser, offboardUser, reactivateUser, requestPasswordReset, resendInvite, sendResetLink,
} from "@/lib/user-lifecycle";

/** Origen del navegador (para el enlace que se copia si no hay APP_URL). */
async function origin() {
  const h = await headers();
  return `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
}
async function client() {
  const h = await headers();
  return { ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null, ua: h.get("user-agent") };
}
/** Resultado de un envío de enlace: si salió por correo, desde dónde; si no, el enlace para copiarlo. */
export type LinkState = ActionState & { link?: string; sentFrom?: string | null };

const str = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function loginAction(_: ActionState, form: FormData): Promise<ActionState> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null, ua = h.get("user-agent");
  const email = str(form, "email");
  const res = await checkCredentials(email, str(form, "password"));
  if ("error" in res) { await logLogin({ email, method: "password", success: false, reason: res.error, ip, ua }); return { error: res.error }; }
  // Si la empresa solo deja entrar con Google o Microsoft, la contraseña vale únicamente para los administradores (por si acaso).
  const sso = await getSsoSettings();
  if (!sso.passwordLogin && res.user.role !== "admin") {
    await logLogin({ userId: res.user.id, email, method: "password", success: false, reason: "contraseña desactivada", ip, ua });
    return { error: "En esta empresa se entra con Google o Microsoft: usa el botón de arriba." };
  }
  await logLogin({ userId: res.user.id, email, method: "password", success: true, ip, ua });
  await startSession(res.user.id);
  redirect(res.user.must_change_password ? "/account?change=1" : safeNext(form.get("next")));
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}

export async function setupAction(_: ActionState, form: FormData): Promise<ActionState> {
  const code = process.env.SETUP_CODE ?? "";
  if (process.env.NODE_ENV === "production" && (!code || str(form, "code") !== code)) {
    return { error: code ? "El código de puesta en marcha no es correcto." : "Define SETUP_CODE en el servidor para crear el primer administrador." };
  }
  let userId = "";
  const res = await attempt(async () => {
    if (!(await needsSetup())) throw new UserError("La aplicación ya está en marcha: entra con tu usuario.");
    userId = await createFirstAdmin(Object.fromEntries(form));
  });
  if (res?.error) return res;
  await startSession(userId);
  redirect("/");
}

// --- Mi cuenta
export async function changePasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await currentUser();
  if (!me) return { error: "Tu sesión ha caducado: vuelve a entrar." };
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const res = await attempt(() => changeOwnPassword(me.id, str(form, "current"), str(form, "password"), str(form, "repeat"), token ? tokenHash(token) : undefined));
  if (res?.error) return res;
  if (me.must_change_password) redirect("/");
  revalidatePath("/account");
  return { ok: true };
}

export async function updateProfileAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await currentUser();
  if (!me) return { error: "Tu sesión ha caducado: vuelve a entrar." };
  const res = await attempt(() => updateOwnName(me.id, form.get("name")));
  revalidatePath("/", "layout");
  return res;
}

export async function signOutOthersAction(_: ActionState): Promise<ActionState> {
  const me = await currentUser();
  if (!me) return { error: "Tu sesión ha caducado: vuelve a entrar." };
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  await sql`DELETE FROM sessions WHERE user_id = ${me.id} AND token_hash <> ${token ? tokenHash(token) : ""}`;
  revalidatePath("/account");
  return { ok: true };
}

// --- Usuarios (administradores)
export async function createUserAction(_: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => { const me = await adminOnly(); await createUser(Object.fromEntries(form), me.id); });
  revalidatePath("/settings/users");
  return res;
}

export async function updateUserAction(userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => {
    const me = await adminOnly();
    await updateUser(me.id!, userId, Object.fromEntries(form));
  });
  revalidatePath("/settings/users");
  return res;
}

export async function resetPasswordAction(userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => { const me = await adminOnly(); await resetPassword(userId, str(form, "password"), me.id); });
  revalidatePath("/settings/users");
  return res;
}

export async function signOutUserAction(userId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(async () => { const me = await adminOnly(); await signOutEverywhere(userId, me.id); });
  revalidatePath("/settings/users");
  return res;
}

/** Permitir (o no) que alguien entre con Google o Microsoft sin contraseña. */
export async function setUserSsoAction(userId: string, enabled: boolean, _: ActionState): Promise<ActionState> {
  const res = await attempt(async () => {
    const me = await adminOnly();
    if (!enabled && userId === me.id) throw new UserError("No te quites el acceso a ti mismo.");
    await sql`UPDATE users SET sso_enabled = ${enabled} WHERE id = ${userId} AND kind = 'human'`;
    await audit(me.id, userId, enabled ? "sso_on" : "sso_off");
    if (!enabled) await sql`DELETE FROM sessions WHERE user_id = ${userId} AND NOT EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND password_hash IS NOT NULL)`;
  });
  revalidatePath("/settings/users");
  return res;
}

export async function saveSsoSettingsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => { await adminOnly(); await saveSsoSettings(Object.fromEntries(form)); });
  revalidatePath("/settings/security");
  return res;
}

/** Cerrar una sesión concreta de cualquiera (desde el registro de accesos). */
export async function endSessionAction(sessionId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(async () => { await adminOnly(); await sql`DELETE FROM sessions WHERE id = ${sessionId}`; });
  revalidatePath("/settings/security");
  return res;
}

// --- Ciclo de vida: invitar, enlaces de contraseña, baja, reactivar, borrar datos

export async function inviteUserAction(_: LinkState, form: FormData): Promise<LinkState> {
  try {
    const me = await adminOnly();
    const r = await inviteUser(me.id!, Object.fromEntries(form), await origin());
    revalidatePath("/settings/users");
    return { ok: true, link: r.link, sentFrom: r.sentFrom,
      message: r.sentFrom ? `Invitación enviada a ${r.email} desde ${r.sentFrom}.` : `${r.name} ya está dado de alta. No hay ningún buzón conectado para enviar el correo: cópiale el enlace.` };
  } catch (err) { return { error: toUserMessage(err) }; }
}

export async function resendInviteAction(userId: string, _: LinkState): Promise<LinkState> {
  try {
    const me = await adminOnly();
    const r = await resendInvite(me.id!, userId, await origin());
    revalidatePath("/settings/users");
    return { ok: true, link: r.link, sentFrom: r.sentFrom,
      message: r.sentFrom ? `Invitación reenviada a ${r.email}. El enlace anterior ya no sirve.` : "Enlace nuevo creado (el anterior ya no sirve). Cópialo y envíaselo." };
  } catch (err) { return { error: toUserMessage(err) }; }
}

export async function cancelInviteAction(userId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(async () => { const me = await adminOnly(); await cancelInvite(me.id!, userId); });
  revalidatePath("/settings/users");
  return res;
}

export async function sendResetLinkAction(userId: string, _: LinkState): Promise<LinkState> {
  try {
    const me = await adminOnly();
    const r = await sendResetLink(me.id!, userId, await origin());
    revalidatePath("/settings/users");
    return { ok: true, link: r.link, sentFrom: r.sentFrom,
      message: r.sentFrom ? `Enlace enviado a ${r.email}. Caduca en 24 horas.` : "No hay ningún buzón conectado para enviarlo: cópiale el enlace (caduca en 24 horas)." };
  } catch (err) { return { error: toUserMessage(err) }; }
}

export async function offboardUserAction(userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  try {
    const me = await adminOnly();
    const r = await offboardUser(me.id!, userId, Object.fromEntries(form));
    revalidatePath("/settings/users");
    return { ok: true, message: `${r.name} ya no puede entrar.${r.toName ? ` Lo que llevaba es ahora de ${r.toName}.` : ""}` };
  } catch (err) { return { error: toUserMessage(err) }; }
}

export async function reactivateUserAction(userId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(async () => { const me = await adminOnly(); await reactivateUser(me.id!, userId); });
  revalidatePath("/settings/users");
  return res;
}

export async function anonymizeUserAction(userId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(async () => { const me = await adminOnly(); await anonymizeUser(me.id!, userId); });
  revalidatePath("/settings/users");
  return res;
}

/** «¿Has olvidado tu contraseña?»: siempre la misma respuesta, exista o no el correo. */
export async function forgotPasswordAction(_: ActionState, form: FormData): Promise<ActionState> {
  try {
    const c = await client();
    await requestPasswordReset(str(form, "email"), c.ip, c.ua, await origin());
  } catch (err) { return { error: toUserMessage(err) }; }
  return { ok: true, message: "Si ese correo tiene cuenta, te acabamos de enviar un enlace para poner una contraseña nueva. Caduca en 60 minutos. Revisa también el correo no deseado." };
}

/** Crear la contraseña desde una invitación o cambiarla desde el enlace; abre la sesión. */
export async function completeTokenAction(token: string, _: ActionState, form: FormData): Promise<ActionState> {
  let userId = "";
  try {
    const c = await client();
    userId = await completeToken(token, str(form, "password"), str(form, "repeat"), c.ip, c.ua);
  } catch (err) { return { error: toUserMessage(err) }; }
  await startSession(userId);
  redirect("/?bienvenida=1");
}

export async function saveSystemMailAction(_: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => {
    await adminOnly();
    const id = str(form, "user_id") || null;
    if (id) {
      const [ok] = await sql`SELECT 1 FROM users u JOIN mailbox_connections m ON m.user_id = u.id AND m.purpose = 'main'
                             WHERE u.id = ${id} AND u.role = 'admin' AND u.is_active`;
      if (!ok) throw new UserError("Ese buzón no es de un administrador con el correo conectado.");
    }
    await sql`UPDATE app_settings SET system_mail_user_id = ${id}`;
  });
  revalidatePath("/settings/security");
  return res;
}
