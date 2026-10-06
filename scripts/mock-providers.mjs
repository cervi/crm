#!/usr/bin/env node
// Microsoft 365 y Google Workspace simulados para las pruebas: inicio de
// sesión OAuth (con PKCE) y las llamadas que usa el CRM (perfil, horario,
// correos, calendario, envío y búsqueda de archivos). Guarda lo enviado y
// creado para comprobarlo.
//
//   MOCK_PORT=3998 node scripts/mock-providers.mjs
//
// Utilidades de prueba: GET /__state, POST /__expire (caducan los accesos),
// POST /__revoke (se revoca la sesión: hay que reconectar), POST /__reset.
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { pipedriveData, PD_TOKEN } from "./mock-pipedrive-data.mjs";

const PORT = Number(process.env.MOCK_PORT ?? 3998);
const ME = { mail: "jesus@aikit.example", userPrincipalName: "jesus@aikit.example", displayName: "Jesús (simulado)" };
const GME = { email: "jesus@empresa-google.example", name: "Jesús (Google simulado)" };

const H = 3600000, D = 24 * H;
const iso = (t) => new Date(t).toISOString().replace("Z", "0000"); // como Graph con Prefer UTC: sin «Z»
const at = (days, hourUtc) => { const d = new Date(Date.now() + days * D); d.setUTCHours(hourUtc, 0, 0, 0); return d.getTime(); };

const gHeaders = (h) => Object.entries(h).map(([name, value]) => ({ name, value }));
const gmsg = (id, daysAgo, headers, snippet, labelIds = ["INBOX"]) =>
  ({ id, labelIds, snippet, internalDate: String(Date.now() - daysAgo * D), payload: { headers: gHeaders(headers) } });
