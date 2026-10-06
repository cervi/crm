import { createHash } from "node:crypto";

// ===========================================================================
// Quién abre un correo o una propuesta: dispositivo, programa de correo,
// lugar aproximado y si la apertura parece automática. Sin dependencias para
// poder probarlo aislado.
//
// El lugar solo se conoce si el CRM está detrás de un proxy que lo indica
// (Cloudflare, Vercel, CloudFront…); no se consulta ningún servicio externo.
// ===========================================================================

export type Device = "mobile" | "tablet" | "desktop" | "unknown";
export type ReaderInfo = { device: Device; client: string | null; place: string | null; reader: string; automatic: boolean; why: string | null };

export const DEVICE_LABEL: Record<Device, string> = { mobile: "Móvil", tablet: "Tableta", desktop: "Ordenador", unknown: "Dispositivo desconocido" };

/** Escáneres de seguridad, robots y librerías: abren o siguen enlaces sin que nadie lea. */
const BOTS = /bot\b|crawler|spider|scanner|barracuda|mimecast|proofpoint|symantec|messagelabs|forcepoint|trend ?micro|sophos|fortiguard|safelinks|cisco|ironport|curl\/|wget|python|go-http|java\/|okhttp|axios|node-fetch|headless/i;

function headerOf(h: Headers, ...names: string[]) {
  for (const n of names) {
    const v = h.get(n)?.trim();
    if (v) {
      try { return decodeURIComponent(v); } catch { return v; }
    }
  }
  return null;
}

export function clientOf(ua: string): string | null {
  if (/GoogleImageProxy|ggpht\.com/i.test(ua)) return "Gmail";
  if (/YahooMailProxy/i.test(ua)) return "Yahoo Mail";
  if (/Microsoft Outlook|ms-office|MSOffice|Outlook-iOS|Outlook-Android/i.test(ua)) return "Outlook";
  if (/Thunderbird/i.test(ua)) return "Thunderbird";
  if (/Superhuman/i.test(ua)) return "Superhuman";
  if (/(iPhone|iPad|Macintosh).*AppleWebKit(?!.*Safari)/i.test(ua)) return "Apple Mail";
  if (/Edg\//i.test(ua)) return "Navegador (Edge)";
  if (/Firefox\//i.test(ua)) return "Navegador (Firefox)";
  if (/Chrome\//i.test(ua)) return "Navegador (Chrome)";
  if (/Safari\//i.test(ua)) return "Navegador (Safari)";
  return null;
}

export function deviceOf(ua: string): Device {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/Mobile|iPhone|iPod|Android|Outlook-iOS|Outlook-Android/i.test(ua)) return "mobile";
  if (/Windows|Macintosh|X11|Linux|CrOS|Microsoft Outlook|Thunderbird/i.test(ua)) return "desktop";
  return "unknown";
}

export function placeOf(h: Headers): string | null {
  const city = headerOf(h, "x-vercel-ip-city", "cf-ipcity", "cloudfront-viewer-city", "x-geo-city");
  const country = headerOf(h, "x-vercel-ip-country", "cf-ipcountry", "cloudfront-viewer-country", "x-geo-country");
  const c = country && /^[A-Z]{2}$/i.test(country) && country.toUpperCase() !== "XX" ? country.toUpperCase() : null;
  return [city, c].filter(Boolean).join(", ").slice(0, 120) || null;
}

const ipOf = (h: Headers) => (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim();

/**
 * Lee la petición del píxel o del enlace. `sentAt` sirve para detectar
 * aperturas que llegan a los pocos segundos del envío: las hacen los
 * escáneres del servidor de correo, no una persona.
 */
export function readerOf(h: Headers, sentAt: Date | null, now = new Date()): ReaderInfo {
  const ua = (h.get("user-agent") ?? "").slice(0, 500);
  const client = clientOf(ua);
  let device = deviceOf(ua);
  // Gmail y Yahoo pasan las imágenes por su proxy: no se sabe el dispositivo.
  if (client === "Gmail" || client === "Yahoo Mail") device = "unknown";
  const reader = createHash("sha256").update(`${ipOf(h)}|${ua}`).digest("base64url").slice(0, 16);
  let why: string | null = null;
  if (!ua) why = "Sin identificación del programa";
  else if (BOTS.test(ua)) why = "Escáner de seguridad o robot";
  // La protección de privacidad de Apple Mail precarga las imágenes con un agente mínimo.
  else if (/^Mozilla\/5\.0$/.test(ua.trim())) why = "Precarga de Apple Mail (protección de privacidad)";
  else if (sentAt && now.getTime() - new Date(sentAt).getTime() < 8000) why = "Al instante del envío (escáner del servidor)";
  return { device, client: why?.startsWith("Precarga") ? "Apple Mail" : client, place: placeOf(h), reader, automatic: why !== null, why };
}
