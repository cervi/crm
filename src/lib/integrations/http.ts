import { createHash, randomBytes } from "node:crypto";
import { UserError } from "../errors";

// Piezas comunes a los proveedores (Microsoft 365 y Google Workspace):
// tokens OAuth, PKCE, un cliente HTTP que renueva el acceso solo y los errores.

export type Tokens = { access_token: string; refresh_token: string; expires_at: number };

export class ProviderError extends Error {
  constructor(message: string, public provider: string, public code = "", public status = 0) { super(message); }
  /** El permiso se ha revocado o caducado: hay que volver a conectar. */
  get needsReconnect() {
    return this.code === "invalid_grant" || this.code === "interaction_required" || this.status === 401;
  }
}

/** Errores de un proveedor en un mensaje para la interfaz. */
export function providerMessage(err: unknown) {
  if (err instanceof ProviderError) {
    return err.needsReconnect ? `${err.provider} ha retirado el acceso: vuelve a conectar la cuenta.` : `${err.provider}: ${err.message}`;
  }
  if (err instanceof UserError) return err.message;
  return "No se pudo conectar con el proveedor.";
}

/** PKCE: verificador y su desafío. */
export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Petición al punto de tokens OAuth (código o renovación). */
export async function tokenRequest(provider: string, url: string, body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof j.access_token !== "string") {
    throw new ProviderError(String(j.error_description ?? j.error ?? `HTTP ${res.status}`).split("\r\n")[0], provider, String(j.error ?? ""));
  }
  return {
    access_token: j.access_token,
    refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : body.refresh_token ?? "",
    expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
  };
}

export type ApiClient = {
  call<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T>;
};

/**
 * Cliente autenticado: renueva el acceso antes de que caduque (y una vez si
 * el proveedor responde 401) y guarda los tokens nuevos.
 */
export function apiClient(opts: {
  provider: string;
  tokens: Tokens;
  refresh: (refreshToken: string) => Promise<Tokens>;
  save: (t: Tokens) => Promise<void>;
}): ApiClient {
  let current = opts.tokens;
  async function token() {
    if (current.expires_at - Date.now() < 120_000) {
      current = await opts.refresh(current.refresh_token);
      await opts.save(current);
    }
    return current.access_token;
  }
  async function call<T>(url: string, init: RequestInit & { json?: unknown } = {}, retried = false): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await token()}`);
    if (init.json !== undefined) headers.set("content-type", "application/json");
    const res = await fetch(url, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
    if (res.status === 401 && !retried) {
      current = { ...current, expires_at: 0 }; // fuerza la renovación y reintenta una vez
      return call<T>(url, init, true);
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: { code?: string | number; status?: string; message?: string } | string };
      const e = typeof j.error === "object" ? j.error : { message: j.error };
      throw new ProviderError(e?.message ?? `respondió ${res.status}`, opts.provider, String(e?.status ?? e?.code ?? ""), res.status);
    }
    if (res.status === 202 || res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  return { call };
}

/** Emails dentro de una cabecera como «Ana <ana@x.com>, b@y.com». */
export function parseAddresses(header: string | null | undefined): string[] {
  return [...(header ?? "").matchAll(/[^\s<>,;"']+@[^\s<>,;"']+/g)].map((m) => m[0].toLowerCase());
}
