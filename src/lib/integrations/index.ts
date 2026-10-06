import { google } from "./google";
import { microsoft } from "./microsoft";
import type { Provider, ProviderKey } from "./types";

export type { Provider, ProviderKey, DriveFile, MailMessage, CalendarEvent } from "./types";
export { ProviderError, providerMessage, pkce, type Tokens } from "./http";

/** Proveedores de correo, calendario y almacenamiento que se pueden conectar. */
export const PROVIDERS: Record<ProviderKey, Provider> = { microsoft, google };
export const PROVIDER_LIST: Provider[] = [microsoft, google];

export const isProviderKey = (v: unknown): v is ProviderKey => v === "microsoft" || v === "google";

/** Dirección de vuelta tras el inicio de sesión (debe coincidir con la registrada en el proveedor). */
export function redirectUri(provider: ProviderKey, origin: string) {
  return `${(process.env.APP_URL || origin).replace(/\/$/, "")}/api/integrations/${provider}/callback`;
}
