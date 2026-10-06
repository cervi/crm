import { decrypt, encrypt } from "@/lib/crypto";

export const COOKIE = "oauth_state";
export const COOKIE_PATH = "/api/integrations";

export type OAuthState = { provider: string; state: string; verifier: string; userId: string; redirect: string; at: number; purpose?: "main" | "outbound" };

export const sealState = (s: OAuthState) => encrypt(JSON.stringify(s));
export function openState(raw: string | undefined): OAuthState | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(decrypt(raw)) as OAuthState;
    return Date.now() - s.at < 15 * 60000 ? s : null;
  } catch {
    return null;
  }
}

/** Dirección pública con la que llegó la petición (detrás de un proxy, la reenviada). */
export function publicOrigin(req: Request) {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

export const back = (origin: string, params: Record<string, string>) =>
  `${origin}/settings/mailbox?${new URLSearchParams(params)}`;
