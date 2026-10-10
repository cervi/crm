"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { adminOnly, currentUser, endSession, safeNext, startSession } from "@/lib/auth";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { logLogin } from "@/lib/login-log";
import { getSsoSettings, saveSsoSettings } from "@/lib/sso";
import { SESSION_COOKIE, checkCredentials, needsSetup, tokenHash } from "@/lib/session";
import {
  changeOwnPassword, createFirstAdmin, createUser, resetPassword, signOutEverywhere, updateOwnName, updateUser,
} from "@/lib/users";

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
  const res = await attempt(async () => { await adminOnly(); await createUser(Object.fromEntries(form)); });
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
  const res = await attempt(async () => { await adminOnly(); await resetPassword(userId, str(form, "password")); });
  revalidatePath("/settings/users");
  return res;
}

export async function signOutUserAction(userId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(async () => { await adminOnly(); await signOutEverywhere(userId); });
  revalidatePath("/settings/users");
  return res;
}

/** Permitir (o no) que alguien entre con Google o Microsoft sin contraseña. */
export async function setUserSsoAction(userId: string, enabled: boolean, _: ActionState): Promise<ActionState> {
  const res = await attempt(async () => {
    const me = await adminOnly();
    if (!enabled && userId === me.id) throw new UserError("No te quites el acceso a ti mismo.");
    await sql`UPDATE users SET sso_enabled = ${enabled} WHERE id = ${userId} AND kind = 'human'`;
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
