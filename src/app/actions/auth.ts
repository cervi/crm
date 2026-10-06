"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { adminOnly, currentUser, endSession, safeNext, startSession } from "@/lib/auth";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { SESSION_COOKIE, checkCredentials, needsSetup, tokenHash } from "@/lib/session";
import {
  changeOwnPassword, createFirstAdmin, createUser, resetPassword, signOutEverywhere, updateOwnName, updateUser,
} from "@/lib/users";

const str = (form: FormData, key: string) => String(form.get(key) ?? "");

export async function loginAction(_: ActionState, form: FormData): Promise<ActionState> {
  const res = await checkCredentials(str(form, "email"), str(form, "password"));
  if ("error" in res) return { error: res.error };
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
