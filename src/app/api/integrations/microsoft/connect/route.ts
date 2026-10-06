import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { encryptionConfigured } from "@/lib/crypto";
import { authorizeUrl, microsoftConfigured, pkce, redirectUri } from "@/lib/microsoft";
import { isId } from "@/lib/validation";
import { back, COOKIE, COOKIE_PATH, publicOrigin, sealState } from "../shared";

export const dynamic = "force-dynamic";

/** Empieza la conexión del correo de un usuario: lleva al inicio de sesión de Microsoft. */
export async function GET(req: Request) {
  const origin = publicOrigin(req);
  const userId = new URL(req.url).searchParams.get("user");
  if (!microsoftConfigured() || !encryptionConfigured()) {
    return NextResponse.redirect(back(origin, { error: "Falta configurar la conexión con Microsoft (ver instrucciones)." }));
  }
  const [user] = isId(userId)
    ? await sql<{ id: string; email: string | null }[]>`SELECT id, email FROM users WHERE id = ${userId} AND kind = 'human' AND is_active`
    : [];
  if (!user) return NextResponse.redirect(back(origin, { error: "Usuario no válido." }));

  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const redirect = redirectUri(origin);
  const res = NextResponse.redirect(authorizeUrl({ state, challenge, redirectUri: redirect, loginHint: user.email ?? undefined }));
  res.cookies.set(COOKIE, sealState({ state, verifier, userId: user.id, redirect, at: Date.now() }), {
    httpOnly: true, sameSite: "lax", secure: redirect.startsWith("https://"), path: COOKIE_PATH, maxAge: 15 * 60,
  });
  return res;
}
