import { randomBytes, randomUUID } from "node:crypto";
import { isValidTimeZone, zonedToUtc } from "../slots";
import { parseAddresses, tokenRequest, type ApiClient } from "./http";
import type { CalendarEvent, MailMessage, Provider } from "./types";

// ===========================================================================
// Google Workspace: Gmail, Google Calendar y Google Drive.
//
// Configuración (Google Cloud → credenciales OAuth de tipo «Aplicación web»):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
// GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL y GOOGLE_API_BASE solo se cambian en
// pruebas (servidor simulado).
// ===========================================================================

export const GOOGLE_SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.settings.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

const AUTH_URL = () => process.env.GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const api = (real: string) => (process.env.GOOGLE_API_BASE ?? real).replace(/\/$/, "");
const GMAIL = () => `${api("https://gmail.googleapis.com")}/gmail/v1/users/me`;
const CAL = () => `${api("https://www.googleapis.com")}/calendar/v3`;
const DRIVE = () => `${api("https://www.googleapis.com")}/drive/v3`;
const USERINFO = () => `${api("https://openidconnect.googleapis.com")}/v1/userinfo`;
const NAME = "Google";

const token = (body: Record<string, string>) => tokenRequest(NAME, TOKEN_URL(), {
  client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "", ...body,
});

/** Cabecera con caracteres no ASCII (RFC 2047). */
const mimeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const wrap76 = (s: string) => s.replace(/.{1,76}/g, (l) => `${l}\r\n`);

