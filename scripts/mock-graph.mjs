#!/usr/bin/env node
// Microsoft simulado para las pruebas: inicio de sesión OAuth (con PKCE) y
// las llamadas de Microsoft Graph que usa el CRM (perfil, horario, correos,
// calendario y envío). Guarda lo enviado y creado para comprobarlo.
//
//   MOCK_GRAPH_PORT=3998 node scripts/mock-graph.mjs
//
// Utilidades de prueba: GET /__state, POST /__expire (caducan los accesos),
// POST /__revoke (se revoca la sesión: hay que reconectar), POST /__reset.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const PORT = Number(process.env.MOCK_GRAPH_PORT ?? 3998);
const ME = { mail: "jesus@aikit.example", userPrincipalName: "jesus@aikit.example", displayName: "Jesús (simulado)" };

const H = 3600000, D = 24 * H;
const iso = (t) => new Date(t).toISOString().replace("Z", "0000"); // como Graph con Prefer UTC: sin «Z»
const at = (days, hourUtc) => { const d = new Date(Date.now() + days * D); d.setUTCHours(hourUtc, 0, 0, 0); return d.getTime(); };

let state;
function reset() {
  state = {
    codes: new Map(), access: new Set(), refresh: new Set(), seq: 0,
    sent: [], events: [], drafts: new Map(),
    messages: [
      { id: "m1", internetMessageId: "<m1@mock>", subject: "Re: propuesta de ampliación", bodyPreview: "Gracias, lo vemos con dirección.",
        from: { emailAddress: { address: "ana@paco.example", name: "Ana García" } }, toRecipients: [{ emailAddress: { address: ME.mail } }],
        receivedDateTime: new Date(Date.now() - 10 * D).toISOString(), sentDateTime: new Date(Date.now() - 10 * D).toISOString() },
      { id: "m2", internetMessageId: "<m2@mock>", subject: "Propuesta de ampliación", bodyPreview: "Te adjunto la propuesta.",
        from: { emailAddress: { address: ME.mail } }, toRecipients: [{ emailAddress: { address: "ana@paco.example" } }],
        receivedDateTime: new Date(Date.now() - 11 * D).toISOString(), sentDateTime: new Date(Date.now() - 11 * D).toISOString() },
      { id: "m3", internetMessageId: "<m3@mock>", subject: "Newsletter", bodyPreview: "No es de ningún contacto.",
        from: { emailAddress: { address: "news@otro.example" } }, toRecipients: [{ emailAddress: { address: ME.mail } }],
        receivedDateTime: new Date(Date.now() - 2 * D).toISOString(), sentDateTime: new Date(Date.now() - 2 * D).toISOString() },
    ],
    calendar: [
      // Reunión de ayer con Ana: se registra para marcar si se celebró.
      { id: "e1", subject: "Revisión con Paco", isCancelled: false, isOnlineMeeting: true, showAs: "busy",
        start: { dateTime: iso(at(-1, 9)) }, end: { dateTime: iso(at(-1, 10)) }, onlineMeeting: { joinUrl: "https://teams.example/e1" },
        attendees: [{ emailAddress: { address: "ana@paco.example", name: "Ana García" } }], organizer: { emailAddress: { address: ME.mail } } },
      // Bloques ocupados sin contactos del CRM (no se registran, pero ocupan huecos).
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((d) => ({
        id: `busy${d}`, subject: "Ocupado", isCancelled: false, showAs: "busy",
        start: { dateTime: iso(at(d, 7)) }, end: { dateTime: iso(at(d, 11)) }, attendees: [],
        organizer: { emailAddress: { address: ME.mail } },
      })),
      { id: "free1", subject: "Recordatorio", isCancelled: false, showAs: "free",
        start: { dateTime: iso(at(2, 12)) }, end: { dateTime: iso(at(2, 16)) }, attendees: [] },
    ],
  };
}
reset();

