import type { Scheduling } from "../slots";
import type { ApiClient, Tokens } from "./http";

/** Correo leído del buzón, igual para todos los proveedores. */
export type MailMessage = {
  ref: string;            // referencia única (evita duplicados al sincronizar)
  subject: string | null;
  preview: string | null;
  from: string;           // email en minúsculas
  to: string[];           // destinatarios (para y cc), en minúsculas
  date: Date;
};

/** Evento del calendario, igual para todos los proveedores. */
export type CalendarEvent = {
  ref: string;
  subject: string | null;
  start: Date;
  end: Date;
  cancelled: boolean;
  busy: boolean;          // ocupa tiempo (no «libre», no rechazado)
  online: boolean;
  joinUrl: string | null;
  emails: string[];       // asistentes y organizador, en minúsculas
};

/** Archivo del almacenamiento (Drive / OneDrive). */
export type DriveFile = {
  id: string;
  name: string;
  url: string;
  mimeType: string | null;
  modifiedAt: string | null;
  owner: string | null;
};

export type ProviderKey = "microsoft" | "google";

export type Provider = {
  key: ProviderKey;
  /** Nombre del proveedor y de sus productos, para la interfaz. */
  label: string;
  mail: string;
  calendar: string;
  drive: string;
  meeting: string;
  configured(): boolean;
  missingEnv(): string[];
  authorizeUrl(o: { state: string; challenge: string; redirectUri: string; loginHint?: string }): string;
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  profile(c: ApiClient): Promise<{ email: string; displayName: string | null; scheduling: Partial<Scheduling> }>;
  /** Envía un correo; con `html`, va también en HTML (con el texto como alternativa donde se pueda). */
  send(c: ApiClient, v: { from: string; to: { email: string; name?: string | null }; subject: string; body: string; html?: string }): Promise<{ ref: string }>;
  messages(c: ApiClient, since: Date, own: string): Promise<MailMessage[]>;
  events(c: ApiClient, from: Date, to: Date, own: string, timezone: string): Promise<CalendarEvent[]>;
  createEvent(c: ApiClient, v: {
    subject: string; start: Date; end: Date; attendees: { email: string; name?: string | null }[]; online: boolean; body?: string | null;
  }): Promise<{ ref: string; joinUrl: string | null }>;
  searchFiles(c: ApiClient, query: string): Promise<DriveFile[]>;
};
