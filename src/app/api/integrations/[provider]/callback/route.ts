import { NextResponse, type NextRequest } from "next/server";
import { isProviderKey, PROVIDERS, ProviderError, providerMessage } from "@/lib/integrations";
import { apiClient } from "@/lib/integrations/http";
import { saveConnection } from "@/lib/mailbox";
import { back, COOKIE, COOKIE_PATH, openState, publicOrigin } from "../shared";

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
