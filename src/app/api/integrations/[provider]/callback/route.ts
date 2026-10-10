import { NextResponse, type NextRequest } from "next/server";
import { isProviderKey, PROVIDERS, ProviderError, providerMessage } from "@/lib/integrations";
import { apiClient } from "@/lib/integrations/http";
import { saveConnection } from "@/lib/mailbox";
import { back, COOKIE, COOKIE_PATH, openState, publicOrigin } from "../shared";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { ssoLogin } from "@/lib/sso";
import { clientInfo } from "@/lib/esign-request";

export const dynamic = "force-dynamic";

/** Vuelta del inicio de sesión del proveedor: guarda la cuenta conectada. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: key } = await params;
  const origin = publicOrigin(req);
  const url = new URL(req.url);
  const saved = openState(req.cookies.get(COOKIE)?.value);
  const done = (p: Record<string, string>) => {
    const res = NextResponse.redirect(back(origin, p));
    res.cookies.set(COOKIE, "", { path: COOKIE_PATH, maxAge: 0 });
    return res;
  };
  if (!isProviderKey(key)) return done({ error: "Proveedor no válido." });
  const provider = PROVIDERS[key];

  // Entrar al CRM con Google o Microsoft.
  if (saved?.purpose === "login") {
    const toLogin = (error: string) => {
      const res = NextResponse.redirect(`${origin}/login?${new URLSearchParams({ error })}`);
      res.cookies.set(COOKIE, "", { path: COOKIE_PATH, maxAge: 0 });
      return res;
    };
    const code = url.searchParams.get("code");
    if (url.searchParams.get("error")) return toLogin(`${provider.label} no ha confirmado tu cuenta. Vuelve a intentarlo.`);
    if (saved.provider !== key || !code || url.searchParams.get("state") !== saved.state) return toLogin("La entrada ha caducado. Vuelve a intentarlo.");
    try {
      const tokens = await provider.exchangeCode(code, saved.verifier, saved.redirect, true);
      const client = apiClient({ provider: provider.label, tokens, refresh: provider.refresh, save: async () => {} });
      const me = await provider.profile(client);
      const { ip, ua } = clientInfo(req.headers);
      const r = await ssoLogin(key, me.email, me.displayName, ip, ua);
      if ("error" in r) return toLogin(r.error);
      const s = await createSession(r.userId, ua);
      const res = NextResponse.redirect(`${origin}${saved.next || "/"}`);
      res.cookies.set(COOKIE, "", { path: COOKIE_PATH, maxAge: 0 });
      res.cookies.set(SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "lax", path: "/", expires: s.expires, secure: origin.startsWith("https://") });
      return res;
    } catch (err) {
      return toLogin(err instanceof ProviderError || !(err instanceof Error) ? providerMessage(err) : err.message);
    }
  }

  if (url.searchParams.get("error")) {
    const msg = url.searchParams.get("error_description")?.split("\n")[0] ?? url.searchParams.get("error")!;
    return done({ error: `${provider.label} no ha dado acceso: ${msg}` });
  }
  const code = url.searchParams.get("code");
  if (!saved || saved.provider !== key || !code || url.searchParams.get("state") !== saved.state) {
    return done({ error: "La conexión ha caducado o no es válida. Vuelve a intentarlo." });
  }

  try {
    const tokens = await provider.exchangeCode(code, saved.verifier, saved.redirect);
    if (!tokens.refresh_token) throw new Error(`${provider.label} no ha entregado acceso permanente. Quita el acceso del CRM en tu cuenta y vuelve a conectar.`);
    const client = apiClient({ provider: provider.label, tokens, refresh: provider.refresh, save: async () => {} });
    const me = await provider.profile(client);
    await saveConnection({ userId: saved.userId, provider: key, email: me.email, displayName: me.displayName, tokens, scheduling: me.scheduling, purpose: saved.purpose });
    return done({ connected: me.email, ...(saved.purpose === "outbound" ? { outbound: "1" } : {}) });
  } catch (err) {
    return done({ error: err instanceof ProviderError || !(err instanceof Error) ? providerMessage(err) : err.message });
  }
}