const token = (prefix) => `${prefix}-${++state.seq}-${randomBytes(6).toString("hex")}`;
const issue = () => {
  const a = token("at"), r = token("rt");
  state.access.add(a); state.refresh.add(r);
  return { token_type: "Bearer", access_token: a, refresh_token: r, expires_in: 3600, scope: "Mail.Send" };
};

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(data === undefined ? "" : JSON.stringify(data));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  try {
    // --- Utilidades de prueba
    if (p === "/__state") return send(res, 200, { sent: state.sent, events: state.events, access: state.access.size });
    if (p === "/__expire") { state.access.clear(); return send(res, 200, { ok: true }); }
    if (p === "/__revoke") { state.access.clear(); state.refresh.clear(); return send(res, 200, { ok: true }); }
    if (p === "/__reset") { reset(); return send(res, 200, { ok: true }); }

    // --- Inicio de sesión
    if (/\/oauth2\/v2\.0\/authorize$/.test(p)) {
      const q = url.searchParams;
      const code = token("code");
      state.codes.set(code, { challenge: q.get("code_challenge"), redirect: q.get("redirect_uri") });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state"));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (/\/oauth2\/v2\.0\/token$/.test(p)) {
      const f = new URLSearchParams(await body(req));
      if (f.get("client_secret") !== process.env.MS_CLIENT_SECRET) return send(res, 401, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code") {
        const c = state.codes.get(f.get("code"));
        state.codes.delete(f.get("code"));
        const challenge = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
        if (!c || c.challenge !== challenge || c.redirect !== f.get("redirect_uri")) return send(res, 400, { error: "invalid_grant", error_description: "Código no válido" });
        return send(res, 200, issue());
      }
      if (f.get("grant_type") === "refresh_token") {
        if (!state.refresh.has(f.get("refresh_token"))) return send(res, 400, { error: "invalid_grant", error_description: "AADSTS700082: El token ha caducado." });
        state.refresh.delete(f.get("refresh_token"));
        return send(res, 200, issue());
      }
      return send(res, 400, { error: "unsupported_grant_type" });
    }

    // --- Graph
    if (!p.startsWith("/v1.0/")) return send(res, 404, { error: { code: "NotFound", message: p } });
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!state.access.has(auth)) return send(res, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } });
    const g = p.slice(5);

    if (g === "/me") return send(res, 200, ME);
    if (g === "/me/mailboxSettings") {
      return send(res, 200, { workingHours: { daysOfWeek: ["monday", "tuesday", "wednesday", "thursday", "friday"], startTime: "09:00:00.0000000", endTime: "17:00:00.0000000" } });
    }
    if (g === "/me/messages" && req.method === "GET") {
      const m = /receivedDateTime ge (\S+)/.exec(url.searchParams.get("$filter") ?? "");
      const since = m ? Date.parse(m[1]) : 0;
      const value = state.messages.filter((x) => Date.parse(x.receivedDateTime) >= since)
        .sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
      return send(res, 200, { value });
    }
    if (g === "/me/messages" && req.method === "POST") {
      const j = JSON.parse(await body(req));
      const id = token("msg");
      const draft = { id, internetMessageId: `<${id}@mock>`, ...j, isDraft: true };
      state.drafts.set(id, draft);
      return send(res, 201, draft);
    }
    const sendMatch = /^\/me\/messages\/([^/]+)\/send$/.exec(g);
    if (sendMatch && req.method === "POST") {
      const d = state.drafts.get(decodeURIComponent(sendMatch[1]));
      if (!d) return send(res, 404, { error: { code: "ErrorItemNotFound", message: "No existe" } });
      state.drafts.delete(d.id);
      const now = new Date().toISOString();
      const sent = { ...d, isDraft: false, from: { emailAddress: { address: ME.mail } }, sentDateTime: now, receivedDateTime: now, bodyPreview: d.body?.content?.slice(0, 200) };
      state.sent.push(sent);
      state.messages.push(sent); // aparece en «Enviados»: la sincronización no debe duplicarlo
      return send(res, 202);
    }
    if (g === "/me/calendarView") {
      const from = Date.parse(url.searchParams.get("startDateTime")), to = Date.parse(url.searchParams.get("endDateTime"));
      const value = [...state.calendar, ...state.events].filter((e) => Date.parse(`${e.start.dateTime}Z`) < to && Date.parse(`${e.end.dateTime}Z`) > from);
      return send(res, 200, { value });
    }
    if (g === "/me/events" && req.method === "POST") {
      const j = JSON.parse(await body(req));
      const id = token("evt");
      const ev = { id, isCancelled: false, showAs: "busy", ...j, organizer: { emailAddress: { address: ME.mail } },
                   onlineMeeting: j.isOnlineMeeting ? { joinUrl: `https://teams.example/${id}` } : null };
      state.events.push(ev);
      return send(res, 201, ev);
    }
    return send(res, 404, { error: { code: "NotFound", message: g } });
  } catch (err) {
    return send(res, 500, { error: { code: "MockError", message: String(err) } });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Microsoft simulado en http://127.0.0.1:${PORT}`));
