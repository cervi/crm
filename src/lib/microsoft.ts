import { createHash, randomBytes } from "node:crypto";
import { UserError } from "./errors";

// ===========================================================================
// Microsoft 365 (Outlook): inicio de sesión OAuth y llamadas a Microsoft Graph.
//
// Configuración (registro de la app en Microsoft Entra):
//   MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID (por defecto «organizations»)
//   APP_URL: dirección pública del CRM; la de vuelta es
//            <APP_URL>/api/integrations/microsoft/callback
// MS_LOGIN_URL y MS_GRAPH_URL solo se cambian en pruebas (servidor simulado).
// ===========================================================================

export const SCOPES = [
  "openid", "email", "profile", "offline_access",
  "User.Read", "Mail.Read", "Mail.Send", "Calendars.ReadWrite", "MailboxSettings.Read",
];

const LOGIN = () => (process.env.MS_LOGIN_URL ?? "https://login.microsoftonline.com").replace(/\/$/, "");
const GRAPH = () => (process.env.MS_GRAPH_URL ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
const TENANT = () => process.env.MS_TENANT_ID || "organizations";

export const microsoftConfigured = () => Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

export function redirectUri(origin: string) {
  return `${(process.env.APP_URL || origin).replace(/\/$/, "")}/api/integrations/microsoft/callback`;
}

export type Tokens = { access_token: string; refresh_token: string; expires_at: number };

/** PKCE: verificador y su desafío. */
export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function authorizeUrl(opts: { state: string; challenge: string; redirectUri: string; loginHint?: string }) {
  const q = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: opts.redirectUri,
    response_mode: "query",
    scope: SCOPES.join(" "),
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  if (opts.loginHint) q.set("login_hint", opts.loginHint);
  return `${LOGIN()}/${TENANT()}/oauth2/v2.0/authorize?${q}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${LOGIN()}/${TENANT()}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID ?? "",
      client_secret: process.env.MS_CLIENT_SECRET ?? "",
      scope: SCOPES.join(" "),
      ...body,
    }),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof j.access_token !== "string") {
    const err = new MicrosoftError(String(j.error_description ?? j.error ?? `HTTP ${res.status}`).split("\r\n")[0], String(j.error ?? ""));
    throw err;
  }
  return {
    access_token: j.access_token,
    refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : body.refresh_token ?? "",
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
  };
}

export class MicrosoftError extends Error {
  constructor(message: string, public code = "", public status = 0) { super(message); }
  /** El permiso se ha revocado o caducado: hay que volver a conectar. */
  get needsReconnect() { return this.code === "invalid_grant" || this.code === "interaction_required" || this.status === 401; }
}

export const exchangeCode = (code: string, verifier: string, redirect: string) =>
  tokenRequest({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect });

export const refreshTokens = (refreshToken: string) =>
  tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

/**
 * Cliente de Graph para un buzón. `getTokens` y `saveTokens` permiten
 * renovar el acceso y guardar el token nuevo (Microsoft lo rota).
 */
export function graphClient(tokens: Tokens, saveTokens: (t: Tokens) => Promise<void>) {
  let current = tokens;
  async function token() {
    if (current.expires_at - Date.now() < 120_000) {
      current = await refreshTokens(current.refresh_token);
      await saveTokens(current);
    }
    return current.access_token;
  }
  async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}, retried = false): Promise<T> {
    const url = path.startsWith("http") ? path : `${GRAPH()}${path}`;
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await token()}`);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    const res = await fetch(url, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    if (res.status === 401 && !retried) {
      current = { ...current, expires_at: 0 }; // fuerza la renovación y reintenta una vez
      return call<T>(path, init, true);
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new MicrosoftError(j.error?.message ?? `Microsoft respondió ${res.status}`, j.error?.code ?? "", res.status);
    }
    if (res.status === 202 || res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  /** Recorre todas las páginas (@odata.nextLink) hasta `max` elementos. */
  async function all<T>(path: string, max = 1000, headers?: HeadersInit): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next && out.length < max) {
      const page: { value: T[]; "@odata.nextLink"?: string } = await call(next, { headers });
      out.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return out.slice(0, max);
  }
  return { call, all };
}

export type GraphClient = ReturnType<typeof graphClient>;

/** Errores de Microsoft en un mensaje para la interfaz. */
export function microsoftMessage(err: unknown) {
  if (err instanceof MicrosoftError) {
    return err.needsReconnect ? "Microsoft ha retirado el acceso: vuelve a conectar el correo." : `Microsoft: ${err.message}`;
  }
  if (err instanceof UserError) return err.message;
  return "No se pudo hablar con Microsoft.";
}