const gtime = (t) => new Date(t).toISOString();

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
    gsent: [], gevents: [], llm: [], webhooks: [], pd: pipedriveData(), pdCalls: 0,
    gmessages: [
      gmsg("g1", 10, { From: "Ana García <ana@paco.example>", To: GME.email, Subject: "Re: propuesta" }, "Lo vemos con dirección."),
      gmsg("g2", 11, { From: `Jesús <${GME.email}>`, To: "\"Ana García\" <ana@paco.example>", Subject: "Propuesta" }, "Te adjunto la propuesta.", ["SENT"]),
      gmsg("g3", 2, { From: "news@otro.example", To: GME.email, Subject: "Newsletter" }, "Nada que ver."),
      gmsg("g4", 1, { From: `Jesús <${GME.email}>`, To: "ana@paco.example", Subject: "Borrador" }, "Sin enviar.", ["DRAFT"]),
    ],
    gcalendar: [
      { id: "ge1", status: "confirmed", summary: "Revisión con Paco (Meet)", start: { dateTime: gtime(at(-1, 9)) }, end: { dateTime: gtime(at(-1, 10)) },
        hangoutLink: "https://meet.example/ge1",
        attendees: [{ email: "ana@paco.example" }, { email: GME.email, self: true, responseStatus: "accepted" }], organizer: { email: GME.email } },
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((d) => [
        { id: `gbusy${d}`, status: "confirmed", summary: "Ocupado", start: { dateTime: gtime(at(d, 7)) }, end: { dateTime: gtime(at(d, 11)) } },
        // Rechazada por mí: no ocupa.
        { id: `gdecl${d}`, status: "confirmed", summary: "Rechazada", start: { dateTime: gtime(at(d, 12)) }, end: { dateTime: gtime(at(d, 15)) },
          attendees: [{ email: GME.email, self: true, responseStatus: "declined" }] },
        // Marcada como «disponible»: no ocupa.
        { id: `gfree${d}`, status: "confirmed", summary: "Disponible", transparency: "transparent", start: { dateTime: gtime(at(d, 13)) }, end: { dateTime: gtime(at(d, 14)) } },
      ]),
      { id: "gcanc", status: "cancelled", summary: "Cancelada con Ana", start: { dateTime: gtime(at(2, 14)) }, end: { dateTime: gtime(at(2, 15)) },
        attendees: [{ email: "ana@paco.example" }] },
    ],
    gfiles: [
      { id: "gf1", name: "Propuesta Paco 2026", mimeType: "application/vnd.google-apps.presentation", webViewLink: "https://docs.example/presentation/d/gf1/edit",
        modifiedTime: new Date(Date.now() - 3 * D).toISOString(), owners: [{ displayName: "Jesús" }] },
      { id: "gf2", name: "Contrato marco Paco.pdf", mimeType: "application/pdf", webViewLink: "https://drive.example/file/d/gf2/view",
        modifiedTime: new Date(Date.now() - 9 * D).toISOString(), owners: [{ displayName: "Legal" }] },
      { id: "gf3", name: "Otra cosa", mimeType: "application/pdf", webViewLink: "https://drive.example/file/d/gf3/view" },
    ],
    msfiles: [
      { id: "mf1", name: "Presentación Paco.pptx", webUrl: "https://onedrive.example/mf1", file: { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
        lastModifiedDateTime: new Date(Date.now() - D).toISOString(), createdBy: { user: { displayName: "Jesús" } } },
      { id: "mf2", name: "Paco (carpeta)", webUrl: "https://onedrive.example/mf2", folder: { childCount: 3 } },
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
    if (p === "/__state") return send(res, 200, { sent: state.sent, events: state.events, gsent: state.gsent, gevents: state.gevents, llm: state.llm, webhooks: state.webhooks });
    // Webhook de las automatizaciones (Zapier, Make… simulado). /__webhook/fail responde con error.
    if (p.startsWith("/__webhook") && req.method === "POST") {
      state.webhooks.push(JSON.parse(await body(req)));
      return p.endsWith("/fail") ? send(res, 500, { error: "fallo simulado" }) : send(res, 200, { ok: true });
    }

    // --- Pipedrive (API v1 y v2)
    if (p === "/__pd_touch") {
      const d = state.pd.deals.find((x) => x.id === 401);
      d.title = "Acme — licencias (ampliado)"; d.value = 18000; d.update_time = new Date().toISOString();
      return send(res, 200, { ok: true });
    }
    if ((p.startsWith("/v1/") && p !== "/v1/userinfo") || p.startsWith("/api/v2/")) {
      if (url.searchParams.get("api_token") !== PD_TOKEN) return send(res, 401, { success: false, error: "unauthorized access" });
      state.pdCalls++;
      const D = state.pd;
      const since = url.searchParams.get("updated_since");
      const fresh = (list) => (since ? list.filter((x) => !x.update_time || x.update_time >= since) : list);
      // v2: páginas de 2 con cursor (para probar la paginación)
      const v2 = (list) => {
        const start = Number(url.searchParams.get("cursor") ?? 0);
        const data = list.slice(start, start + 2);
        return send(res, 200, { success: true, data, additional_data: { next_cursor: start + 2 < list.length ? String(start + 2) : null } });
      };
      // v1: páginas de 2 con start / next_start
      const v1 = (list) => {
        const start = Number(url.searchParams.get("start") ?? 0);
        const data = list.slice(start, start + 2);
        return send(res, 200, { success: true, data, additional_data: { pagination: { start, limit: 2, more_items_in_collection: start + 2 < list.length, next_start: start + 2 } } });
      };
      if (p === "/v1/users/me") return send(res, 200, { success: true, data: D.me });
      if (p === "/v1/users") return send(res, 200, { success: true, data: D.users });
      if (p === "/v1/activityTypes") return send(res, 200, { success: true, data: D.activityTypes });
      if (p === "/api/v2/pipelines") return v2(D.pipelines);
      if (p === "/api/v2/stages") return v2(D.stages);
      if (p === "/api/v2/dealFields") return v2(D.dealFields);
      if (p === "/api/v2/personFields") return v2(D.personFields);
      if (p === "/api/v2/organizationFields") return v2(D.organizationFields);
      if (p === "/api/v2/organizations") return v2(fresh(D.organizations));
      if (p === "/api/v2/persons") return v2(fresh(D.persons));
      if (p === "/api/v2/deals") return v2(fresh(D.deals));
      if (p === "/api/v2/activities") return v2(fresh(D.activities));
      if (p === "/v1/leads") return v1(D.leads);
      if (p === "/v1/notes") return v1(D.notes);
      if (p === "/v1/files") return v1(D.files);
      if (p === "/v1/deals/summary") {
        const st = url.searchParams.get("status");
        return send(res, 200, { success: true, data: { total_count: D.deals.filter((d) => d.status === st && !d.is_deleted).length } });
      }
      const fl = /^\/v1\/deals\/(\d+)\/flow$/.exec(p);
      if (fl) return v1(D.flow[fl[1]] ?? []);
      return send(res, 404, { success: false, error: `No existe ${p}` });
    }

    // --- Modelos de IA (Anthropic y compatible con OpenAI)
    if (p === "/llm/anthropic/v1/messages" || p === "/llm/openai/chat/completions") {
      const anthropic = p.startsWith("/llm/anthropic");
      const key = anthropic ? req.headers["x-api-key"] : (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (key !== "clave-llm-de-pruebas") return send(res, 401, { error: { message: "Clave de API no válida" } });
      const j = JSON.parse(await body(req));
      const user = anthropic ? j.messages[0].content : j.messages.find((m) => m.role === "user").content;
      const system = anthropic ? j.system : j.messages.find((m) => m.role === "system").content;
      const task = JSON.parse(user).tarea;
      state.llm.push({ task, model: j.model, system: system.slice(0, 80) });
      const replies = {
        test: "ok",
        deal_brief: "```json\n" + JSON.stringify({ resumen: "(IA) El deal avanza pero falta la videollamada.", siguiente_paso: "(IA) Llama a Ana para cerrar fecha", riesgos: ["(IA) Riesgo de prueba"] }) + "\n```",
        meeting_recap: "Aquí tienes:\n" + JSON.stringify({ resumen: "(IA) Repasamos la propuesta y los plazos.", proximos_pasos: ["(IA) Enviar la propuesta revisada", "(IA) Reunión con dirección"] }),
        daily_digest: "(IA) Hoy, primero responde a Ana y luego revisa la bandeja.",
        handoff: "(IA) Traspaso: cliente con buena relación; vigilar plazos.",
        report_question: JSON.stringify({ titulo: "(IA) Importe ganado por origen", source: "deals", metric: "sum_value", group_by: "source",
                                          date_field: "won_at", period: "all", chart: "bar", filters: { status: "won" } }),
      };
      if (task === "lead_chat") {
        // Chat de la web: pide el email hasta que aparece en la conversación.
        const conv = JSON.parse(user).datos?.conversacion ?? [];
        const said = conv.filter((m) => m.rol === "visitante").map((m) => m.texto).join(" ");
        const email = /[\w.+-]+@[\w-]+\.[\w.-]+/.exec(said)?.[0] ?? "";
        replies.lead_chat = JSON.stringify(email
          ? { respuesta: "(IA) ¡Gracias! Te escribimos hoy mismo.", datos: { nombre: "Visitante Chat", email, empresa: "Chat S.L.", telefono: "", necesidad: said.slice(0, 120) }, listo: true }
          : { respuesta: "(IA) ¡Hola! ¿Me dejas tu email para enviarte la información?", datos: { nombre: "", email: "", empresa: "", telefono: "", necesidad: said.slice(0, 120) }, listo: false });
      }
      const text = replies[task] ?? "(IA) respuesta";
      return anthropic
        ? send(res, 200, { content: [{ type: "text", text }], stop_reason: "end_turn" })
        : send(res, 200, { choices: [{ message: { role: "assistant", content: text } }] });
    }
    if (p === "/__expire") { state.access.clear(); return send(res, 200, { ok: true }); }
    if (p === "/__revoke") { state.access.clear(); state.refresh.clear(); return send(res, 200, { ok: true }); }
    if (p === "/__reset") { reset(); return send(res, 200, { ok: true }); }

    // --- Inicio de sesión
    if (/\/oauth2\/v2\.0\/authorize$/.test(p) || p === "/o/oauth2/v2/auth") {
      const q = url.searchParams;
      const code = token("code");
      state.codes.set(code, { challenge: q.get("code_challenge"), redirect: q.get("redirect_uri") });
      const back = new URL(q.get("redirect_uri"));
      back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state"));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (/\/oauth2\/v2\.0\/token$/.test(p) || p === "/token") {
      const f = new URLSearchParams(await body(req));
      const secret = p === "/token" ? process.env.GOOGLE_CLIENT_SECRET : process.env.MS_CLIENT_SECRET;
      if (f.get("client_secret") !== secret) return send(res, 401, { error: "invalid_client" });
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

    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const authorized = state.access.has(auth);

    // --- Google
    if (/^\/(gmail|calendar|drive)\/|^\/v1\/userinfo$/.test(p)) {
      if (!authorized) return send(res, 401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid Credentials" } });
      if (p === "/v1/userinfo") return send(res, 200, GME);
      if (p === "/calendar/v3/users/me/settings/timezone") return send(res, 200, { value: "Europe/Madrid" });
      if (p === "/gmail/v1/users/me/messages" && req.method === "GET") {
        const m = /after:(\d+)/.exec(url.searchParams.get("q") ?? "");
        const since = m ? Number(m[1]) * 1000 : 0;
        const drafts = /-in:drafts/.test(url.searchParams.get("q") ?? "");
        const list = state.gmessages.filter((x) => Number(x.internalDate) >= since && !(drafts && x.labelIds.includes("DRAFT")));
        // En dos páginas, para probar la paginación.
        const start = Number(url.searchParams.get("pageToken") ?? 0), size = 2;
        const page = list.slice(start, start + size).map((x) => ({ id: x.id }));
        return send(res, 200, { messages: page, ...(start + size < list.length ? { nextPageToken: String(start + size) } : {}) });
      }
      if (p === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
        const { raw } = JSON.parse(await body(req));
        const text = Buffer.from(raw, "base64url").toString("utf8");
        const [head, ...rest] = text.split("\r\n\r\n");
        const headers = Object.fromEntries(head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
        const decodeWord = (v) => v.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, b) => Buffer.from(b, "base64").toString("utf8"));
        const id = token("gm");
        // Texto plano o multipart/alternative (texto + HTML con seguimiento).
        const b64 = (t) => Buffer.from(t.replace(/\s+/g, ""), "base64").toString("utf8");
        let plain = "", html = null;
        const boundary = /boundary="([^"]+)"/.exec(headers["content-type"] ?? "")?.[1];
        if (boundary) {
          for (const part of rest.join("\r\n\r\n").split(`--${boundary}`)) {
            const [ph, ...pb] = part.split("\r\n\r\n");
            if (/text\/plain/.test(ph)) plain = b64(pb.join(""));
            if (/text\/html/.test(ph)) html = b64(pb.join(""));
          }
        } else plain = b64(rest.join("\r\n\r\n"));
        const sent = { id, to: decodeWord(headers.to ?? ""), subject: decodeWord(headers.subject ?? ""), body: plain, html };
        state.gsent.push(sent);
        state.gmessages.push(gmsg(id, 0, { From: GME.email, To: headers.to, Subject: headers.subject }, sent.body.slice(0, 100), ["SENT"]));
        return send(res, 200, { id, threadId: id, labelIds: ["SENT"] });
      }
      const gm = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(p);
      if (gm) {
        const m = state.gmessages.find((x) => x.id === decodeURIComponent(gm[1]));
        return m ? send(res, 200, m) : send(res, 404, { error: { code: 404, message: "Not Found" } });
      }
      if (p === "/calendar/v3/calendars/primary/events" && req.method === "GET") {
        const from = Date.parse(url.searchParams.get("timeMin")), to = Date.parse(url.searchParams.get("timeMax"));
        const items = [...state.gcalendar, ...state.gevents].filter((e) => Date.parse(e.start.dateTime) < to && Date.parse(e.end.dateTime) > from);
        return send(res, 200, { items });
      }
      if (p === "/calendar/v3/calendars/primary/events" && req.method === "POST") {
        const j = JSON.parse(await body(req));
        const id = token("gev");
        const ev = { id, status: "confirmed", ...j, organizer: { email: GME.email },
                     ...(j.conferenceData ? { hangoutLink: `https://meet.example/${id}` } : {}),
                     sendUpdates: url.searchParams.get("sendUpdates") };
        state.gevents.push(ev);
        return send(res, 200, ev);
      }
      if (p === "/drive/v3/files") {
        const m = /name contains '((?:[^'\\]|\\.)*)'/.exec(url.searchParams.get("q") ?? "");
        const term = (m?.[1] ?? "").replace(/\\(.)/g, "$1").toLowerCase();
        return send(res, 200, { files: state.gfiles.filter((f) => f.name.toLowerCase().includes(term)) });
      }
      return send(res, 404, { error: { code: 404, message: p } });
    }

    // --- Graph
    if (!p.startsWith("/v1.0/")) return send(res, 404, { error: { code: "NotFound", message: p } });
    if (!authorized) return send(res, 401, { error: { code: "InvalidAuthenticationToken", message: "Access token has expired." } });
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
      const sent = { ...d, isDraft: false, from: { emailAddress: { address: ME.mail } }, sentDateTime: now, receivedDateTime: now, bodyPreview: (d.body?.content ?? "").replace(/<[^>]+>/g, "").slice(0, 200) };
      state.sent.push(sent);
      state.messages.push(sent); // aparece en «Enviados»: la sincronización no debe duplicarlo
      return send(res, 202);
    }
    if (g === "/me/calendarView") {
      const from = Date.parse(url.searchParams.get("startDateTime")), to = Date.parse(url.searchParams.get("endDateTime"));
      const value = [...state.calendar, ...state.events].filter((e) => Date.parse(`${e.start.dateTime}Z`) < to && Date.parse(`${e.end.dateTime}Z`) > from);
      return send(res, 200, { value });
    }
    const search = /^\/me\/drive\/root\/search\(q='(.*)'\)$/.exec(decodeURIComponent(g));
    if (search) {
      const term = search[1].replace(/''/g, "'").toLowerCase();
      return send(res, 200, { value: state.msfiles.filter((f) => f.name.toLowerCase().includes(term)) });
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
