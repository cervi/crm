import { tokenRequest, type ApiClient } from "./http";
import type { CalendarEvent, MailMessage, Provider } from "./types";

// ===========================================================================
// Microsoft 365: Outlook (correo), calendario de Outlook y OneDrive/SharePoint.
//
// Configuración (app registrada en Microsoft Entra):
//   MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID (por defecto «organizations»)
// MS_LOGIN_URL y MS_GRAPH_URL solo se cambian en pruebas (servidor simulado).
// ===========================================================================

export const MICROSOFT_SCOPES = [
  "openid", "email", "profile", "offline_access",
  "User.Read", "Mail.Read", "Mail.Send", "Calendars.ReadWrite", "MailboxSettings.Read", "Files.Read.All",
];

const LOGIN = () => (process.env.MS_LOGIN_URL ?? "https://login.microsoftonline.com").replace(/\/$/, "");
const GRAPH = () => (process.env.MS_GRAPH_URL ?? "https://graph.microsoft.com/v1.0").replace(/\/$/, "");
const TENANT = () => process.env.MS_TENANT_ID || "organizations";
const TOKEN_URL = () => `${LOGIN()}/${TENANT()}/oauth2/v2.0/token`;
const NAME = "Microsoft";

const token = (body: Record<string, string>) => tokenRequest(NAME, TOKEN_URL(), {
  client_id: process.env.MS_CLIENT_ID ?? "", client_secret: process.env.MS_CLIENT_SECRET ?? "",
  scope: MICROSOFT_SCOPES.join(" "), ...body,
});

type Addr = { emailAddress: { address: string; name?: string } };
type GraphMessage = {
  id: string; internetMessageId?: string; subject: string | null; bodyPreview: string | null; isDraft?: boolean;
  from?: Addr; toRecipients?: Addr[]; ccRecipients?: Addr[]; sentDateTime?: string; receivedDateTime: string;
};
type GraphEvent = {
  id: string; subject: string | null; isCancelled: boolean; isOnlineMeeting?: boolean; showAs?: string;
  start: { dateTime: string }; end: { dateTime: string }; onlineMeeting?: { joinUrl?: string } | null;
  attendees?: Addr[]; organizer?: Addr;
};

/** Con «Prefer: outlook.timezone="UTC"», Graph devuelve horas UTC sin «Z». */
const utc = (s: string) => new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
const lower = (a?: Addr) => a?.emailAddress.address.toLowerCase() ?? "";

/** Todas las páginas (@odata.nextLink) hasta `max` elementos. */
async function all<T>(c: ApiClient, url: string, max: number, headers?: HeadersInit): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next && out.length < max) {
    const page: { value: T[]; "@odata.nextLink"?: string } = await c.call(next, { headers });
    out.push(...page.value);
    next = page["@odata.nextLink"];
  }
  return out.slice(0, max);
}

const DAYS: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 7 };

