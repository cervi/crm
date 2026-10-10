import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { encryptionConfigured } from "@/lib/crypto";
import { isProviderKey, pkce, PROVIDERS, redirectUri } from "@/lib/integrations";
import { safeNext } from "@/lib/auth";
import { COOKIE, COOKIE_PATH, publicOrigin, sealState } from "../shared";

export const dynamic = "force-dynamic";

/** «Continuar con Google / Microsoft» en la pantalla de entrada. */
export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: key } = await params;
  const origin = publicOrigin(req);
  const toLogin = (error: string) => NextResponse.redirect(`${origin}/login?${new URLSearchParams({ error })}`);
  if (!isProviderKey(key)) return toLogin("Proveedor no válido.");
  const provider = PROVIDERS[key];
  if (!provider.configured() || !encryptionConfigured()) return toLogin(`La entrada con ${provider.label} no está configurada.`);
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("base64url");
  const redirect = redirectUri(key, origin);
  const next = safeNext(new URL(req.url).searchParams.get("next"));
  const res = NextResponse.redirect(provider.authorizeUrl({ state, challenge, redirectUri: redirect, login: true }));
  res.cookies.set(COOKIE, sealState({ provider: key, state, verifier, userId: "", redirect, at: Date.now(), purpose: "login", next }), {
    httpOnly: true, sameSite: "lax", secure: redirect.startsWith("https://"), path: COOKIE_PATH, maxAge: 15 * 60,
  });
  return res;
}
