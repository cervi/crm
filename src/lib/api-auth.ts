import { timingSafeEqual, createHash } from "node:crypto";

/** Claves válidas: variable INBOUND_API_KEYS, separadas por comas. */
function configuredKeys(): string[] {
  return (process.env.INBOUND_API_KEYS ?? "").split(",").map((k) => k.trim()).filter((k) => k.length >= 16);
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export type ApiAuth = { ok: true } | { ok: false; status: 401 | 503; error: string };

/** Comprueba la clave enviada en `Authorization: Bearer …` o `X-Api-Key`. */
export function checkApiKey(headers: Headers): ApiAuth {
  const keys = configuredKeys();
  if (keys.length === 0) {
    return { ok: false, status: 503, error: "La API de entrada no está configurada (falta INBOUND_API_KEYS)." };
  }
  const auth = headers.get("authorization") ?? "";
  const sent = (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : headers.get("x-api-key") ?? "").trim();
  if (!sent) return { ok: false, status: 401, error: "Falta la clave de API." };
  // Comparación en tiempo constante (sobre el hash, para que la longitud no importe).
  const ok = keys.some((k) => timingSafeEqual(digest(k), digest(sent)));
  return ok ? { ok: true } : { ok: false, status: 401, error: "Clave de API no válida." };
}