export const microsoft: Provider = {
  key: "microsoft",
  label: "Microsoft 365",
  mail: "Outlook",
  calendar: "calendario de Outlook",
  drive: "OneDrive / SharePoint",
  meeting: "Teams",
  configured: () => Boolean(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET),
  missingEnv: () => [!process.env.MS_CLIENT_ID && "MS_CLIENT_ID", !process.env.MS_CLIENT_SECRET && "MS_CLIENT_SECRET"].filter(Boolean) as string[],

  authorizeUrl({ state, challenge, redirectUri, loginHint }) {
    const q = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID ?? "", response_type: "code", redirect_uri: redirectUri, response_mode: "query",
      scope: MICROSOFT_SCOPES.join(" "), state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    });
    if (loginHint) q.set("login_hint", loginHint);
    return `${LOGIN()}/${TENANT()}/oauth2/v2.0/authorize?${q}`;
  },
  exchangeCode: (code, verifier, redirectUri) => token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }),
  refresh: (refreshToken) => token({ grant_type: "refresh_token", refresh_token: refreshToken }),

  async profile(c) {
    const me = await c.call<{ mail: string | null; userPrincipalName: string; displayName: string | null }>(
      `${GRAPH()}/me?$select=mail,userPrincipalName,displayName`);
    // Horario laboral de Outlook como punto de partida para ofrecer huecos.
    let scheduling = {};
    try {
      const ms = await c.call<{ workingHours?: { daysOfWeek?: string[]; startTime?: string; endTime?: string } }>(
        `${GRAPH()}/me/mailboxSettings?$select=workingHours`);
      const wh = ms.workingHours;
      if (wh) {
        scheduling = {
          days: (wh.daysOfWeek ?? []).map((d) => DAYS[d.toLowerCase()]).filter(Boolean),
          start: wh.startTime?.slice(0, 5), end: wh.endTime?.slice(0, 5),
        };
      }
    } catch { /* sin acceso a la configuración del buzón: valores por defecto */ }
    return { email: me.mail ?? me.userPrincipalName, displayName: me.displayName, scheduling };
  },

  async send(c, v) {
    // Se crea como borrador y se envía: así se conoce su Message-ID y la
    // sincronización de «Enviados» no lo duplica.
    const draft = await c.call<{ id: string; internetMessageId: string }>(`${GRAPH()}/me/messages`, {
      method: "POST",
      json: {
        subject: v.subject,
        body: v.html ? { contentType: "HTML", content: v.html } : { contentType: "Text", content: v.body },
        toRecipients: [{ emailAddress: { address: v.to.email, name: v.to.name ?? undefined } }],
      },
    });
    await c.call(`${GRAPH()}/me/messages/${encodeURIComponent(draft.id)}/send`, { method: "POST" });
    return { ref: `msg:${draft.internetMessageId}` };
  },

  async messages(c, since) {
    const q = new URLSearchParams({
      $select: "id,internetMessageId,subject,bodyPreview,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,isDraft",
      $filter: `receivedDateTime ge ${since.toISOString()}`,
      $orderby: "receivedDateTime desc",
      $top: "50",
    });
    const rows = await all<GraphMessage>(c, `${GRAPH()}/me/messages?${q}`, 1000);
    return rows.filter((m) => !m.isDraft && m.internetMessageId).map((m): MailMessage => ({
      ref: `msg:${m.internetMessageId}`,
      subject: m.subject,
      preview: m.bodyPreview,
      from: lower(m.from),
      to: [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map(lower).filter(Boolean),
      date: new Date(m.sentDateTime ?? m.receivedDateTime),
    }));
  },

  async events(c, from, to) {
    const q = new URLSearchParams({
      startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: "100",
      $select: "id,subject,start,end,isCancelled,isOnlineMeeting,onlineMeeting,attendees,organizer,showAs",
    });
    const rows = await all<GraphEvent>(c, `${GRAPH()}/me/calendarView?${q}`, 2000, { Prefer: 'outlook.timezone="UTC"' });
    return rows.map((e): CalendarEvent => ({
      ref: `evt:${e.id}`,
      subject: e.subject,
      start: utc(e.start.dateTime),
      end: utc(e.end.dateTime),
      cancelled: e.isCancelled,
      busy: !e.isCancelled && e.showAs !== "free" && e.showAs !== "workingElsewhere",
      online: Boolean(e.isOnlineMeeting),
      joinUrl: e.onlineMeeting?.joinUrl ?? null,
      emails: [...(e.attendees ?? []).map(lower), lower(e.organizer)].filter(Boolean),
    }));
  },

  async createEvent(c, v) {
    const iso = (d: Date) => d.toISOString().replace(/Z$/, "");
    const ev = await c.call<GraphEvent>(`${GRAPH()}/me/events`, {
      method: "POST",
      json: {
        subject: v.subject,
        body: v.body ? { contentType: "Text", content: v.body } : undefined,
        start: { dateTime: iso(v.start), timeZone: "UTC" },
        end: { dateTime: iso(v.end), timeZone: "UTC" },
        attendees: v.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name ?? undefined }, type: "required" })),
        ...(v.online ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
      },
    });
    return { ref: `evt:${ev.id}`, joinUrl: ev.onlineMeeting?.joinUrl ?? null };
  },

  async searchFiles(c, query) {
    const q = query.replace(/'/g, "''");
    const res = await c.call<{ value: { id: string; name: string; webUrl: string; file?: { mimeType?: string }; folder?: unknown;
                                        lastModifiedDateTime?: string; createdBy?: { user?: { displayName?: string } } }[] }>(
      `${GRAPH()}/me/drive/root/search(q='${encodeURIComponent(q)}')?$select=id,name,webUrl,file,folder,lastModifiedDateTime,createdBy&$top=25`);
    return res.value.filter((f) => !f.folder).map((f) => ({
      id: f.id, name: f.name, url: f.webUrl, mimeType: f.file?.mimeType ?? null,
      modifiedAt: f.lastModifiedDateTime ?? null, owner: f.createdBy?.user?.displayName ?? null,
    }));
  },
};
