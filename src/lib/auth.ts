import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { UserError } from "./errors";
import { sql } from "./db";
import type { Actor } from "./events";
import { SESSION_COOKIE, createSession, deleteSession, sessionUser, type Role, type SessionUser } from "./session";

// ===========================================================================
// Quién está usando la aplicación y qué puede hacer.
//   admin  → todo (ajustes y usuarios incluidos)
//   member → el trabajo del día a día
//   viewer → solo lectura
// El proxy ya deja fuera a quien no tiene sesión; aquí se comprueba el rol.
// ===========================================================================

export const ROLE_LABELS: Record<Role, string> = { admin: "Administrador", member: "Comercial", viewer: "Solo lectura" };

/** El usuario de la sesión actual (una consulta por petición). */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return sessionUser(token);
});

/** Para páginas: el usuario, o a la pantalla de entrada. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent((await headers()).get("x-pathname") ?? "/")}`);
  return user;
}

/** Para páginas de ajustes reservadas a administradores. */
export async function requireAdminPage(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/settings?denied=1");
  return user;
}

/** Para acciones que cambian datos: el actor que queda en la historia. */
/**
 * Mientras se importa todo desde Pipedrive, nadie cambia datos: lo que se
 * tocara podría pisarse o quedar a medias. (Las sincronizaciones horarias,
 * que solo traen lo cambiado, no bloquean.)
 */
export async function assertNoImport() {
  const [j] = await sql<{ step: string }[]>`
    SELECT step FROM import_jobs WHERE status = 'running' AND (options->>'since') IS NULL LIMIT 1`.catch(() => []);
  if (j) throw new UserError("Hay una importación de Pipedrive en marcha: espera a que termine para hacer cambios (puedes seguir mirando).");
}

export async function writer(opts: { duringImport?: boolean } = {}): Promise<Actor> {
  const user = await currentUser();
  if (!user) throw new UserError("Tu sesión ha caducado: vuelve a entrar.");
  if (user.role === "viewer") throw new UserError("Tu usuario es de solo lectura: pide a un administrador que te cambie el rol.");
  if (!opts.duringImport) await assertNoImport();
  return { type: "user", id: user.id };
}

/** Para acciones de ajustes: solo administradores. */
export async function adminOnly(opts: { duringImport?: boolean } = {}): Promise<Actor> {
  const user = await currentUser();
  if (!user) throw new UserError("Tu sesión ha caducado: vuelve a entrar.");
  if (user.role !== "admin") throw new UserError("Solo un administrador puede cambiar esto.");
  if (!opts.duringImport) await assertNoImport();
  return { type: "user", id: user.id };
}

/** Acciones sobre la cuenta de un usuario (su buzón, su resumen…): él mismo o un administrador. */
export async function selfOrAdmin(userId: string): Promise<Actor> {
  const user = await currentUser();
  if (!user) throw new UserError("Tu sesión ha caducado: vuelve a entrar.");
  if (user.id !== userId && user.role !== "admin") throw new UserError("Solo puedes cambiar tu propia cuenta.");
  return { type: "user", id: user.id };
}

export async function startSession(userId: string) {
  const ua = (await headers()).get("user-agent");
  const { token, expires } = await createSession(userId, ua);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", path: "/", expires,
    secure: (process.env.APP_URL ?? "").startsWith("https://"),
  });
}

export async function endSession() {
  const jar = await cookies();
  await deleteSession(jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
}

/** Solo rutas internas como destino tras entrar (nada de «//otro-sitio»). */
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

/**
 * Comprobación de permisos para acciones que devuelven estado de formulario:
 * en vez de lanzar, devuelve { error } para mostrarlo junto al formulario.
 */
export async function guard(kind: "write" | "admin" | { self: string }, opts: { duringImport?: boolean } = {}): Promise<{ actor: Actor } | { error: string }> {
  try {
    return { actor: kind === "write" ? await writer(opts) : kind === "admin" ? await adminOnly(opts) : await selfOrAdmin(kind.self) };
  } catch (e) {
    return { error: e instanceof UserError ? e.message : "No tienes permiso para hacer esto." };
  }
}
