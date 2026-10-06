import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { currentUser } from "@/lib/auth";
import { encryptionConfigured } from "@/lib/crypto";
import { isProviderKey, pkce, PROVIDERS, redirectUri } from "@/lib/integrations";
import { isId } from "@/lib/validation";
import { back, COOKIE, COOKIE_PATH, publicOrigin, sealState } from "../shared";

export const dynamic = "force-dynamic";

/** Empieza la conexión de la cuenta de un usuario: lleva al inicio de sesión del proveedor. */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: key } = await params;
  const origin = publicOrigin(req);
  if (!isProviderKey(key)) return NextResponse.redirect(back(origin, { error: "Proveedor no válido." }));
  const provider = PROVIDERS[key];
  if (!provider.configured() || !encryptionConfigured()) {
    return NextResponse.redirect(back(origin, { error: `Falta configurar la conexión con ${provider.label} (ver instrucciones).` }));
  }
  const userId = new URL(req.url).searchParams.get("user");
  // «outbound»: un buzón de otro dominio para las campañas (solo administradores).
  const purpose = new URL(req.url).searchParams.get("purpose") === "outbound" ? "outbound" as const : "main" as const;
  const [user] = isId(userId)
    ? await sql<{ id: string; email: string | null }[]>`SELECT id, email FROM users WHERE id = ${userId} AND kind = 'human' AND is_active`
    : [];
  if (!user) return NextResponse.redirect(back(origin, { error: "Usuario no válido." }));
  // Cada uno conecta su cuenta; un administrador puede hacerlo por cualquiera.
  const me = await currentUser();
  if (!me || (me.id !== user.id && me.role !== "admin")) {
    return NextResponse.redirect(back(origin, { error: "Solo puedes conectar tu propia cuenta." }));
  }
  if (purpose === "outbound" && me.role !== "admin") {
    return NextResponse.redirect(back(origin, { error: "Los buzones de outbound los conecta un administrador." }));
  }

  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const redirect = redirectUri(key, origin);
  const res = NextResponse.redirect(provider.authorizeUrl({ state, challenge, redirectUri: redirect, loginHint: purpose === "main" ? user.email ?? undefined : undefined }));
  res.cookies.set(COOKIE, sealState({ provider: key, state, verifier, userId: user.id, redirect, at: Date.now(), purpose }), {
    httpOnly: true, sameSite: "lax", secure: redirect.startsWith("https://"), path: COOKIE_PATH, maxAge: 15 * 60,
  });
  return res;
}