/** Mensaje RFC 822 en texto plano, en base64url como lo pide la API de Gmail. */
export function rawEmail(v: { to: { email: string; name?: string | null }; subject: string; body: string; html?: string }) {
  const to = v.to.name ? `"${mimeWord(v.to.name.replace(/"/g, ""))}" <${v.to.email}>` : v.to.email;
  const b64 = (s: string) => wrap76(Buffer.from(s, "utf8").toString("base64"));
  const head = [`To: ${to}`, `Subject: ${mimeWord(v.subject)}`, "MIME-Version: 1.0"];
  if (!v.html) {
    head.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", b64(v.body));
    return Buffer.from(head.join("\r\n"), "utf8").toString("base64url");
  }
  // Texto y HTML (el HTML lleva el seguimiento de aperturas y clics).
  const boundary = `crm_${randomBytes(12).toString("hex")}`;
  const part = (type: string, content: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset="UTF-8"`, "Content-Transfer-Encoding: base64", "", b64(content)].join("\r\n");
  const msg = [...head, `Content-Type: multipart/alternative; boundary="${boundary}"`, "",
               part("text/plain", v.body), part("text/html", v.html), `--${boundary}--`, ""].join("\r\n");
  return Buffer.from(msg, "utf8").toString("base64url");
}

type GMessage = {
  id: string; labelIds?: string[]; snippet?: string; internalDate?: string;
  payload?: { headers?: { name: string; value: string }[] };
};
type GEvent = {
  id: string; status?: string; summary?: string; transparency?: string; hangoutLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[];
  organizer?: { email?: string };
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
};

export const google: Provider = {
  key: "google",
  label: "Google Workspace",
  mail: "Gmail",
  calendar: "Google Calendar",
  drive: "Google Drive",
  meeting: "Google Meet",
  configured: () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  missingEnv: () => [!process.env.GOOGLE_CLIENT_ID && "GOOGLE_CLIENT_ID", !process.env.GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET"].filter(Boolean) as string[],

  authorizeUrl({ state, challenge, redirectUri, loginHint }) {
    const q = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "", response_type: "code", redirect_uri: redirectUri,
      scope: GOOGLE_SCOPES.join(" "), state, code_challenge: challenge, code_challenge_method: "S256",
      // offline + consent: así Google entrega el token de renovación.
      access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true",
    });
    if (loginHint) q.set("login_hint", loginHint);
    return `${AUTH_URL()}?${q}`;
  },
  exchangeCode: (code, verifier, redirectUri) => token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }),
  refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),

  async profile(c) {
    const me = await c.call<{ email: string; name?: string }>(USERINFO());
    let scheduling = {};
    try {
      const tz = await c.call<{ value?: string }>(`${CAL()}/users/me/settings/timezone`);
      if (isValidTimeZone(tz.value)) scheduling = { timezone: tz.value };
    } catch { /* sin acceso a la configuración: valores por defecto */ }
    return { email: me.email, displayName: me.name ?? null, scheduling };
  },

  async send(c, v) {
    const res = await c.call<{ id: string }>(`${GMAIL()}/messages/send`, { method: "POST", json: { raw: rawEmail(v) } });
    return { ref: `gmail:${res.id}` };
  },

  async messages(c, since) {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ q: `after:${Math.floor(since.getTime() / 1000)} -in:drafts -in:chats`, maxResults: "100" });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await c.call<{ messages?: { id: string }[]; nextPageToken?: string }>(`${GMAIL()}/messages?${q}`);
      ids.push(...(page.messages ?? []).map((m) => m.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < 300);

    const out: MailMessage[] = [];
    for (const id of ids.slice(0, 300)) {
      const q = new URLSearchParams({ format: "metadata" });
      for (const h of ["From", "To", "Cc", "Subject"]) q.append("metadataHeaders", h);
      const m = await c.call<GMessage>(`${GMAIL()}/messages/${encodeURIComponent(id)}?${q}`);
      if (m.labelIds?.includes("DRAFT")) continue;
      const header = (n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;
      out.push({
        ref: `gmail:${m.id}`,
        subject: header("Subject"),
        preview: m.snippet ?? null,
        from: parseAddresses(header("From"))[0] ?? "",
        to: [...parseAddresses(header("To")), ...parseAddresses(header("Cc"))],
        date: new Date(Number(m.internalDate ?? Date.now())),
      });
    }
    return out;
  },

  async events(c, from, to, own, timezone) {
    const items: GEvent[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", showDeleted: "true", maxResults: "250",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await c.call<{ items?: GEvent[]; nextPageToken?: string }>(`${CAL()}/calendars/primary/events?${q}`);
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken && items.length < 2000);

    // Días completos («date»): de medianoche a medianoche en la zona del usuario.
    const when = (t?: { dateTime?: string; date?: string }) => {
      if (t?.dateTime) return new Date(t.dateTime);
      const [y, m, d] = (t?.date ?? "1970-01-01").split("-").map(Number);
      return zonedToUtc(y, m, d, 0, 0, timezone);
    };
    return items.map((e): CalendarEvent => {
      const cancelled = e.status === "cancelled";
      const declined = e.attendees?.some((a) => a.self && a.responseStatus === "declined") ?? false;
      const joinUrl = e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null;
      return {
        ref: `gcal:${e.id}`,
        subject: e.summary ?? null,
        start: when(e.start),
        end: when(e.end),
        cancelled,
        busy: !cancelled && !declined && e.transparency !== "transparent",
        online: Boolean(joinUrl),
        joinUrl,
        emails: [...(e.attendees ?? []).map((a) => a.email ?? ""), e.organizer?.email ?? ""].map((x) => x.toLowerCase()).filter(Boolean),
      };
    });
  },

  async createEvent(c, v) {
    const ev = await c.call<GEvent>(`${CAL()}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all`, {
      method: "POST",
      json: {
        summary: v.subject,
        description: v.body ?? undefined,
        start: { dateTime: v.start.toISOString() },
        end: { dateTime: v.end.toISOString() },
        attendees: v.attendees.map((a) => ({ email: a.email, displayName: a.name ?? undefined })),
        ...(v.online ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
      },
    });
    return { ref: `gcal:${ev.id}`, joinUrl: ev.hangoutLink ?? null };
  },

  async searchFiles(c, query) {
    const term = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = new URLSearchParams({
      q: `name contains '${term}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: "files(id,name,mimeType,webViewLink,modifiedTime,owners(displayName))",
      pageSize: "25", orderBy: "modifiedTime desc",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true", corpora: "allDrives",
    });
    const res = await c.call<{ files: { id: string; name: string; mimeType?: string; webViewLink: string; modifiedTime?: string;
                                        owners?: { displayName?: string }[] }[] }>(`${DRIVE()}/files?${q}`);
    return res.files.map((f) => ({
      id: f.id, name: f.name, url: f.webViewLink, mimeType: f.mimeType ?? null,
      modifiedAt: f.modifiedTime ?? null, owner: f.owners?.[0]?.displayName ?? null,
    }));
  },
};
