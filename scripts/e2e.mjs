#!/usr/bin/env node
// Pruebas de extremo a extremo contra la aplicación en marcha (con los datos
// de ejemplo cargados): todas las pantallas responden y la API de entrada
// deduplica correctamente.
//
//   BASE_URL=http://localhost:3000 DATABASE_URL=... INBOUND_API_KEYS=... node scripts/e2e.mjs
//
// Las pantallas se piden con la sesión del administrador de los datos de ejemplo.
import postgres from "postgres";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createSessionToken, hashPassword } from "./password.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const KEY = (process.env.INBOUND_API_KEYS ?? "").split(",")[0]?.trim();
const sql = postgres(process.env.DATABASE_URL ?? "postgres://crm:crm@localhost:5432/crm", { max: 1 });
const ADMIN_ID = "00000000-0000-0000-0000-000000000001", MEMBER_ID = "00000000-0000-0000-0000-000000000002";
const ADMIN_PASSWORD = "contraseña-de-pruebas-1";
await sql`UPDATE users SET password_hash = ${hashPassword(ADMIN_PASSWORD)}, must_change_password = false, failed_logins = 0, locked_until = NULL WHERE id = ${ADMIN_ID}`;
const SESSION = `crm_session=${await createSessionToken(sql, ADMIN_ID)}`;
const auth = { cookie: SESSION };

let passed = 0, failed = 0;
const ok = (name) => { passed++; console.log(`OK   · ${name}`); };
const fail = (name, detail) => { failed++; console.log(`FALLO · ${name}${detail ? ` — ${detail}` : ""}`); };
const check = (cond, name, detail) => (cond ? ok(name) : fail(name, detail));

// React separa trozos de texto con marcadores <!-- --> en el HTML: se quitan para comparar texto.
const get = async (path, opts = {}) => {
  // La cookie de sesión va siempre; si la petición trae otra (p. ej. la de OAuth), van las dos.
  const headers = { ...(opts.headers ?? {}) };
  headers.cookie = [auth.cookie, headers.cookie].filter(Boolean).join("; ");
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", ...opts, headers });
  const text = res.text.bind(res);
  res.text = async () => (await text()).replace(/<!-- -->/g, "");
  return res;
};
const api = (body, key = KEY, type = "application/json") => fetch(`${BASE}/api/v1/leads`, {
  method: "POST",
  headers: { "content-type": type, ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: type === "application/json" ? JSON.stringify(body) : new URLSearchParams(body),
});

// ------------------------------------------------------------- Pantallas
const P = { inbound: "10000000-0000-0000-0000-000000000001", ampl: "10000000-0000-0000-0000-000000000003" };
const ORG = "60000000-0000-0000-0000-000000000001", PERSON = "70000000-0000-0000-0000-000000000001";
const DEAL_OPEN = "90000000-0000-0000-0000-000000000002", DEAL_WON = "90000000-0000-0000-0000-000000000001";
const DEAL_LOST = "90000000-0000-0000-0000-000000000003", LEAD = "80000000-0000-0000-0000-000000000001";
const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Microsoft Outlook 16.0.17126";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

const pages = {
  "/pipelines": null, [`/pipelines/${P.inbound}`]: ["Demo solicitada"], [`/pipelines/${P.ampl}`]: ["Paco — ampliación de servicio", "Parado"],
  "/deals/new": ["Nuevo deal"], [`/deals/${DEAL_OPEN}`]: ["Necesidad detectada", "no se presentó", "Enfoque", "Historia"],
  [`/deals/${DEAL_WON}`]: ["Ganado el"], [`/deals/${DEAL_LOST}`]: ["Eligió a la competencia"], [`/deals/${DEAL_OPEN}/edit`]: ["Editar deal"],
  "/leads": null, "/leads?status=all": ["Webinar: automatizar la captación"], [`/leads/${LEAD}`]: ["Ana García"], "/leads/new": ["Nuevo lead"],
  "/organizations": ["Paco S.L."], "/organizations?q=paco": ["Paco S.L."], [`/organizations/${ORG}`]: ["Antiguos contactos", "Luis Martín"],
  [`/organizations/${ORG}/edit`]: ["Editar empresa"], "/organizations/new": ["Nueva empresa"],
  "/persons": ["Ana García"], [`/persons/${PERSON}`]: ["Recorrido como lead", "Paco S.L."], [`/persons/${PERSON}/edit`]: ["ana@paco.example"],
  "/persons/new": ["Nuevo contacto"], "/activities": null, "/activities?view=done": ["No se presentó"],
  "/settings": ["Pipelines y fases"], "/settings/pipelines": ["Inbound"], [`/settings/pipelines/${P.inbound}`]: ["Demo solicitada"],
  "/settings/fields": ["Competidor principal"], "/settings/fields?entity=organization": ["Segmento"],
  "/settings/lost-reasons": ["Sin presupuesto ahora"], "/settings/api": ["/api/v1/leads"],
};

for (const [path, texts] of Object.entries(pages)) {
  const res = await get(path);
  if (res.status >= 300 && res.status < 400) { check(path === "/pipelines" || path === "/leads", `${path} redirige`, res.status); continue; }
  const html = await res.text();
  const missing = (texts ?? []).filter((t) => !html.includes(t));
  check(res.status === 200 && missing.length === 0 && !html.includes("Application error"),
        `pantalla ${path}`, res.status !== 200 ? `HTTP ${res.status}` : `falta: ${missing.join(", ")}`);
}
for (const path of ["/deals/no-existe", `/deals/00000000-0000-0000-0000-00000000dead`, "/organizations/x", "/persons/x/edit"]) {
  const res = await get(path);
  check(res.status === 404, `404 en ${path}`, `HTTP ${res.status}`);
}
// ------------------------------------------------------------- Buscador, vistas y panel
{
  const hits = await (await get("/api/search?q=paco")).json();
  const types = new Set(hits.map((h) => h.type));
  check(types.has("deal") && types.has("organization"), "buscador: «paco» encuentra deals y empresa", [...types].join(","));
  const byEmail = await (await get("/api/search?q=ana@paco")).json();
  check(byEmail.some((h) => h.type === "person" && h.title === "Ana García"), "buscador: por email encuentra el contacto");
  check((await (await get("/api/search?q=a")).json()).length === 0, "buscador: una sola letra no busca");
  check((await (await get("/api/search?q=%25%25%25")).json()).length === 0, "buscador: los comodines se tratan como texto");
  const sres = await (await get("/search?q=paco")).text();
  check(sres.includes("Paco S.L.") && sres.includes("Deals"), "página de resultados de búsqueda");
  const list = await (await get(`/pipelines/${P.inbound}?view=list&status=all&sort=value&dir=desc`)).text();
  check(list.includes("Paco — contrato anual") && list.includes("Paco — otra plataforma") && list.includes("Importe ↓"),
        "vista de lista con cerrados y orden por importe");
  const sorted = await (await get(`/pipelines/${P.inbound}?sort=value`)).text();
  check(sorted.includes("Ordenar: importe"), "tablero ordenado por importe");
  const panel = await (await get(`/pipelines/${P.ampl}?deal=${DEAL_OPEN}`)).text();
  check(panel.includes("deal-panel") && panel.includes("Enfoque") && panel.includes("Cerrar (Esc)"), "panel lateral del deal en el tablero");
  const bogus = await get(`/pipelines/${P.ampl}?deal=00000000-0000-0000-0000-00000000dead`);
  check(bogus.status === 200 && (await bogus.text()).includes("ya no existe"), "panel con un deal inexistente no rompe el tablero");
}

// ------------------------------------------------------------- Dashboards
{
  const r = await get("/dashboards");
  const loc = r.headers.get("location") ?? "";
  check([307, 308].includes(r.status) && /\/dashboards\/[0-9a-f-]{36}$/.test(loc), "/dashboards abre el primer dashboard", `${r.status} ${loc}`);
  const dashHtml = await (await get(new URL(loc, BASE).pathname)).text();
  const expected = ["Ingresos ganados", "Tasa de cierre", "Valor abierto por fase", "Motivos de pérdida", "Añadir widget"];
  const missing = expected.filter((t) => !dashHtml.includes(t));
  check(missing.length === 0 && !dashHtml.includes("No se ha podido calcular"), "el dashboard de ventas calcula sus widgets", missing.join(", "));
  const newW = await get(`${new URL(loc, BASE).pathname}/widgets/new`);
  check(newW.status === 200 && (await newW.text()).includes("Qué medir"), "editor de widgets");

  const preview = (config) => fetch(`${BASE}/api/analytics/preview`, {
    method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ config }),
  });
  const base = { source: "deals", metric: "sum_value", group_by: "stage", date_field: "created_at", period: "all", chart: "bar", filters: { status: "open" } };
  const p1 = await preview(base);
  const j1 = await p1.json();
  check(p1.ok && j1.result?.kind === "series" && j1.result.points.some((pt) => pt.label.startsWith("Necesidad detectada")),
        "vista previa: valor abierto por fase", JSON.stringify(j1).slice(0, 200));
  const p2 = await (await preview({ ...base, group_by: "month", chart: "bar", date_field: "won_at", filters: { status: "won" }, period: "12m" })).json();
  check(p2.result?.kind === "series" && p2.result.time && p2.result.points.length >= 12, "vista previa: serie mensual de 12 meses sin huecos", String(p2.result?.points?.length));
  const p3 = await (await preview({ ...base, group_by: "none", chart: "bar", metric: "win_rate" })).json();
  check(p3.config?.chart === "number" && p3.result?.kind === "single" && p3.result.value >= 0 && p3.result.value <= 1,
        "sin agrupar se convierte en cifra (tasa entre 0 y 1)", JSON.stringify(p3).slice(0, 200));
  const p4 = await (await preview({ source: "leads", metric: "conversion_rate", group_by: "source", date_field: "created_at", period: "12m", chart: "bar", filters: {} })).json();
  check(p4.result?.kind === "series" && p4.result.points.length > 0, "vista previa: conversión de leads por origen");
  check((await preview({ ...base, metric: "drop_table" })).status === 422, "métrica desconocida → 422");
  check((await preview({ ...base, group_by: "stage; DROP TABLE deals" })).status === 422, "agrupación inyectada → 422");
  check((await preview({ ...base, filters: { owner_id: "1 OR 1=1" } })).status === 422, "filtro inyectado → 422");
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM deals`;
  check(n > 0, "la tabla de deals sigue intacta");
}

const root = await get("/");
const rootHtml = await root.text();
check(root.status === 200 && rootHtml.includes("Enfoque del día") && rootHtml.includes("Deals que piden atención"),
      "la portada es «Hoy» con el parte del día", `HTTP ${root.status}`);

const lookup = await (await get("/api/lookup?type=organizations&q=pac")).json();
check(Array.isArray(lookup) && lookup.some((o) => o.label === "Paco S.L."), "búsqueda de empresas");
const lookupP = await (await get("/api/lookup?type=persons&q=ana@")).json();
check(Array.isArray(lookupP) && lookupP.some((p) => p.label === "Ana García"), "búsqueda de contactos por email");

{
  const noAuth = await fetch(`${BASE}/organizations?q=x`, { redirect: "manual" });
  check(noAuth.status === 307 && (noAuth.headers.get("location") ?? "").includes("/login?next=%2Forganizations%3Fq%3Dx"),
        "sin sesión se va a la pantalla de entrada (y luego se vuelve)", `HTTP ${noAuth.status} ${noAuth.headers.get("location")}`);
  const fake = await fetch(`${BASE}/organizations`, { redirect: "manual", headers: { cookie: `crm_session=${"x".repeat(43)}` } });
  check(fake.status === 307, "una sesión inventada no sirve", `HTTP ${fake.status}`);
  check((await fetch(`${BASE}/api/search?q=paco`)).status === 401, "las rutas internas de API sin sesión → 401");
  const login = await fetch(`${BASE}/login`, { redirect: "manual" });
  const loginHtml = await login.text();
  check(login.status === 200 && loginHtml.includes("Entrar") && !loginHtml.includes('aria-label="Principal"'), "pantalla de entrada (sin menú)", `HTTP ${login.status}`);
  check((await fetch(`${BASE}/setup`, { redirect: "manual" })).status === 307, "con usuarios ya creados, la puesta en marcha no está disponible");
}

// ------------------------------------------------------------- API de entrada
if (!KEY) {
  fail("API de entrada", "define INBOUND_API_KEYS para probarla");
} else {
  check((await api({ email: "x@y.com", source: "t" }, null)).status === 401, "API sin clave → 401");
  check((await api({ email: "x@y.com", source: "t" }, "clave-incorrecta-123456")).status === 401, "API con clave errónea → 401");
  check((await api({ email: "no-es-email", source: "t" })).status === 422, "API con email no válido → 422");
  check((await api({ email: "x@y.com" })).status === 422, "API sin origen → 422");

  const stamp = Date.now();
  const email = `marta.${stamp}@nuevaempresa${stamp}.com`;
  const r1 = await api({ email, full_name: "Marta Ruiz", company: `Nueva Empresa ${stamp}`, source: "ebook",
                         source_detail: "Guía de ventas", funnel_stage: "tofu", tags: "ebook, guía", consent: "true" }, KEY,
                       "application/x-www-form-urlencoded");
  const j1 = await r1.json();
  check(r1.status === 201 && j1.created.person && j1.created.organization && j1.created.lead,
        "lead nuevo crea contacto, empresa y lead (formulario)", JSON.stringify(j1));

  const r2 = await api({ email: email.toUpperCase(), source: "webinar", source_detail: "Webinar X", funnel_stage: "mofu" });
  const j2 = await r2.json();
  check(r2.status === 200 && j2.person_id === j1.person_id && j2.lead_id === j1.lead_id && !j2.created.person,
        "mismo email (otras mayúsculas) reutiliza contacto y lead", JSON.stringify(j2));
  const [lead] = await sql`SELECT funnel_stage, status FROM leads WHERE id = ${j1.lead_id}`;
  check(lead?.funnel_stage === "mofu", "la etapa del lead sube a MOFU", lead?.funnel_stage);
  await api({ email, source: "blog", funnel_stage: "tofu" });
  const [lead2] = await sql`SELECT funnel_stage FROM leads WHERE id = ${j1.lead_id}`;
  check(lead2?.funnel_stage === "mofu", "la etapa nunca baja", lead2?.funnel_stage);

  const r3 = await api({ email, source: "formulario-demo", intent: "demo_request", message: "Queremos una demo", value: 5000 });
  const j3 = await r3.json();
  const [deal] = j3.deal_id ? await sql`SELECT d.status, d.value::int, p.name AS pipeline, d.lead_id FROM deals d JOIN pipelines p ON p.id = d.pipeline_id WHERE d.id = ${j3.deal_id}` : [];
  check(r3.status === 201 && j3.created.deal && deal?.pipeline === "Inbound" && deal?.value === 5000 && deal?.lead_id === j1.lead_id,
        "solicitud de demo crea el deal en Inbound vinculado al lead", JSON.stringify({ j3, deal }));
  const [conv] = await sql`SELECT status, converted_deal_id FROM leads WHERE id = ${j1.lead_id}`;
  check(conv?.status === "converted" && conv?.converted_deal_id === j3.deal_id, "el lead queda convertido");
  const [task] = await sql`SELECT count(*)::int AS n FROM activities WHERE deal_id = ${j3.deal_id} AND type = 'task' AND NOT done`;
  check(task?.n === 1, "se crea una tarea para contactar", task?.n);

  const r4 = await api({ email, source: "formulario-demo", source_detail: "Segunda petición", intent: "demo_request" });
  const j4 = await r4.json();
  const [{ n: deals }] = await sql`SELECT count(*)::int AS n FROM deal_participants WHERE person_id = ${j1.person_id}`;
  const [l4] = await sql`SELECT status, converted_deal_id FROM leads WHERE id = ${j4.lead_id}`;
  check(j4.deal_id === j3.deal_id && deals === 1, "segunda solicitud de demo no duplica el deal", JSON.stringify(j4));
  check(l4?.status === "converted" && l4?.converted_deal_id === j3.deal_id, "y su lead queda vinculado a ese deal", JSON.stringify(l4));

  // Envíos simultáneos del mismo contacto nuevo: no deben fallar ni duplicar.
  const email2 = `doble.${stamp}@otraempresa${stamp}.com`;
  const parallel = await Promise.all(Array.from({ length: 5 }, () => api({ email: email2, source: "webinar" })));
  const [{ n: people }] = await sql`SELECT count(*)::int AS n FROM person_emails WHERE email = ${email2}`;
  const [{ n: orgs }] = await sql`SELECT count(*)::int AS n FROM organizations WHERE domain = ${`otraempresa${stamp}.com`}`;
  check(parallel.every((r) => r.ok) && people === 1 && orgs === 1, "5 envíos simultáneos: sin errores ni duplicados",
        `${parallel.map((r) => r.status).join(",")} personas=${people} empresas=${orgs}`);

  // Correo personal: no crea empresa a partir de gmail.com.
  const j5 = await (await api({ email: `alguien.${stamp}@gmail.com`, source: "blog" })).json();
  check(j5.organization_id === null, "un email de Gmail no crea la empresa «gmail.com»", JSON.stringify(j5));

  // Empresa existente sin dominio: se reutiliza por nombre y se le asigna dominio.
  await sql`INSERT INTO organizations (name) VALUES (${`Sin Dominio ${stamp}`})`;
  const j6 = await (await api({ email: `x@sindominio${stamp}.com`, company: `Sin Dominio ${stamp}`, source: "blog" })).json();
  const [o6] = await sql`SELECT domain FROM organizations WHERE id = ${j6.organization_id}`;
  const [{ n: o6n }] = await sql`SELECT count(*)::int AS n FROM organizations WHERE name = ${`Sin Dominio ${stamp}`}`;
  check(o6n === 1 && o6?.domain === `sindominio${stamp}.com`, "empresa sin dominio se reutiliza y recibe el dominio", JSON.stringify({ o6, o6n }));

  // Las pantallas muestran lo que ha entrado por la API.
  const html = await (await get(`/leads?status=all&q=${encodeURIComponent(email)}`)).text();
  check(html.includes("Marta Ruiz"), "el lead aparece en el listado");
  const dealHtml = await (await get(`/deals/${j3.deal_id}`)).text();
  check(dealHtml.includes("Contactar: nueva solicitud de demo") && dealHtml.includes("Marta Ruiz"), "la ficha del deal muestra la tarea y el contacto");
}

// ------------------------------------------------------------- Automatizaciones
{
  const SECRET = process.env.CRON_SECRET ?? "";
  const AI = "00000000-0000-0000-0000-0000000000a1";
  const run = async (secret = SECRET) => {
    const res = await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: secret ? { authorization: `Bearer ${secret}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const actions = (key, extra = sql``) => sql`
    SELECT x.* FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id WHERE r.key = ${key} ${extra}`;

  check((await run("")).status === 401, "revisión sin clave → 401");
  check((await run("clave-equivocada-0123456789")).status === 401, "revisión con clave incorrecta → 401");

  const r1 = await run();
  check(r1.status === 200 && r1.body?.status === "ok", "la revisión de automatizaciones responde", JSON.stringify(r1));
  const tasks = await actions("missing_stage_session", sql`AND x.status = 'done' AND x.mode = 'auto'`);
  const [{ n: aiTasks }] = await sql`SELECT count(*)::int AS n FROM activities WHERE created_by_id = ${AI} AND NOT done`;
  check(tasks.length > 0 && aiTasks >= tasks.length, "fase sin sesión: la IA crea la tarea sola (autonomía «Sola»)", `${tasks.length} / ${aiTasks}`);
  const emails = await actions("stale_deal_followup", sql`AND x.status = 'pending'`);
  const paco = emails.find((e) => e.deal_id === DEAL_OPEN);
  check(paco && paco.mode === "ask" && paco.payload.to === "ana@paco.example" && paco.payload.body.includes("Hola Ana"),
        "deal parado: correo de seguimiento a la bandeja, con la plantilla rellenada", JSON.stringify(paco?.payload));
  const asks = await actions("stale_deal_escalate", sql`AND x.status = 'pending'`);
  check(asks.length > 0 && asks.every((a) => a.action_type === "notify"), "deal muy parado: pide una decisión", String(asks.length));

  const r2 = await run();
  check(r2.body?.proposed === 0 && r2.body?.executed === 0, "una segunda revisión no repite nada", JSON.stringify(r2.body));

  // «No se presentó» en el deal de Paco → correo para reagendar.
  const [act] = await sql`
    INSERT INTO activities (type, subject, due_at, done, outcome, deal_id, person_id)
    VALUES ('demo', 'Demo de prueba', now() - interval '1 hour', true, 'no_show', ${DEAL_OPEN}, ${PERSON}) RETURNING id`;
  await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type, payload)
            VALUES ('deal', ${DEAL_OPEN}, 'activity.completed', 'user', ${sql.json({ activity_id: act.id, outcome: "no_show" })})`;
  await run();
  const [rebook] = await actions("no_show_rebook", sql`AND x.deal_id = ${DEAL_OPEN}`);
  check(rebook?.status === "pending" && rebook.payload.to === "ana@paco.example" && rebook.payload.body.includes("demo"),
        "ausencia: propone reagendar por correo", JSON.stringify(rebook?.payload));
  // Si se agenda otra sesión, la propuesta caduca.
  const [again] = await sql`INSERT INTO activities (type, subject, due_at, deal_id) VALUES ('demo', 'Demo reagendada', now() + interval '2 days', ${DEAL_OPEN}) RETURNING id`;
  await run();
  const [rebook2] = await sql`SELECT status FROM automation_actions WHERE id = ${rebook.id}`;
  check(rebook2.status === "expired", "al agendar otra sesión, la propuesta de reagendar caduca", rebook2.status);
  // (Se borra para que el deal vuelva a estar parado y sin nada agendado.)
  await sql`DELETE FROM activities WHERE id = ${again.id}`;

  // Deal ganado → tarea de traspaso a Customer Success con el resumen (sola).
  const [won] = await sql`SELECT id, title FROM open_deals_status WHERE id <> ${DEAL_OPEN} ORDER BY id LIMIT 1`;
  await sql`UPDATE deals SET status = 'won' WHERE id = ${won.id}`;
  await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type) VALUES ('deal', ${won.id}, 'deal.won', 'user')`;
  await run();
  const [handoff] = await actions("won_handoff", sql`AND x.deal_id = ${won.id}`);
  const [task] = handoff?.result ? await sql`SELECT subject, note, created_by_id FROM activities WHERE id = ${handoff.result.activity_id}` : [];
  check(handoff?.status === "done" && task?.note?.includes("Cliente:") && task.created_by_id === AI,
        "deal ganado: tarea de traspaso con el resumen, creada por la IA", JSON.stringify({ st: handoff?.status, task }));

  // El permiso es el techo: con «Crear tareas» en «Preguntar», el traspaso espera decisión.
  await sql`UPDATE ai_permissions SET autonomy = 'ask' WHERE actor = 'assistant' AND action_type = 'create_task'`;
  const [won2] = await sql`SELECT id FROM open_deals_status WHERE id NOT IN (${DEAL_OPEN}, ${won.id}) ORDER BY id LIMIT 1`;
  await sql`UPDATE deals SET status = 'won' WHERE id = ${won2.id}`;
  await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type) VALUES ('deal', ${won2.id}, 'deal.won', 'user')`;
  await run();
  const [handoff2] = await actions("won_handoff", sql`AND x.deal_id = ${won2.id}`);
  check(handoff2?.status === "pending" && handoff2.mode === "ask", "con el permiso en «Preguntar», la regla automática pregunta", handoff2?.status);
  await sql`UPDATE ai_permissions SET autonomy = 'auto' WHERE actor = 'assistant' AND action_type = 'create_task'`;

  // Desactivar una regla retira sus propuestas pendientes.
  await sql`UPDATE automation_rules SET autonomy = 'off' WHERE key = 'stale_deal_escalate'`;
  await run();
  const left = await actions("stale_deal_escalate", sql`AND x.status = 'pending'`);
  check(left.length === 0, "al desactivar una regla, sus propuestas pendientes caducan", String(left.length));
  await sql`UPDATE automation_rules SET autonomy = 'ask' WHERE key = 'stale_deal_escalate'`;

  // Pausa general.
  await sql`UPDATE automation_settings SET paused = true`;
  const rp = await run();
  check(rp.body?.status === "paused", "con la IA en pausa no se revisa nada", JSON.stringify(rp.body));
  await sql`UPDATE automation_settings SET paused = false`;
  await run();

  // Pantallas.
  const inbox = await (await get("/inbox")).text();
  check(inbox.includes("Bandeja de la IA") && inbox.includes("retomar «Paco — ampliación de servicio»") && inbox.includes("Marcar como enviado"),
        "/inbox muestra las propuestas pendientes");
  const log = await (await get("/inbox?view=log")).text();
  check(log.includes("Hecha sola") && log.includes("Caducada") && log.includes("Deshacer"), "/inbox?view=log muestra el registro con «Deshacer»");
  const conf = await (await get("/settings/automations")).text();
  check(conf.includes("Qué puede hacer la IA") && conf.includes("Fase sin su sesión agendada") && conf.includes("Agentes externos"),
        "/settings/automations muestra permisos y reglas");
  const dealHtml = await (await get(`/deals/${DEAL_OPEN}`)).text();
  check(dealHtml.includes("Propuestas de la IA") && dealHtml.includes("Hola Ana"), "la ficha del deal muestra sus propuestas pendientes");
  const nav = await (await get("/activities")).text();
  check(/Bandeja de la IA \(\d+ pendientes?\)/.test(nav), "el menú lateral avisa de las propuestas pendientes");
}

// ------------------------------------------------------------- Correo, calendario y documentos (Microsoft 365 simulado)
if (process.env.MOCK_URL) {
  const MOCK = process.env.MOCK_URL;
  const SECRET = process.env.CRON_SECRET ?? "";
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  const mock = async (path, method = "GET") => (await fetch(`${MOCK}${path}`, { method })).json();
  const [{ owner_id: OWNER }] = await sql`SELECT owner_id FROM deals WHERE id = ${DEAL_OPEN}`;

  const page0 = await (await get("/settings/mailbox")).text();
  check(page0.includes("Conectar Microsoft 365") && page0.includes("Conectar Google Workspace") && page0.includes("Correo, calendario y documentos"),
        "/settings/mailbox ofrece conectar Microsoft 365 y Google Workspace");

  // Conexión OAuth completa: CRM → Microsoft → vuelta al CRM.
  const connect = async (tamper = false) => {
    const r1 = await get(`/api/integrations/microsoft/connect?user=${OWNER}`);
    const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
    const r2 = await fetch(r1.headers.get("location"), { redirect: "manual" });
    let back = r2.headers.get("location");
    if (tamper) back = back.replace(/state=[^&]+/, "state=otro");
    const r3 = await get(back.replace(/^https?:\/\/[^/]+/, ""), { headers: { cookie } });
    return { r1, r3, location: r3.headers.get("location") ?? "" };
  };
  const bad = await connect(true);
  check(bad.location.includes("error="), "conexión con «state» manipulado: se rechaza", bad.location);
  const c = await connect();
  check(c.r1.status === 307 && c.r1.headers.get("location").includes("code_challenge="), "conectar: redirige a Microsoft con PKCE");
  check(c.location.includes("/settings/mailbox?connected="), "conectar: vuelve al CRM conectado", c.location);
  const [conn] = await sql`SELECT email, tokens, scheduling, status FROM mailbox_connections WHERE user_id = ${OWNER}`;
  check(conn?.email === "jesus@aikit.example" && conn.status === "active" && !conn.tokens.includes("rt-") && conn.tokens.startsWith("v1."),
        "la conexión se guarda con los tokens cifrados", JSON.stringify(conn && { ...conn, tokens: conn.tokens.slice(0, 12) }));
  check(conn?.scheduling?.end === "17:00" && conn.scheduling.days.join() === "1,2,3,4,5", "toma el horario laboral de Outlook", JSON.stringify(conn?.scheduling));

  // Huecos libres: dentro del horario, sin solaparse con lo ocupado y con antelación.
  const slotsRes = await get(`/api/calendar/slots?deal=${DEAL_OPEN}`);
  const slots = await slotsRes.json();
  const madrid = (d) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).format(new Date(d));
  const okSlots = slotsRes.ok && slots.slots.length === 3 && slots.slots.every((x) => {
    const [wd, hm] = madrid(x.start).split(" ");
    return !["Sat", "Sun"].includes(wd.replace(",", "")) && hm >= "13:30" && madrid(x.end).split(" ")[1] <= "17:00"
      && Date.parse(x.start) >= Date.now() + 23.9 * 3600000;
  });
  check(okSlots, "huecos libres: en horario, tras lo ocupado y con 24 h de antelación", JSON.stringify(slots.slots?.map((x) => madrid(x.start))));
  check(slots.text?.includes("(hora de Madrid)"), "los huecos se formatean para el correo", slots.text);

  // Sincronización: correos y reuniones con contactos del CRM, sin duplicar.
  const r1 = await run();
  check(r1.sync?.emails === 2 && r1.sync?.meetings === 1, "sincroniza 2 correos y 1 reunión con contactos (ignora el resto)", JSON.stringify(r1.sync));
  const synced = await sql`SELECT type, subject, done, external_ref FROM activities WHERE deal_id = ${DEAL_OPEN} AND external_ref IS NOT NULL ORDER BY external_ref`;
  check(synced.some((a) => a.external_ref === "msg:<m1@mock>" && a.type === "email" && a.done)
        && synced.some((a) => a.external_ref === "evt:e1" && !a.done), "los correos y la reunión quedan en el deal", JSON.stringify(synced));
  const r2 = await run();
  check(r2.sync?.emails === 0 && r2.sync?.meetings === 0, "una segunda sincronización no duplica", JSON.stringify(r2.sync));

  // Con calendario conectado, la IA ofrece huecos para la sesión de la fase.
  const [offer] = await sql`SELECT x.* FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
                            WHERE r.key = 'offer_session_slots' AND x.deal_id = ${DEAL_OPEN} AND x.status = 'pending'`;
  check(offer && offer.payload.body.includes("(hora de Madrid)") && !offer.payload.body.includes("{huecos}") && offer.payload.to === "ana@paco.example",
        "fase sin sesión: propone un correo con tus huecos libres", JSON.stringify(offer?.payload));

  // Envío automático desde Outlook (con permiso y regla en «Sola»).
  await sql`UPDATE ai_permissions SET autonomy = 'auto' WHERE actor = 'assistant' AND action_type = 'draft_email'`;
  await sql`UPDATE automation_rules SET autonomy = 'auto' WHERE key = 'offer_session_slots'`;
  await sql`DELETE FROM automation_actions WHERE id = ${offer.id}`;
  const before = (await mock("/__state")).sent.length;
  await run();
  const st = await mock("/__state");
  const mail = st.sent.at(-1);
  const [sentRow] = await sql`SELECT x.status, x.result FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
                              WHERE r.key = 'offer_session_slots' AND x.deal_id = ${DEAL_OPEN} ORDER BY x.created_at DESC LIMIT 1`;
  check(st.sent.length === before + 1 && mail.toRecipients[0].emailAddress.address === "ana@paco.example" && sentRow?.status === "done" && sentRow.result.sent,
        "en «Sola», el correo sale desde Outlook", JSON.stringify({ n: st.sent.length - before, sentRow }));
  const r3 = await run();
  const [{ n: refs }] = await sql`SELECT count(*)::int AS n FROM activities WHERE external_ref = ${`msg:${mail.internetMessageId}`}`;
  check(refs === 1 && r3.sync.emails === 0, "el correo enviado no se duplica al sincronizar «Enviados»", String(refs));

  // ---- Correo completo: conversación, seguimiento y envío programado.
  {
    const [out] = await sql`SELECT id, token, track, status, external_ref FROM emails WHERE external_ref = ${`msg:${mail.internetMessageId}`}`;
    check(out?.status === "sent" && out.track && out.token && mail.body?.contentType === "HTML" && mail.body.content.includes(`/t/o/${out.token}.gif`),
          "correo: el enviado queda en la conversación, en HTML y con píxel de apertura", JSON.stringify({ out, ct: mail.body?.contentType }));
    // Una apertura al instante del envío la hace un escáner: se deja pasar un minuto «de mentira».
    await sql`UPDATE emails SET sent_at = now() - interval '1 minute' WHERE id = ${out.id}`;
    const pix = await fetch(`${BASE}/t/o/${out.token}.gif`, { headers: { "user-agent": UA_DESKTOP } });
    const [o1] = await sql`SELECT open_count FROM emails WHERE id = ${out.id}`;
    const [ev] = await sql`SELECT count(*)::int AS n FROM events WHERE event_type = 'email.opened' AND payload->>'email_id' = ${out.id}`;
    check(pix.status === 200 && pix.headers.get("content-type") === "image/gif" && o1.open_count === 1 && ev.n === 1,
          "correo: la apertura se cuenta (sin iniciar sesión) y queda en la historia", JSON.stringify({ st: pix.status, o1, ev }));
    await fetch(`${BASE}/t/o/${out.token}.gif`, { headers: { "user-agent": UA_DESKTOP } });
    const [ev2] = await sql`SELECT count(*)::int AS n FROM events WHERE event_type = 'email.opened' AND payload->>'email_id' = ${out.id}`;
    check(ev2.n === 1, "correo: abrirlo otra vez suma pero no repite el aviso");
    // Clics: solo enlaces que estaban en el correo.
    const tok = "tok-de-prueba-0123456789abcd";
    const [ce] = await sql`INSERT INTO emails (direction, status, deal_id, subject, body, track, token, sent_at)
                           VALUES ('out', 'sent', ${DEAL_OPEN}, 'Con enlace', 'Mira https://aikit.example/propuesta?x=1 y dime.', true, ${tok}, now() - interval '1 minute') RETURNING id`;
    const evil = await fetch(`${BASE}/t/c/${tok}?u=${encodeURIComponent("https://malo.example/")}`, { redirect: "manual" });
    const good = await fetch(`${BASE}/t/c/${tok}?u=${encodeURIComponent("https://aikit.example/propuesta?x=1")}`, { redirect: "manual", headers: { "user-agent": UA_DESKTOP } });
    const [c1] = await sql`SELECT click_count FROM emails WHERE id = ${ce.id}`;
    check(evil.status === 404 && good.status === 302 && good.headers.get("location") === "https://aikit.example/propuesta?x=1" && c1.click_count === 1,
          "correo: el clic se cuenta y redirige; no sirve para redirigir a otros sitios", JSON.stringify({ evil: evil.status, good: good.status, c1 }));
    // Recibidos: entran en la conversación y avisan al deal.
    const [inb] = await sql`SELECT count(*)::int AS n FROM emails WHERE direction = 'in' AND deal_id = ${DEAL_OPEN}`;
    const [rec] = await sql`SELECT count(*)::int AS n FROM events WHERE event_type = 'email.received' AND entity_id = ${DEAL_OPEN}`;
    check(inb.n >= 1 && rec.n >= 1, "correo: los recibidos del contacto entran en la conversación del deal", JSON.stringify({ inb, rec }));
    // Programado: sale en la revisión cuando llega su hora.
    const [pe] = await sql`INSERT INTO emails (direction, status, deal_id, person_id, user_id, to_email, to_name, subject, body, scheduled_at, track)
                           VALUES ('out', 'scheduled', ${DEAL_OPEN}, ${PERSON}, ${OWNER}, 'ana@paco.example', 'Ana García', 'Programado de prueba',
                                   'Hola Ana, te escribo a la hora prevista.', now() - interval '1 minute', true) RETURNING id`;
    const nBefore = (await mock("/__state")).sent.length;
    const rs = await run();
    const [pe2] = await sql`SELECT status, sent_at, external_ref FROM emails WHERE id = ${pe.id}`;
    check(rs.scheduled?.sent === 1 && pe2.status === "sent" && pe2.external_ref && (await mock("/__state")).sent.length === nBefore + 1,
          "correo: el programado se envía cuando llega su hora", JSON.stringify({ sch: rs.scheduled, pe2 }));
    // Secuencia: el primer paso sale por Outlook y al responder se para.
    const [seq] = await sql`SELECT id FROM sequences WHERE name = 'Seguimiento tras la propuesta'`;
    const [en] = await sql`INSERT INTO sequence_enrollments (sequence_id, deal_id, person_id, user_id, next_step, next_run_at, enrolled_by)
                           VALUES (${seq.id}, ${DEAL_OPEN}, ${PERSON}, ${OWNER}, 0, now() - interval '1 minute', ${ADMIN_ID}) RETURNING id`;
    const sBefore = (await mock("/__state")).sent.length;
    const rq = await run();
    const [en1] = await sql`SELECT status, next_step, next_run_at, error FROM sequence_enrollments WHERE id = ${en.id}`;
    const [se] = await sql`SELECT subject, body FROM emails WHERE enrollment_id = ${en.id}`;
    const inDays = en1.next_run_at ? Math.round((new Date(en1.next_run_at) - Date.now()) / 86400000) : null;
    check(rq.sequences?.sent === 1 && (await mock("/__state")).sent.length === sBefore + 1 && se?.subject === "¿Qué te ha parecido la propuesta?"
          && se.body.startsWith("Hola Ana,") && se.body.includes("(hora de Madrid)") && en1.status === "active" && en1.next_step === 1 && inDays === 3,
          "secuencia: el primer paso sale por Outlook con los datos del deal y el siguiente queda en 3 días", JSON.stringify({ seq: rq.sequences, en1, subject: se?.subject }));
    const seqPage = await (await get(`/sequences/${seq.id}`)).text();
    check(seqPage.includes("Seguimiento tras la propuesta") && seqPage.includes("Ana García") && seqPage.includes("En marcha") && seqPage.includes("Paso 4"),
          "/sequences/<id> muestra los pasos y quién está en marcha");
    await sql`INSERT INTO emails (direction, status, deal_id, person_id, from_email, subject, body, sent_at)
              VALUES ('in', 'sent', ${DEAL_OPEN}, ${PERSON}, 'ana@paco.example', 'Re: propuesta', 'Sí, hablamos el jueves', now())`;
    await run();
    const [en2] = await sql`SELECT status, stopped_reason FROM sequence_enrollments WHERE id = ${en.id}`;
    check(en2.status === "stopped" && en2.stopped_reason === "Respondió", "secuencia: al responder el contacto, se para sola", JSON.stringify(en2));
    const list = await (await get("/sequences")).text();
    check(list.includes("Seguimiento tras la propuesta") && list.includes("Respondieron"), "/sequences lista las secuencias con sus resultados");

    // --- Editor de correos (al estilo de Apollo): formato, variables, condiciones, A/B, pausa por datos, hilo y manual.
    const [sq] = await sql`INSERT INTO sequences (name, created_by) VALUES ('Editor e2e', ${ADMIN_ID}) RETURNING id`;
    const [st1] = await sql`INSERT INTO sequence_steps (sequence_id, position, delay_days, kind, format, subject, body) VALUES (${sq.id}, 1, 0, 'email', 'html',
      '{{empresa|tu empresa}}: una idea', '<p>Hola {{nombre->mayusculas}}, {{#if cargo}}como {{cargo}}{{#else}}como responsable{{#endif}} te interesa <a href="https://aikit.example/demo">esta demo</a>. ¿Hablamos?</p>') RETURNING id`;
    await sql`INSERT INTO sequence_step_variants (step_id, label, subject, body) VALUES (${st1.id}, 'B', 'Pregunta rápida, {{nombre}}', '<p>Hola {{nombre}}, ¿te va bien el {{hoy_dia_semana->mas_2}}?</p>')`;
    const [st2] = await sql`INSERT INTO sequence_steps (sequence_id, position, delay_days, delay_hours, kind, format, thread_reply, subject, body) VALUES (${sq.id}, 2, 0, 0, 'email', 'text', true, '',
      'Hola {{nombre}}, sobre {{contacto.prioridad_e2e}}: ¿lo vemos?') RETURNING id`;
    await sql`INSERT INTO sequence_steps (sequence_id, position, delay_days, kind, format, subject, body) VALUES (${sq.id}, 3, 0, 'manual_email', 'text', 'Último intento, {{nombre}}', 'Hola {{nombre}}, ¿cierro el tema?')`;
    await sql`UPDATE users SET email_signature = '<p><strong>{{remitente}}</strong> · aikit</p>' WHERE id = ${OWNER}`;
    const [beto] = await sql`INSERT INTO persons (first_name, last_name) VALUES ('Beto', 'Prueba') RETURNING id`;
    await sql`INSERT INTO person_emails (person_id, email, is_primary) VALUES (${beto.id}, 'beto@ejemplo-e2e.example', true)`;
    const [ea] = await sql`INSERT INTO sequence_enrollments (sequence_id, deal_id, person_id, user_id, next_step, next_run_at, enrolled_by)
                           VALUES (${sq.id}, ${DEAL_OPEN}, ${PERSON}, ${OWNER}, 0, now() - interval '1 minute', ${ADMIN_ID}) RETURNING id`;
    const [eb] = await sql`INSERT INTO sequence_enrollments (sequence_id, deal_id, person_id, user_id, next_step, next_run_at, enrolled_by, created_at)
                           VALUES (${sq.id}, NULL, ${beto.id}, ${OWNER}, 0, now() - interval '30 seconds', ${ADMIN_ID}, now() + interval '1 second') RETURNING id`;
    const sentBefore = (await mock("/__state")).sent.length;
    const r1 = await run();
    const mails = await sql`SELECT person_id, subject, body, body_html, variant, sequence_step_id, token FROM emails WHERE enrollment_id IN (${ea.id}, ${eb.id}) ORDER BY created_at`;
    const ma = mails.find((m) => m.person_id === PERSON), mb = mails.find((m) => m.person_id === beto.id);
    const outbox = (await mock("/__state")).sent.slice(sentBefore);
    const htmlA = outbox.find((m) => m.subject === ma?.subject)?.body;
    check(r1.sequences?.sent >= 2 && ma?.variant === "A" && mb?.variant === "B" && ma.sequence_step_id === st1.id
          && ma.body_html.includes("Hola ANA,") && ma.body_html.includes("como Directora de Marketing") && ma.body_html.includes("<strong>")
          && !ma.body.includes("<p>") && ma.body.includes("esta demo (https://aikit.example/demo)")
          && htmlA?.contentType === "HTML" && htmlA.content.includes(`/t/c/${ma.token}?u=`) && htmlA.content.includes(`/t/o/${ma.token}.gif`),
          "editor: el correo con formato sale con variables, condiciones, firma y enlaces seguidos; las variantes A y B se reparten",
          JSON.stringify({ r: r1.sequences, ma, mb: mb?.variant, ct: htmlA?.contentType }));
    await sql`UPDATE sequence_enrollments SET next_run_at = now() + interval '30 days' WHERE id = ${eb.id}`;
    check(/^Pregunta rápida, Beto$/.test(mb?.subject ?? "") && /(lunes|martes|miércoles|jueves|viernes)/.test(mb?.body ?? ""),
          "editor: variables de fecha (días laborables) y nombre en la variante B", JSON.stringify(mb));
    const clk = await fetch(`${BASE}/t/c/${ma.token}?u=${encodeURIComponent("https://aikit.example/demo")}`, { redirect: "manual", headers: { "user-agent": UA_DESKTOP } });
    check(clk.status === 302, "editor: los clics en enlaces del correo con formato se cuentan", `HTTP ${clk.status}`);
    // Paso 2: le falta un dato sin valor por defecto → no sale, queda en pausa y avisa.
    await sql`UPDATE sequence_enrollments SET next_run_at = now() - interval '1 minute' WHERE id = ${ea.id}`;
    const r2 = await run();
    const [pa] = await sql`SELECT status, error, next_step FROM sequence_enrollments WHERE id = ${ea.id}`;
    const [nt] = await sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'sequence' AND title LIKE '%Ana%'`;
    check(r2.sequences?.paused >= 1 && pa.status === "paused" && pa.error.includes("contacto.prioridad_e2e") && pa.next_step === 1 && nt.n >= 1,
          "editor: si falta un dato, el correo no sale y la inscripción queda en pausa (con aviso)", JSON.stringify({ r: r2.sequences, pa, nt }));
    const pausedPage = await (await get(`/sequences/${sq.id}`)).text();
    check(pausedPage.includes("En pausa") && pausedPage.includes("Reanudar") && pausedPage.includes("Va ganando") === false && pausedPage.includes("Enviados"),
          "editor: la secuencia muestra la pausa, el botón de reanudar y los resultados por paso");
    await sql`UPDATE persons SET custom = custom || '{"prioridad_e2e": "la renovación"}' WHERE id = ${PERSON}`;
    await sql`UPDATE mailbox_connections SET signature = '<p>Firma del buzón e2e</p>' WHERE user_id = ${OWNER} AND purpose = 'main'`;
    await sql`UPDATE sequence_enrollments SET status = 'active', error = NULL, next_run_at = now() - interval '1 minute' WHERE id = ${ea.id}`;
    await run();
    const [m2] = await sql`SELECT subject, body, sequence_step_id FROM emails WHERE enrollment_id = ${ea.id} AND sequence_step_id = ${st2.id}`;
    check(m2?.subject === `Re: ${ma.subject}` && m2.body.startsWith("Hola Ana, sobre la renovación: ¿lo vemos?") && m2.body.includes("Firma del buzón e2e")
          && !m2.body.includes("· aikit"),
          "editor: al completar el dato y reanudar, sale; en el mismo hilo («Re: ») y con la firma del buzón (que manda sobre la de la persona)", JSON.stringify(m2));
    await sql`UPDATE mailbox_connections SET signature = NULL WHERE user_id = ${OWNER}`;
    // Paso 3: correo manual → borrador para revisar; al completarlo, la secuencia termina.
    await sql`UPDATE sequence_enrollments SET next_run_at = now() - interval '1 minute' WHERE id = ${ea.id}`;
    const r3 = await run();
    const [w] = await sql`SELECT e.waiting_activity_id, a.draft_subject, a.draft_html, a.draft_to, a.done FROM sequence_enrollments e
                          JOIN activities a ON a.id = e.waiting_activity_id WHERE e.id = ${ea.id}`;
    check(r3.sequences?.manual === 1 && w?.draft_subject === "Último intento, Ana" && w.draft_html.includes("Hola Ana") && w.draft_to === "ana@paco.example" && !w.done,
          "editor: el correo manual queda como borrador para revisarlo y enviarlo", JSON.stringify({ r: r3.sequences, w }));
    const tasksPage = await (await get("/sequences/tasks?todos=1")).text();
    check(tasksPage.includes("Correos manuales por enviar") && tasksPage.includes("Último intento, Ana"), "/sequences/tasks lista los correos manuales");
    await sql`UPDATE activities SET done = true, done_at = now() WHERE id = ${w.waiting_activity_id}`;
    await run();
    const [fin] = await sql`SELECT status FROM sequence_enrollments WHERE id = ${ea.id}`;
    check(fin.status === "completed", "editor: completado el correo manual, la secuencia sigue (aquí, termina)", JSON.stringify(fin));
    // Horario de envío: fuera de los días elegidos no sale nada.
    const wd = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 })[new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", weekday: "short" }).format(new Date())];
    await sql`UPDATE sequences SET send_days = ${[1, 2, 3, 4, 5, 6, 7].filter((d) => d !== wd)} WHERE id = ${sq.id}`;
    await sql`UPDATE sequence_enrollments SET next_run_at = now() - interval '1 minute' WHERE id = ${eb.id}`;
    await run();
    const [wb] = await sql`SELECT next_run_at, next_step FROM sequence_enrollments WHERE id = ${eb.id}`;
    check(wb.next_step === 1 && new Date(wb.next_run_at) > new Date(Date.now() + 60000), "editor: fuera del horario de envío de la secuencia, espera al siguiente día permitido", JSON.stringify(wb));
    await sql`UPDATE sequence_enrollments SET status = 'stopped', next_run_at = NULL WHERE id = ${eb.id}`;
    await sql`UPDATE users SET email_signature = NULL WHERE id = ${OWNER}`;

    const page = await (await get(`/deals/${DEAL_OPEN}`)).text();
    check(page.includes("Correos") && page.includes("Programado de prueba") && page.includes("Abierto") && page.includes("Seguir aperturas y clics")
          && page.includes("Seguimiento tras la demo"), "correo: la ficha muestra la conversación, las aperturas y las plantillas");
    const tpl = await (await get("/settings/templates")).text();
    check(tpl.includes("Plantillas de correo") && tpl.includes("Retomar el contacto") && tpl.includes("Seguimiento de aperturas y clics"),
          "/settings/templates lista las plantillas");
  }
  await sql`UPDATE ai_permissions SET autonomy = 'ask' WHERE actor = 'assistant' AND action_type = 'draft_email'`;
  await sql`UPDATE automation_rules SET autonomy = 'ask' WHERE key = 'offer_session_slots'`;

  // Acceso caducado: se renueva solo.
  await mock("/__expire", "POST");
  check((await get(`/api/calendar/slots?deal=${DEAL_OPEN}`)).ok, "si caduca el acceso, se renueva sin intervención");

  // Acceso revocado: queda marcado para reconectar.
  await mock("/__revoke", "POST");
  await get(`/api/calendar/slots?deal=${DEAL_OPEN}`);
  const [revoked] = await sql`SELECT status, last_error FROM mailbox_connections WHERE user_id = ${OWNER}`;
  const page1 = await (await get("/settings/mailbox")).text();
  check(revoked.status === "error" && page1.includes("Reconectar Microsoft 365"), "si Microsoft revoca el acceso, pide reconectar", JSON.stringify(revoked));
  // Sin buzón activo, el correo vuelve a no poder salir solo.
  const conf = await (await get("/settings/automations")).text();
  check(conf.includes("Enviar correos"), "/settings/automations sigue respondiendo con el buzón caído");
}

// ------------------------------------------------------------- Correo, calendario y documentos (Google Workspace simulado)
if (process.env.MOCK_URL) {
  const MOCK = process.env.MOCK_URL;
  const SECRET = process.env.CRON_SECRET ?? "";
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  const mock = async (path) => (await fetch(`${MOCK}${path}`)).json();
  const [{ owner_id: MS_OWNER }] = await sql`SELECT owner_id FROM deals WHERE id = ${DEAL_OPEN}`;
  const [{ id: G_USER }] = await sql`SELECT id FROM users WHERE kind = 'human' AND id <> ${MS_OWNER} ORDER BY name LIMIT 1`;

  const r1 = await get(`/api/integrations/google/connect?user=${G_USER}`);
  const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
  const auth1 = r1.headers.get("location") ?? "";
  check(auth1.includes("/o/oauth2/v2/auth") && auth1.includes("access_type=offline") && auth1.includes("code_challenge="),
        "Google: redirige al inicio de sesión con acceso permanente y PKCE", auth1.slice(0, 80));
  const r2 = await fetch(auth1, { redirect: "manual" });
  const r3 = await get(r2.headers.get("location").replace(/^https?:\/\/[^/]+/, ""), { headers: { cookie } });
  check((r3.headers.get("location") ?? "").includes("connected=jesus%40empresa-google.example"), "Google: vuelve al CRM conectado", r3.headers.get("location"));
  const [gconn] = await sql`SELECT provider, email, scheduling, tokens FROM mailbox_connections WHERE user_id = ${G_USER}`;
  check(gconn?.provider === "google" && gconn.scheduling.timezone === "Europe/Madrid" && gconn.tokens.startsWith("v1."),
        "Google: cuenta guardada (cifrada) con su zona horaria", JSON.stringify(gconn && { ...gconn, tokens: undefined }));

  // Huecos: lo rechazado y lo marcado «disponible» no ocupa.
  const madrid = (d) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d));
  const gs = await (await get(`/api/calendar/slots?user=${G_USER}`)).json();
  // (Lo ocupado acaba a las 13:00 + 15 min de margen; lo rechazado de 14:00 a 17:00 no debe contar. La
  //  antelación de 24 h puede retrasar el primero según la hora a la que se ejecute la prueba.)
  check(gs.slots?.length === 3 && gs.slots.every((x) => madrid(x.start) >= "13:30" && madrid(x.start) <= "16:30")
        && gs.slots.filter((x) => madrid(x.start) === "13:30").length >= 2,
        "Google: huecos tras lo ocupado, sin contar lo rechazado ni lo «disponible»", JSON.stringify(gs.slots?.map((x) => madrid(x.start)) ?? gs));

  // Sincronización (Gmail paginado, sin borradores; calendario sin cancelados).
  const s1 = await run();
  check(s1.sync?.emails === 2 && s1.sync?.meetings === 1, "Google: sincroniza 2 correos y 1 reunión con contactos", JSON.stringify(s1.sync));
  const [meet] = await sql`SELECT type, meeting_url FROM activities WHERE external_ref = 'gcal:ge1'`;
  check(meet?.meeting_url === "https://meet.example/ge1", "Google: la reunión guarda su enlace de Meet", JSON.stringify(meet));
  const s2 = await run();
  check(s2.sync?.emails === 0 && s2.sync?.meetings === 0, "Google: una segunda sincronización no duplica", JSON.stringify(s2.sync));

  // Documentos de Google Drive.
  const ds = await (await get(`/api/drive/search?q=${encodeURIComponent("paco")}`)).json();
  check(ds.provider === "google" && ds.files?.length === 2 && ds.files.some((f) => f.name === "Propuesta Paco 2026" && f.url.includes("/presentation/")),
        "Google Drive: busca archivos por nombre", JSON.stringify(ds));

  // Envío desde Gmail (el deal pasa a ser de la persona con Google; correo en «Sola»).
  await sql`UPDATE deals SET owner_id = ${G_USER} WHERE id = ${DEAL_OPEN}`;
  await sql`DELETE FROM automation_actions WHERE deal_id = ${DEAL_OPEN} AND rule_id = (SELECT id FROM automation_rules WHERE key = 'offer_session_slots')`;
  await sql`UPDATE ai_permissions SET autonomy = 'auto' WHERE actor = 'assistant' AND action_type = 'draft_email'`;
  await sql`UPDATE automation_rules SET autonomy = 'auto' WHERE key = 'offer_session_slots'`;
  // Jefe de agentes: la IA ya escribió hoy a Ana (desde Outlook) → este correo no sale solo, queda para decidir.
  await run();
  const [held] = await sql`SELECT x.mode, x.status, x.reason FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
                           WHERE r.key = 'offer_session_slots' AND x.deal_id = ${DEAL_OPEN} ORDER BY x.created_at DESC LIMIT 1`;
  check(held?.mode === "ask" && held.status === "pending" && held.reason.includes("otro agente ya le ha escrito"),
        "jefe de agentes: dos correos de los agentes al mismo contacto el mismo día no salen solos", JSON.stringify(held));
  await sql`UPDATE app_settings SET agent_emails_per_contact_day = 5`;
  await sql`DELETE FROM automation_actions WHERE deal_id = ${DEAL_OPEN} AND rule_id = (SELECT id FROM automation_rules WHERE key = 'offer_session_slots')`;
  await run();
  await sql`UPDATE app_settings SET agent_emails_per_contact_day = 1`;
  const gst = await mock("/__state");
  const gmail = gst.gsent.at(-1);
  check(gmail && gmail.to.includes("ana@paco.example") && gmail.subject.includes("¿cuándo hacemos la videollamada?") && gmail.body.includes("(hora de Madrid)"),
        "Gmail: el correo sale con asunto y texto con acentos", JSON.stringify(gmail));
  const [{ n: gref }] = await sql`SELECT count(*)::int AS n FROM activities WHERE external_ref = ${`gmail:${gmail?.id}`}`;
  const s3 = await run();
  check(gref === 1 && s3.sync?.emails === 0, "Gmail: el enviado no se duplica al sincronizar", JSON.stringify({ gref, sync: s3.sync }));
  await sql`UPDATE deals SET owner_id = ${MS_OWNER} WHERE id = ${DEAL_OPEN}`;
  await sql`UPDATE ai_permissions SET autonomy = 'ask' WHERE actor = 'assistant' AND action_type = 'draft_email'`;
  await sql`UPDATE automation_rules SET autonomy = 'ask' WHERE key = 'offer_session_slots'`;

  const page = await (await get("/settings/mailbox")).text();
  check(page.includes("Google Workspace · jesus@empresa-google.example"), "/settings/mailbox muestra la cuenta de Google");
  const dealPage = await (await get(`/deals/${DEAL_OPEN}`)).text();
  check(dealPage.includes("Documentos") && dealPage.includes("Enlazar documento"), "la ficha del deal tiene la sección de documentos");
}

// ------------------------------------------------------------- Resúmenes automáticos (con y sin IA)
{
  const SECRET = process.env.CRON_SECRET ?? "";
  const MOCK = process.env.MOCK_URL;
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  // Mismo cifrado que src/lib/crypto.ts (para guardar la clave del modelo desde la prueba).
  const enc = (plain) => {
    const key = createHash("sha256").update(process.env.TOKEN_ENCRYPTION_KEY ?? "").digest();
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  };

  // Sin IA: resumen y siguiente paso por reglas.
  const deal0 = await (await get(`/deals/${DEAL_OPEN}`)).text();
  check(deal0.includes("Siguiente paso") && deal0.includes("Según la actividad del deal"), "ficha del deal: resumen y siguiente paso por reglas");
  check(/class="step-when who-(you|ai_auto|ai_ask)"/.test(deal0) && deal0.includes("<dt>Quién</dt>") && deal0.includes("<dt>Cómo</dt>"),
        "siguiente paso: cuándo, y detalles de quién y cómo");
  const [{ owner_id: OWNER }] = await sql`SELECT owner_id FROM deals WHERE id = ${DEAL_OPEN}`;
  const today = await (await get(`/?owner=${OWNER}`)).text();
  check(today.includes("Paco — ampliación de servicio") && today.includes("Decisiones pendientes"), "Hoy: parte filtrado por persona");

  if (MOCK && process.env.TOKEN_ENCRYPTION_KEY) {
    await sql`UPDATE ai_settings SET provider = 'anthropic', base_url = ${`${MOCK}/llm/anthropic`}, model = 'modelo-de-pruebas',
                     api_key = ${enc("clave-llm-de-pruebas")}, last_error = NULL`;

    // Reunión celebrada con transcripción → correo de resumen redactado por la IA y propuesta de pasar de fase.
    const [meet] = await sql`SELECT id FROM activities WHERE deal_id = ${DEAL_OPEN} AND external_ref = 'evt:e1'`;
    await sql`UPDATE activities SET done = true, outcome = 'held', transcript = 'Ana: nos encaja, revisad plazos.' WHERE id = ${meet.id}`;
    await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type, payload)
              VALUES ('deal', ${DEAL_OPEN}, 'activity.completed', 'user', ${sql.json({ activity_id: meet.id, outcome: "held" })})`;
    const r1 = await run();
    const [recap] = await sql`SELECT x.payload FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
                              WHERE r.key = 'meeting_recap' AND x.deal_id = ${DEAL_OPEN} AND x.status = 'pending'`;
    check(recap?.payload.body.includes("(IA) Repasamos la propuesta") && recap.payload.body.includes("- (IA) Enviar la propuesta revisada")
          && recap.payload.body.includes("(hora de Madrid)") && recap.payload.subject.includes("Resumen de nuestra videollamada"),
          "tras la reunión: correo con resumen, próximos pasos (IA) y huecos", JSON.stringify(recap?.payload));
    const [{ summary }] = await sql`SELECT summary FROM activities WHERE id = ${meet.id}`;
    check(summary?.startsWith("(IA)"), "tras la reunión: el resumen queda en la actividad", summary);
    const [adv] = await sql`SELECT x.payload FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
                            WHERE r.key = 'advance_after_session' AND x.deal_id = ${DEAL_OPEN} AND x.status = 'pending'`;
    check(adv?.payload.stage_name === "Propuesta enviada", "sesión de la fase celebrada: propone pasar a la siguiente", JSON.stringify(adv?.payload));

    // Resúmenes de deals con IA (en caché) y fallback.
    check(r1.briefs > 0, "la revisión redacta con IA los resúmenes de deals con novedades", JSON.stringify(r1));
    const [b] = await sql`SELECT content FROM deal_briefs WHERE deal_id = ${DEAL_OPEN}`;
    check(b?.content.siguiente_paso === "(IA) Llama a Ana para cerrar fecha", "resumen del deal: la respuesta JSON del modelo se interpreta", JSON.stringify(b));
    const deal1 = await (await get(`/deals/${DEAL_OPEN}`)).text();
    check(deal1.includes("(IA) Llama a Ana para cerrar fecha") && deal1.includes("Redactado por la IA"), "ficha del deal: muestra el resumen de la IA");
    const [g1] = await sql`SELECT generated_at FROM deal_briefs WHERE deal_id = ${DEAL_OPEN}`;
    await run();
    const [g2] = await sql`SELECT generated_at FROM deal_briefs WHERE deal_id = ${DEAL_OPEN}`;
    check(g1.generated_at.getTime() === g2.generated_at.getTime(), "sin novedades en el deal, no se vuelve a pedir su resumen a la IA");

    // Traspaso a CS redactado por la IA.
    const [won] = await sql`SELECT id FROM open_deals_status WHERE id <> ${DEAL_OPEN} ORDER BY id DESC LIMIT 1`;
    await sql`UPDATE deals SET status = 'won' WHERE id = ${won.id}`;
    await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type) VALUES ('deal', ${won.id}, 'deal.won', 'user')`;
    await run();
    const [ho] = await sql`SELECT a.note FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
                           JOIN activities a ON a.id = (x.result->>'activity_id')::uuid WHERE r.key = 'won_handoff' AND x.deal_id = ${won.id}`;
    check(ho?.note.startsWith("(IA) Traspaso") && ho.note.includes("— Datos del CRM —"), "traspaso a CS redactado por la IA, con los datos debajo", ho?.note?.slice(0, 80));

    // Traspaso por correo a Customer Success: responsable de la empresa o dirección por defecto.
    const winDeal = async (id) => {
      await sql`UPDATE deals SET status = 'won' WHERE id = ${id}`;
      await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type) VALUES ('deal', ${id}, 'deal.won', 'user')`;
    };
    const csMail = async (id) => (await sql`SELECT x.status, x.mode, x.payload, x.result FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
                                             WHERE r.key = 'won_handoff_email' AND x.deal_id = ${id}`)[0];
    await sql`UPDATE automation_rules SET params = params || ${sql.json({ cs_email: "cs@aikit.example", cs_name: "equipo de CS" })}
              WHERE key = 'won_handoff_email'`;
    // Tres deals de empresas distintas (si compartieran empresa, el responsable de CS se pisaría).
    const [dA, dB, dC] = await sql`SELECT * FROM (
                                     SELECT DISTINCT ON (ods.organization_id) ods.id, ods.organization_id FROM open_deals_status ods
                                     WHERE ods.organization_id IS NOT NULL AND ods.id <> ${DEAL_OPEN}
                                       AND ods.organization_id NOT IN (SELECT organization_id FROM deals WHERE id = ${DEAL_OPEN})
                                     ORDER BY ods.organization_id, ods.id) x
                                   ORDER BY id LIMIT 3`;
    await sql`UPDATE organizations SET cs_manager_name = 'Lucía CS', cs_manager_email = 'lucia@aikit.example' WHERE id = ${dA.organization_id}`;
    await sql`UPDATE organizations SET cs_manager_name = NULL, cs_manager_email = NULL WHERE id IN (${dB.organization_id}, ${dC.organization_id})`;
    const llmBefore = (await (await fetch(`${MOCK}/__state`)).json()).llm.filter((c) => c.task === "handoff").length;
    await winDeal(dA.id);
    await winDeal(dB.id);
    await run();
    const llmAfter = (await (await fetch(`${MOCK}/__state`)).json()).llm.filter((c) => c.task === "handoff").length;
    const mA = await csMail(dA.id), mB = await csMail(dB.id);
    check(mA?.status === "pending" && mA.payload.to === "lucia@aikit.example" && mA.payload.body.startsWith("Hola Lucía CS")
          && mA.payload.body.includes("(IA) Traspaso") && mA.payload.subject.startsWith("Nuevo cliente:"),
          "traspaso por correo: al responsable de CS de la empresa, con el resumen (en «Preguntar»)", JSON.stringify(mA?.payload).slice(0, 200));
    check(mB?.payload.to === "cs@aikit.example" && mB.payload.body.startsWith("Hola equipo de CS"),
          "traspaso por correo: sin responsable en la empresa, a la dirección de CS por defecto", JSON.stringify(mB?.payload?.to));
    check(llmAfter - llmBefore === 2, "el resumen del traspaso se pide a la IA una sola vez por deal (tarea y correo)", `${llmAfter - llmBefore}`);
    // En «Sola», sale por correo directamente.
    await sql`UPDATE ai_permissions SET autonomy = 'auto' WHERE actor = 'assistant' AND action_type = 'draft_email'`;
    await sql`UPDATE automation_rules SET autonomy = 'auto' WHERE key = 'won_handoff_email'`;
    await winDeal(dC.id);
    await run();
    const mC = await csMail(dC.id);
    const sentCs = (await (await fetch(`${MOCK}/__state`)).json()).gsent.filter((m) => m.to.includes("cs@aikit.example"));
    check(mC?.status === "done" && mC.mode === "auto" && mC.result.sent && sentCs.some((m) => m.subject.startsWith("Nuevo cliente:")),
          "traspaso por correo en «Sola»: se envía al ganar", JSON.stringify({ st: mC?.status, n: sentCs.length }));
    await sql`UPDATE ai_permissions SET autonomy = 'ask' WHERE actor = 'assistant' AND action_type = 'draft_email'`;
    await sql`UPDATE automation_rules SET autonomy = 'ask' WHERE key = 'won_handoff_email'`;
    const orgPage = await (await get(`/organizations/${dA.organization_id}`)).text();
    check(orgPage.includes("Customer Success") && orgPage.includes("Lucía CS"), "la ficha de la empresa muestra su responsable de CS");

    // Parte del día por correo (a quien tenga cuenta conectada), una vez al día.
    // (Puede que ya saliera el de hoy sin IA en una revisión anterior: se empieza de cero.)
    await sql`DELETE FROM digest_log`;
    await sql`DELETE FROM digest_focus`;
    await sql`UPDATE automation_settings SET digest_enabled = true, digest_hour = 0, digest_days = ARRAY[1,2,3,4,5,6,7]`;
    const r3 = await run();
    const st = await (await fetch(`${MOCK}/__state`)).json();
    const mail = st.gsent.filter((m) => m.subject.startsWith("Tu parte del día")).at(-1);
    check(r3.digests >= 1 && mail?.to === "jesus@empresa-google.example" && mail.body.includes("Enfoque del día (IA):") && mail.body.includes("Pipeline abierto"),
          "parte del día: llega al correo de la persona con el enfoque de la IA", JSON.stringify({ digests: r3.digests, mail: mail?.body?.slice(0, 120) }));
    const r4 = await run();
    check(r4.digests === 0, "parte del día: solo uno al día", JSON.stringify(r4));
    const hoy = await (await get("/")).text();
    check(hoy.includes("(IA) Hoy, primero responde a Ana") && hoy.includes("Redactado por la IA"), "Hoy: muestra el enfoque del día de la IA");
    check(st.llm.every((c) => c.model === "modelo-de-pruebas") && st.llm.some((c) => c.task === "daily_digest"), "se usa el modelo configurado", JSON.stringify(st.llm.slice(0, 3)));

    // Formulario web con chat de IA: público, cualifica y crea el lead con la conversación.
    await sql`INSERT INTO web_forms (slug, name, title, chat_enabled, chat_context, source)
              VALUES ('contacto-e2e', 'Contacto e2e', 'Hablemos e2e', true, 'Vendemos un CRM.', 'web e2e') ON CONFLICT (slug) DO NOTHING`;
    const fpage = await fetch(`${BASE}/f/contacto-e2e`);
    const fhtml = await fpage.text();
    check(fpage.status === 200 && fhtml.includes("Hablemos e2e") && fhtml.includes("Chatear") && !fhtml.includes('aria-label="Principal"'),
          "formulario web: página pública con chat (sin sesión ni menú)", `HTTP ${fpage.status}`);
    const say = (messages) => fetch(`${BASE}/api/public/chat/contacto-e2e`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }),
    }).then((r) => r.json());
    const c1 = await say([{ rol: "visitante", texto: "Hola, queremos un CRM para 20 comerciales" }]);
    check(c1.reply?.includes("email") && c1.done === false, "chat: la IA responde y pide el email", JSON.stringify(c1));
    const c2 = await say([
      { rol: "visitante", texto: "Hola, queremos un CRM para 20 comerciales" }, { rol: "asistente", texto: c1.reply },
      { rol: "visitante", texto: "Claro: chat.e2e@chat-sl.example" },
    ]);
    const [cl] = await sql`SELECT l.source, (SELECT content FROM notes n WHERE n.lead_id = l.id ORDER BY created_at DESC LIMIT 1) AS note
                           FROM leads l JOIN person_emails pe ON pe.person_id = l.person_id WHERE pe.email = 'chat.e2e@chat-sl.example'`;
    check(c2.done === true && cl?.source === "web e2e" && cl.note?.includes("Conversación:") && cl.note.includes("20 comerciales"),
          "chat: con el email, crea el lead con el resumen y la conversación", JSON.stringify({ c2, cl }));
    const [fc] = await sql`SELECT submissions FROM web_forms WHERE slug = 'contacto-e2e'`;
    check(fc.submissions === 1, "formulario web: cuenta lo recibido");
    const fset = await (await get("/settings/forms")).text();
    check(fset.includes("Formularios web") && fset.includes("/f/contacto-e2e"), "/settings/forms lista los formularios");

    // Pregunta en lenguaje natural → informe del catálogo.
    const askHtml = await (await get(`/reports?q=${encodeURIComponent("¿Cuánto hemos ganado por origen?")}`)).text();
    check(askHtml.includes("(IA) Importe ganado por origen") && askHtml.includes("Guardar en el dashboard"),
          "informes: una pregunta en lenguaje natural se convierte en un informe que se puede guardar");

    // Si el modelo falla, se sigue con reglas y el error queda visible.
    await sql`UPDATE ai_settings SET api_key = ${enc("clave-mala")}`;
    await sql`DELETE FROM deal_briefs`;
    const r5 = await run();
    const [ai] = await sql`SELECT last_error FROM ai_settings`;
    const deal2 = await (await get(`/deals/${DEAL_OPEN}`)).text();
    check(r5.briefs === 0 && ai.last_error?.includes("Clave de API no válida") && deal2.includes("Según la actividad del deal"),
          "si la IA falla, resumen por reglas y error visible en Ajustes", JSON.stringify({ briefs: r5.briefs, err: ai.last_error }));
    const conf = await (await get("/settings/ai")).text();
    check(conf.includes("Último error") && conf.includes("Resumen tras una reunión"), "/settings/ai muestra el estado y los prompts");
  }
}

// ------------------------------------------------------------- Lista de deals: filtros, vistas y columnas
{
  const has = (html, title) => html.includes(`<strong>${title}</strong>`);
  const big = await (await get(`/pipelines/${P.inbound}?view=list&status=all&min=10000`)).text();
  check(has(big, "Paco — contrato anual") && !has(big, "Paco — otra plataforma"), "lista: filtro por importe mínimo");
  const byText = await (await get(`/pipelines/${P.inbound}?view=list&status=all&q=otra%20plat`)).text();
  check(has(byText, "Paco — otra plataforma") && !has(byText, "Paco — contrato anual"), "lista: búsqueda por texto");
  const none = await (await get(`/pipelines/${P.inbound}?view=list&q=${encodeURIComponent("100%_")}`)).text();
  check(none.includes("No hay deals con estos filtros"), "lista: los comodines de la búsqueda se tratan como texto");
  const rotten = await (await get(`/pipelines/${P.ampl}?view=list&flag=rotten`)).text();
  check(has(rotten, "Paco — ampliación de servicio") && rotten.includes("Quitar filtros"), "lista: filtro «parados»");
  const views = await (await get(`/pipelines/${P.inbound}?view=list`)).text();
  check(views.includes("Sin próxima actividad") && views.includes("Cierran este mes") && views.includes("Vistas guardadas"),
        "lista: vistas guardadas de serie");
  const cols = await (await get(`/pipelines/${P.inbound}?view=list&cols=value,cf:competidor`)).text();
  check(cols.includes("<th>Competidor principal</th>") && !cols.includes('">Cierre previsto</a>') && cols.includes('">Importe</a>'),
        "lista: columnas elegidas, también campos personalizados");
  check(cols.includes("+ Guardar esta vista"), "lista: se puede guardar la vista actual");
  const exp = await (await get(`/api/export/deals?pipeline=${P.inbound}&status=all&q=otra%20plat`)).text();
  check(exp.includes("Paco — otra plataforma") && !exp.includes("Paco — contrato anual"), "exportar desde la lista respeta sus filtros");
}

// ------------------------------------------------------------- Exportar a CSV
{
  const csv = async (path) => {
    const res = await get(path);
    const buf = Buffer.from(await res.arrayBuffer());
    return { res, bom: buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, text: buf.toString("utf8").replace(/^﻿/, "") };
  };
  const d = await csv(`/api/export/deals?pipeline=${P.ampl}&status=open`);
  const [head, ...lines] = d.text.trim().split("\r\n");
  check(d.res.status === 200 && d.res.headers.get("content-type").startsWith("text/csv") && d.bom
        && /attachment; filename="deals-\d{4}-\d{2}-\d{2}\.csv"/.test(d.res.headers.get("content-disposition") ?? ""),
        "CSV de deals: descarga UTF-8 con BOM y nombre con fecha", d.res.headers.get("content-disposition"));
  check(head.startsWith("Deal;Empresa;Contacto principal") && head.includes("Competidor principal")
        && lines.some((l) => l.startsWith("Paco — ampliación de servicio;Paco S.L.;Ana García;ana@paco.example;Ampliaciones;Necesidad detectada;Abierto;4000;EUR")),
        "CSV de deals: columnas, campos personalizados y filtros del tablero", `${head.slice(0, 80)} | ${lines[0]?.slice(0, 120)}`);
  const comma = await csv(`/api/export/deals?pipeline=${P.ampl}&status=open&sep=,`);
  check(comma.text.startsWith("Deal,Empresa,"), "CSV con separador coma");

  const leadsCsv = await csv("/api/export/leads?status=all&q=ana");
  check(leadsCsv.text.split("\r\n")[0].startsWith("Lead;Contacto;Email") && leadsCsv.text.includes("Ana García"), "CSV de leads con búsqueda");
  const orgCsv = await csv("/api/export/organizations?q=paco");
  check(orgCsv.text.includes("Segmento") && orgCsv.text.includes("Paco S.L.") && !orgCsv.text.includes("Empresa Demo"), "CSV de empresas con filtro y campos personalizados");
  const personsCsv = await csv(`/api/export/persons?organization=${ORG}`);
  check(personsCsv.text.includes("ana@paco.example") && personsCsv.text.split("\r\n").length < 10, "CSV de contactos de una empresa");
  const actCsv = await csv("/api/export/activities?view=done");
  check(actCsv.text.startsWith("Tipo;Asunto;Fecha") && actCsv.text.includes("No se presentó"), "CSV de actividades hechas");
  const hist = await csv(`/api/export/deal-history?deal=${DEAL_OPEN}`);
  check(hist.res.status === 200 && hist.text.startsWith("Fecha;Tipo;Título") && /filename="historia-paco-ampliacion-de-servicio/.test(hist.res.headers.get("content-disposition")),
        "CSV de la historia de un deal", hist.res.headers.get("content-disposition"));
  check((await csv("/api/export/ai-log")).text.startsWith("Propuesta el;Ejecutada el;Estado"), "CSV del registro de la IA");
  const [w] = await sql`SELECT id FROM dashboard_widgets ORDER BY position LIMIT 1`;
  const wc = await csv(`/api/export/widget?id=${w.id}`);
  check(wc.res.status === 200 && wc.text.split("\r\n").length >= 2, "CSV de un widget de dashboard", wc.text.slice(0, 80));

  // Celdas que Excel interpretaría como fórmula: se neutralizan.
  await sql`INSERT INTO organizations (name, industry) VALUES ('Fórmula S.L.', '=HYPERLINK("http://x","clic")')`;
  const inj = await csv("/api/export/organizations?q=rmula");
  check(inj.text.includes(`"'=HYPERLINK(""http://x"",""clic"")"`), "CSV: las fórmulas se neutralizan y las comillas se escapan", inj.text.split("\r\n")[1]);

  check((await get("/api/export/nada")).status === 404 && (await get("/api/export/deal-history")).status === 400, "exportación desconocida → 404; sin deal → 400");
  const anon = await fetch(`${BASE}/api/export/deals`, { redirect: "manual" });
  check(anon.status === 401, "la exportación exige iniciar sesión", String(anon.status));
  const leadsPage = await (await get("/leads?status=all&source=webinar")).text();
  check(leadsPage.includes("/api/export/leads?status=all&amp;source=webinar") || leadsPage.includes("/api/export/leads?status=all&source=webinar"),
        "el botón de exportar de leads lleva los filtros de la pantalla");
}

// ------------------------------------------------------------- Tipos de actividad y reglas personalizadas
{
  const SECRET = process.env.CRON_SECRET ?? "";
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  const custom = async (name, trigger, action, autonomy) => (await sql`
    INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, is_custom, trigger, action)
    VALUES (${`custom_e2e_${name}`}, ${name}, ${name}, ${autonomy}, ARRAY['off','ask','auto'], true, ${sql.json(trigger)}, ${sql.json(action)})
    RETURNING id`)[0].id;
  const actionsOf = (ruleId) => sql`SELECT status, mode, title, payload, result FROM automation_actions WHERE rule_id = ${ruleId} ORDER BY created_at`;
  const complete = async (activityId, outcome) => {
    await sql`UPDATE activities SET done = true, outcome = ${outcome} WHERE id = ${activityId}`;
    await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type, payload)
              VALUES ('deal', ${DEAL_OPEN}, 'activity.completed', 'user', ${sql.json({ activity_id: activityId, outcome })})`;
  };

  await sql`INSERT INTO activity_types (key, label, is_session, position) VALUES ('kickoff', 'Kick-off', true, 50) ON CONFLICT DO NOTHING`;
  const typesPage = await (await get("/settings/activity-types")).text();
  check(typesPage.includes("Tipos de actividad") && typesPage.includes("Videollamada"), "/settings/activity-types lista los tipos");
  const bad = await sql`INSERT INTO activities (type, subject, deal_id) VALUES ('no_existe', 'x', ${DEAL_OPEN})`.then(() => "ok", (e) => e.code);
  check(bad === "23503", "la base de datos solo admite tipos de actividad configurados", bad);

  // «Cuando un Kick-off se hace con resultado Realizada → crea una tarea en 2 días» (Sola).
  const r1 = await custom("Tras el kick-off", { kind: "activity_done", activity_type: "kickoff", outcome: "held" },
                          { kind: "create_activity", activity_type: "task", subject: "Enviar propuesta a {nombre}", due_in_days: 2, note: "Tras «{actividad}»" }, "auto");
  const [k1] = await sql`INSERT INTO activities (type, subject, deal_id, person_id, due_at) VALUES ('kickoff', 'Kick-off Paco', ${DEAL_OPEN}, ${PERSON}, now() - interval '1 hour') RETURNING id`;
  const [k2] = await sql`INSERT INTO activities (type, subject, deal_id, person_id, due_at) VALUES ('kickoff', 'Kick-off cancelado', ${DEAL_OPEN}, ${PERSON}, now() - interval '1 hour') RETURNING id`;
  await complete(k1.id, "held");
  await complete(k2.id, "cancelled");
  await run();
  const a1 = await actionsOf(r1);
  const [task] = a1[0]?.result ? await sql`SELECT type, subject, note, due_at FROM activities WHERE id = ${a1[0].result.activity_id}` : [];
  const days = task ? Math.round((new Date(task.due_at) - Date.now()) / 86400000) : null;
  check(a1.length === 1 && a1[0].status === "done" && task?.type === "task" && task.subject === "Enviar propuesta a Ana"
        && task.note === "Tras «Kick-off Paco»" && days >= 2 && days <= 3,
        "regla personalizada: al hacerse un Kick-off (Realizada) crea la tarea, solo para ese resultado", JSON.stringify({ n: a1.length, task, days }));

  // «Cuando una Tarea sigue sin hacerse 1 día después → pide una decisión» (Preguntar), y caduca al hacerla.
  const r2 = await custom("Tarea olvidada", { kind: "activity_overdue", activity_type: "task", days: 1 },
                          { kind: "notify", message: "«{actividad}» sigue sin hacer en {deal}" }, "ask");
  const [late] = await sql`INSERT INTO activities (type, subject, deal_id, due_at) VALUES ('task', 'Revisar contrato', ${DEAL_OPEN}, now() - interval '3 days') RETURNING id`;
  await run();
  const pend = (await actionsOf(r2)).filter((x) => x.payload.activity_id === late.id);
  check(pend[0]?.status === "pending" && pend[0].title === "«Revisar contrato» sigue sin hacer en Paco — ampliación de servicio",
        "regla personalizada: actividad sin hacer a tiempo → pide una decisión", JSON.stringify(pend));
  await sql`UPDATE activities SET done = true WHERE id = ${late.id}`;
  await run();
  const after = (await actionsOf(r2)).filter((x) => x.payload.activity_id === late.id);
  check(after[0]?.status === "expired", "al hacerse la actividad, la propuesta caduca", after[0]?.status);

  // «Cuando un Email se hace → mover a Propuesta enviada» (de su pipeline) en «Preguntar».
  const [prop] = await sql`SELECT id FROM stages WHERE pipeline_id = ${P.ampl} AND name = 'Propuesta enviada'`;
  const [other] = await sql`SELECT id FROM stages WHERE pipeline_id = ${P.inbound} ORDER BY position LIMIT 1`;
  const r3 = await custom("Propuesta enviada", { kind: "activity_done", activity_type: "email", outcome: "any" },
                          { kind: "move_stage", stage_id: prop.id }, "ask");
  const r4 = await custom("Otro pipeline", { kind: "activity_done", activity_type: "email", outcome: "any" },
                          { kind: "move_stage", stage_id: other.id }, "ask");
  const [em] = await sql`INSERT INTO activities (type, subject, deal_id, due_at) VALUES ('email', 'Propuesta', ${DEAL_OPEN}, now()) RETURNING id`;
  await complete(em.id, null);
  await run();
  const [mv] = await actionsOf(r3);
  check(mv?.status === "pending" && mv.payload.stage_name === "Propuesta enviada", "regla personalizada: propone mover de fase", JSON.stringify(mv?.payload));
  check((await actionsOf(r4)).length === 0, "una fase de otro pipeline no se aplica al deal");
  await sql`UPDATE automation_rules SET autonomy = 'off' WHERE id IN (${r1}, ${r2}, ${r3}, ${r4})`;

  // ---- Automatizaciones generales: disparadores de deal, condiciones y nuevas acciones.
  const [st0] = await sql`SELECT id, name FROM stages WHERE pipeline_id = ${P.ampl} ORDER BY position LIMIT 1`;
  const r5 = await custom("Al entrar en la fase", { kind: "deal_stage", stage_id: st0.id, days: 0 },
                          { kind: "add_note", content: "Entró en {fase}: preparar la reunión con {nombre}" }, "auto");
  const [nd] = await sql`INSERT INTO deals (title, pipeline_id, stage_id, value, owner_id) VALUES ('Deal recién llegado', ${P.ampl}, ${st0.id}, 5000, ${ADMIN_ID}) RETURNING id`;
  await run();
  const a5 = await actionsOf(r5);
  const [n5] = await sql`SELECT content FROM notes WHERE deal_id = ${nd.id}`;
  check(a5.length === 1 && a5[0].status === "done" && n5?.content.startsWith(`Entró en ${st0.name}: preparar la reunión con`),
        "regla general: al entrar en una fase deja una nota (y no toca los deals que ya estaban)", JSON.stringify({ n: a5.length, n5 }));
  await run();
  check((await actionsOf(r5)).length === 1, "regla general: una vez por cada entrada en la fase");

  const MOCKU = process.env.MOCK_URL;
  if (MOCKU) {
    const r6 = await custom("Ganado grande → Slack", { kind: "deal_won", filter: { min_value: 1000 } },
                            { kind: "webhook", url: `${MOCKU}/__webhook` }, "auto");
    const [small] = await sql`INSERT INTO deals (title, pipeline_id, stage_id, value) VALUES ('Deal pequeño', ${P.ampl}, ${st0.id}, 10) RETURNING id`;
    for (const d of [nd.id, small.id]) {
      await sql`UPDATE deals SET status = 'won', won_at = now() WHERE id = ${d}`;
      await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type, payload) VALUES ('deal', ${d}, 'deal.won', 'user', '{}')`;
    }
    await run();
    const a6 = await actionsOf(r6);
    const hooks = (await (await fetch(`${MOCKU}/__state`)).json()).webhooks;
    const hook = hooks.find((h) => h.deal?.id === nd.id);
    check(a6.length === 1 && a6[0].status === "done" && hook?.event === "deal_won" && hook.deal.title === "Deal recién llegado" && hook.deal.value === 5000
          && !hooks.some((h) => h.deal?.id === small.id),
          "regla general: al ganar un deal grande avisa por webhook (y no a los pequeños)", JSON.stringify({ a6: a6.length, hook }));
    await sql`UPDATE automation_rules SET autonomy = 'off' WHERE id = ${r6}`;
  }

  const r7 = await custom("Deal parado sin plan", { kind: "deal_idle", days: 5 }, { kind: "notify", message: "{deal} lleva días sin movimiento" }, "ask");
  // En una fase que no pide sesión (si no, otra regla le crearía antes la tarea de agendarla).
  const [free] = await sql`SELECT id, pipeline_id FROM stages WHERE required_activity_type IS NULL AND is_active ORDER BY position LIMIT 1`;
  const [idle] = await sql`INSERT INTO deals (title, pipeline_id, stage_id, created_at, stage_entered_at)
                           VALUES ('Deal olvidado', ${free.pipeline_id}, ${free.id}, now() - interval '10 days', now() - interval '10 days') RETURNING id`;
  await run();
  const a7 = (await actionsOf(r7)).filter((x) => x.title === "Deal olvidado lleva días sin movimiento");
  check(a7.length === 1 && a7[0].status === "pending", "regla general: deal sin movimiento ni nada programado → pide una decisión", JSON.stringify(a7));
  await sql`INSERT INTO activities (type, subject, deal_id, due_at) VALUES ('call', 'Llamar', ${idle.id}, now() + interval '1 day')`;
  await run();
  const a7b = (await actionsOf(r7)).filter((x) => x.title === "Deal olvidado lleva días sin movimiento");
  check(a7b[0]?.status === "expired", "regla general: al programar algo, la propuesta caduca", a7b[0]?.status);
  await sql`UPDATE automation_rules SET autonomy = 'off' WHERE id IN (${r5}, ${r7})`;

  const conf = await (await get("/settings/automations")).text();
  check(conf.includes("Tus reglas") && conf.includes("Tras el kick-off") && conf.includes("Nueva regla"), "/settings/automations muestra las reglas personalizadas");
}

// ------------------------------------------------------------- Importación desde Pipedrive (simulado)
if (process.env.MOCK_URL && process.env.TOKEN_ENCRYPTION_KEY) {
  const MOCK = process.env.MOCK_URL;
  const SECRET = process.env.CRON_SECRET ?? "";
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  const enc = (plain) => {
    const key = createHash("sha256").update(process.env.TOKEN_ENCRYPTION_KEY ?? "").digest();
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  };
  const finish = async (id) => {
    for (let i = 0; i < 10; i++) {
      const [j] = await sql`SELECT status FROM import_jobs WHERE id = ${id}`;
      if (j.status !== "running") return j.status;
      await run();
    }
    return "timeout";
  };
  await sql`UPDATE app_settings SET pipedrive_token = ${enc("token-pipedrive-de-pruebas-0123456789")}, pipedrive_company = 'Aikit (simulado)'`;
  await sql`UPDATE automation_settings SET paused = false`;
  const [job] = await sql`INSERT INTO import_jobs (step, options) VALUES ('users', ${sql.json({ flow: true, files: true, since: null })}) RETURNING id`;
  const st = await finish(job.id);
  const [done] = await sql`SELECT * FROM import_jobs WHERE id = ${job.id}`;
  check(st === "done", "importación de Pipedrive: termina", `${st} ${done.error ?? ""} ${done.step}`);

  const [pl] = await sql`SELECT id FROM pipelines WHERE name = 'Ventas PD'`;
  const stages = pl ? await sql`SELECT name, position, rotten_after_days, win_probability FROM stages WHERE pipeline_id = ${pl.id} ORDER BY position` : [];
  check(stages.map((x) => x.name).join(",") === "Cualificado,Demo hecha,Propuesta" && stages[0].rotten_after_days === 7 && stages[1].rotten_after_days === null && stages[2].win_probability === 70,
        "Pipedrive: pipeline y fases en orden, con días para «parado» y probabilidad", JSON.stringify(stages));
  const [{ n: pdUsers }] = await sql`SELECT count(*)::int AS n FROM users WHERE pipedrive_id IS NOT NULL`;
  check(pdUsers === 2, "Pipedrive: usuarios", String(pdUsers));
  const defs = await sql`SELECT entity_type, label, field_type, options FROM custom_field_definitions WHERE pipedrive_key IS NOT NULL ORDER BY label`;
  check(defs.some((d) => d.label === "Tamaño" && d.field_type === "single_option" && d.options.length === 2)
        && defs.some((d) => d.label === "Presupuesto aprobado" && d.field_type === "money")
        && defs.some((d) => d.label === "Intereses" && d.entity_type === "organization" && d.field_type === "multi_option")
        && !defs.some((d) => d.label === "Personas") && done.warnings.some((w) => w.includes("Personas")),
        "Pipedrive: campos personalizados (los no compatibles, con aviso)", JSON.stringify(defs.map((d) => d.label)));

  const [acme] = await sql`SELECT id, city, custom FROM organizations WHERE pipedrive_id = 201`;
  const intereses = Object.values(acme?.custom ?? {}).find(Array.isArray);
  check(acme?.city === "Madrid" && intereses?.join() === "pd_7,pd_8", "Pipedrive: empresas con dirección y campos", JSON.stringify(acme));
  const [pedro] = await sql`SELECT p.id, p.full_name, (SELECT email FROM person_emails WHERE person_id = p.id) AS email,
                                   (SELECT phone FROM person_phones WHERE person_id = p.id) AS phone,
                                   (SELECT o.name FROM person_organizations po JOIN organizations o ON o.id = po.organization_id WHERE po.person_id = p.id AND po.status = 'current') AS org
                            FROM persons p WHERE p.pipedrive_id = 301`;
  check(pedro?.full_name === "Pedro Pérez" && pedro.email === "pedro@acme-pd.example" && pedro.phone === "+34 600 000 001" && pedro.org === "Acme PD",
        "Pipedrive: contactos con email, teléfono y empresa", JSON.stringify(pedro));
  const [ana2] = await sql`SELECT (SELECT count(*)::int FROM person_emails WHERE person_id = p.id) AS emails FROM persons p WHERE p.pipedrive_id = 303`;
  check(ana2?.emails === 0 && done.warnings.some((w) => w.includes("ana@paco.example")), "Pipedrive: un email que ya existe no se duplica (con aviso)");

  const deals = await sql`SELECT d.pipedrive_id::int AS pd, d.title, d.status, d.value::float AS value, s.name AS stage, d.won_at, lr.label AS reason, d.custom,
                                 (SELECT p.full_name FROM deal_participants dp JOIN persons p ON p.id = dp.person_id WHERE dp.deal_id = d.id AND dp.is_primary) AS contact
                          FROM deals d JOIN stages s ON s.id = d.stage_id LEFT JOIN lost_reasons lr ON lr.id = d.lost_reason_id
                          WHERE d.pipedrive_id IS NOT NULL ORDER BY d.pipedrive_id`;
  const d401 = deals.find((d) => d.pd === 401), d402 = deals.find((d) => d.pd === 402), d403 = deals.find((d) => d.pd === 403);
  check(deals.length === 3 && d401?.stage === "Propuesta" && d401.value === 12000 && d401.contact === "Pedro Pérez"
        && Object.values(d401.custom).includes("pd_2") && Object.values(d401.custom).includes(15000)
        && d402?.status === "won" && new Date(d402.won_at).toISOString().startsWith("2026-05-01") && d403?.reason === "Precio demasiado alto",
        "Pipedrive: deals con fase, importe, contacto, estado, motivo de pérdida y campos", JSON.stringify(deals.map((d) => [d.pd, d.stage, d.status])));
  const hist = await sql`SELECT s.name FROM deal_stage_history h JOIN stages s ON s.id = h.to_stage_id JOIN deals d ON d.id = h.deal_id
                         WHERE d.pipedrive_id = 401 ORDER BY h.changed_at`;
  check(hist.map((h) => h.name).join(" → ") === "Cualificado → Demo hecha → Propuesta", "Pipedrive: recorrido del deal por las fases", hist.map((h) => h.name).join(" → "));

  const acts = await sql`SELECT pipedrive_id::int AS pd, type, done, note, due_at, lead_id FROM activities WHERE pipedrive_id IS NOT NULL ORDER BY pipedrive_id`;
  const a501 = acts.find((a) => a.pd === 501), a502 = acts.find((a) => a.pd === 502), a503 = acts.find((a) => a.pd === 503), a505 = acts.find((a) => a.pd === 505);
  check(acts.length === 4 && a501?.done && a501.note === "Interesados en 40 licencias" && new Date(a501.due_at).toISOString() === "2026-06-02T09:30:00.000Z"
        && a502?.type === "kickoff_call" && a503?.type === "meeting" && a505?.lead_id,
        "Pipedrive: actividades (tipos propios, sin hora, de leads; las sueltas se omiten)", JSON.stringify(acts.map((a) => [a.pd, a.type])));
  const notesPd = await sql`SELECT pipedrive_id::int AS pd, content FROM notes WHERE pipedrive_id IS NOT NULL ORDER BY pipedrive_id`;
  check(notesPd.length === 2 && notesPd[0].content === "Primera reunión: buena sintonía.\nPiden descuento & plazos", "Pipedrive: notas pasadas a texto", JSON.stringify(notesPd));
  const [doc] = await sql`SELECT title, url FROM deal_documents WHERE external_id = 'pd:701'`;
  check(doc?.title === "Propuesta Acme.pdf", "Pipedrive: archivos como documentos del deal");
  const [{ n: pdLeads }] = await sql`SELECT count(*)::int AS n FROM leads WHERE pipedrive_id IS NOT NULL`;
  check(pdLeads === 1, "Pipedrive: leads (los que no tienen contacto ni empresa se omiten)", String(pdLeads));
  const lost = done.verify.find((v) => v.label === "Deals perdidos");
  check(lost?.pipedrive === 2 && lost.crm === 1 && done.verify.find((v) => v.label === "Deals abiertos")?.crm === 1,
        "Pipedrive: la comprobación final detecta lo que no cuadra", JSON.stringify(done.verify));

  // Repetir: sin duplicados.
  const [job2] = await sql`INSERT INTO import_jobs (step, options) VALUES ('users', ${sql.json({ flow: true, files: true, since: null })}) RETURNING id`;
  await finish(job2.id);
  const [{ n: d2 }] = await sql`SELECT count(*)::int AS n FROM deals WHERE pipedrive_id IS NOT NULL`;
  const [{ n: p2 }] = await sql`SELECT count(*)::int AS n FROM persons WHERE pipedrive_id IS NOT NULL`;
  const [{ n: a2 }] = await sql`SELECT count(*)::int AS n FROM activities WHERE pipedrive_id IS NOT NULL`;
  const [{ n: h2 }] = await sql`SELECT count(*)::int AS n FROM deal_stage_history h JOIN deals d ON d.id = h.deal_id WHERE d.pipedrive_id = 401`;
  check(d2 === 3 && p2 === 4 && a2 === 4 && h2 === 3, "Pipedrive: volver a importar no duplica nada", JSON.stringify({ d2, p2, a2, h2 }));

  // Incremental: solo lo cambiado desde la vez anterior.
  const before = new Date(Date.now() - 1000).toISOString();
  await fetch(`${MOCK}/__pd_touch`);
  const [job3] = await sql`INSERT INTO import_jobs (step, options) VALUES ('users', ${sql.json({ flow: false, files: false, since: before })}) RETURNING id`;
  await finish(job3.id);
  const [j3] = await sql`SELECT counts FROM import_jobs WHERE id = ${job3.id}`;
  const [acmeDeal] = await sql`SELECT title, value::float AS value FROM deals WHERE pipedrive_id = 401`;
  check(acmeDeal.title === "Acme — licencias (ampliado)" && acmeDeal.value === 18000 && j3.counts.deals?.updated === 1 && !j3.counts.persons,
        "Pipedrive: la sincronización trae solo lo cambiado", JSON.stringify({ acmeDeal, counts: j3.counts }));

  const pageHtml = await (await get("/settings/import")).text();
  check(pageHtml.includes("Conectado a Aikit (simulado)") && pageHtml.includes("No cuadra") && pageHtml.includes("<h2>Resultado"),
        "/settings/import muestra la conexión, el resultado y la comprobación");
  await sql`UPDATE automation_settings SET paused = false`;
}

// ------------------------------------------------------------- Puntuación y reparto
if (KEY) {
  const CS_ID = "00000000-0000-0000-0000-000000000003";
  await sql`DELETE FROM assignment_rules`;
  await sql`INSERT INTO assignment_rules (position, entity, field, value, user_ids) VALUES
              (1, 'both', 'source', 'webinar-e2e', ${[MEMBER_ID, CS_ID]}::uuid[]),
              (2, 'both', 'any', NULL, ${[ADMIN_ID]}::uuid[])`;
  await sql`UPDATE app_settings SET assignment_enabled = true, assignment_since = now() - interval '1 second'`;
  const stamp = Date.now();
  const r1 = await (await api({ email: `uno.${stamp}@empresa-e2e.example`, full_name: "Uno E2E", source: "webinar-e2e", job_title: "CEO", company: `Empresa E2E ${stamp}` })).json();
  const r2 = await (await api({ email: `dos.${stamp}@empresa-e2e.example`, full_name: "Dos E2E", source: "Webinar-E2E de octubre" })).json();
  const r3 = await (await api({ email: `tres.${stamp}@gmail.com`, full_name: "Tres E2E", source: "ebook", intent: "demo_request" })).json();
  const owners = await sql`SELECT id, owner_id, score, score_reasons FROM leads WHERE id IN (${r1.lead_id}, ${r2.lead_id}, ${r3.lead_id})`;
  const by = (id) => owners.find((o) => o.id === id);
  // (La solicitud de demo convierte el lead en deal: lo que se asigna es el deal.)
  check(by(r1.lead_id)?.owner_id === MEMBER_ID && by(r2.lead_id)?.owner_id === CS_ID,
        "reparto: por origen y por turnos; lo demás, a la regla general", JSON.stringify(owners.map((o) => o.owner_id)));
  const [d3] = await sql`SELECT owner_id FROM deals WHERE id = ${r3.deal_id}`;
  check(d3?.owner_id === ADMIN_ID, "reparto: el deal de una solicitud de demo también se asigna", JSON.stringify(d3));
  const s1 = by(r1.lead_id), s3 = by(r3.lead_id);
  check(s1?.score >= 25 && s1.score_reasons.some((x) => x.label.startsWith("Cargo con capacidad de decisión")) && s3?.score >= 50
        && s3.score_reasons.some((x) => x.label === "Ha pedido una demo o reunión"),
        "puntuación: el cargo y la petición de demo suben la nota, con sus motivos", JSON.stringify({ s1: s1?.score, s3: s3?.score }));
  const leadsHtml = await (await get("/leads?status=all&sort=score&temp=warm")).text();
  check(leadsHtml.includes("Puntuación") && leadsHtml.includes("Tres E2E"), "leads: ordenar y filtrar por puntuación");
  const leadPage = await (await get(`/leads/${r3.lead_id}`)).text();
  check(leadPage.includes("Ha pedido una demo o reunión") && leadPage.includes("/ 100"), "ficha del lead: la puntuación con sus motivos");
  const asg = await (await get("/settings/assignment")).text();
  check(asg.includes("Reparto automático: activado") && asg.includes("webinar-e2e"), "/settings/assignment muestra las reglas");
  const [na] = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${MEMBER_ID} AND kind = 'assigned'`;
  check(na.n >= 1, "avisos: a quien le asignan un lead le llega un aviso", JSON.stringify(na));
  await sql`UPDATE app_settings SET assignment_enabled = false`;
}

// ------------------------------------------------------------- Informes
{
  await sql`DELETE FROM goals`;
  await sql`INSERT INTO goals (user_id, metric, period, target) VALUES (NULL, 'won_value', 'month', 10000), (${ADMIN_ID}, 'activities_done', 'quarter', 20)`;
  const rep = await (await get(`/reports?pipeline=${P.inbound}`)).text();
  check(rep.includes("Previsión ponderada") && rep.includes("Previsión por mes de cierre") && rep.includes("Velocidad de ventas")
        && rep.includes("Equipo · Importe ganado") && rep.includes("Gestor de cuentas · Actividades hechas") && rep.includes("Embudo · Inbound"),
        "informes: previsión, velocidad, objetivos y embudo");
  const [w] = await sql`SELECT coalesce(sum(d.value * coalesce(s.win_probability, 0) / 100.0), 0)::float8 AS v
                        FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.status = 'open' AND d.deleted_at IS NULL AND d.pipeline_id = ${P.inbound}`;
  const shown = new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0, useGrouping: "always" }).format(w.v);
  check(rep.replace(/\u00a0/g, " ").includes(shown.replace(/\u00a0/g, " ")), "informes: el ponderado cuadra con la base de datos", shown);
  const prev = await (await get("/api/analytics/preview", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: { source: "deals", metric: "weighted_value", group_by: "pipeline", date_field: "created_at", period: "all", chart: "bar", filters: {} } }),
  })).json();
  check(prev.result?.kind === "series" && prev.result.points.length > 0, "dashboards: nueva métrica «importe ponderado»", JSON.stringify(prev).slice(0, 120));
}

// ------------------------------------------------------------- Propuestas (página pública)
{
  const tok = "propuesta-e2e-0123456789abc";
  await sql`INSERT INTO proposals (deal_id, token, title, intro, lines, total, valid_until)
            VALUES (${DEAL_OPEN}, ${tok}, 'Propuesta e2e', 'Hola Ana, aquí va.',
                    ${sql.json([{ name: "Licencia", billing: "Anual", quantity: 2, unit_price: 1000, discount_pct: 10, subtotal: 1800 }])}, 1800,
                    (now() + interval '10 days')::date)`;
  const pp = await fetch(`${BASE}/p/${tok}`, { headers: { "user-agent": UA_IPHONE } });
  const ph = (await pp.text()).replace(/<!-- -->/g, "");
  const [pv] = await sql`SELECT view_count, status FROM proposals WHERE token = ${tok}`;
  const [pe] = await sql`SELECT count(*)::int AS n FROM events WHERE event_type = 'proposal.viewed' AND entity_id = ${DEAL_OPEN}`;
  check(pp.status === 200 && ph.includes("Propuesta e2e") && ph.includes("Aceptar la propuesta") && ph.includes("1.800")
        && pv.view_count === 1 && pv.status === "sent" && pe.n >= 1,
        "propuesta: el cliente la abre sin sesión, se cuenta y avisa en el deal", JSON.stringify({ st: pp.status, pv, pe }));
  check((await fetch(`${BASE}/p/no-existe-0123456789abcdef`)).status === 404, "propuesta: un enlace inventado → 404");
  const prod = await (await get("/settings/products")).text();
  check(prod.includes("Productos") && prod.includes("Nuevo producto"), "/settings/products");
}

// ------------------------------------------------------------- Fase 1: lectura de correos y salud de los deals
{
  const SECRET = process.env.CRON_SECRET ?? "";
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  await sql`UPDATE app_settings SET open_alerts = 'all'`;
  const tok = "lectura-e2e-0123456789abcdefgh";
  const [m] = await sql`INSERT INTO emails (direction, status, deal_id, person_id, user_id, to_email, to_name, subject, body, track, token, sent_at)
                        VALUES ('out', 'sent', ${DEAL_OPEN}, NULL, ${ADMIN_ID}, 'marta@lectura.example', 'Marta Ruiz', 'Propuesta revisada e2e',
                                'Hola Ana, aquí va: https://aikit.example/p', true, ${tok}, now() - interval '2 days') RETURNING id`;
  const before = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${ADMIN_ID} AND kind = 'email.opened'`;
  await fetch(`${BASE}/t/o/${tok}.gif`, { headers: { "user-agent": UA_IPHONE, "x-vercel-ip-city": "Madrid", "x-vercel-ip-country": "ES", "x-forwarded-for": "203.0.113.5" } });
  const [o1] = await sql`SELECT device, client, place, automatic FROM email_opens WHERE email_id = ${m.id}`;
  const [n1] = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${ADMIN_ID} AND kind = 'email.opened'`;
  check(o1?.device === "mobile" && o1.client === "Apple Mail" && o1.place === "Madrid, ES" && !o1.automatic && n1.n === before[0].n + 1,
        "lectura: cada apertura queda registrada (dispositivo, programa, lugar) y avisa a quien lo envió", JSON.stringify({ o1, n1 }));
  await fetch(`${BASE}/t/o/${tok}.gif`, { headers: { "user-agent": "Mozilla/5.0" } });
  await fetch(`${BASE}/t/o/${tok}.gif`, { headers: { "user-agent": "Barracuda Sentinel (EE)" } });
  const [c2] = await sql`SELECT open_count, (SELECT count(*)::int FROM email_opens WHERE email_id = ${m.id} AND automatic) AS auto FROM emails WHERE id = ${m.id}`;
  check(c2.open_count === 1 && c2.auto === 2, "lectura: la precarga de Apple Mail y los escáneres se guardan como automáticas y no cuentan", JSON.stringify(c2));
  // Vuelve a abrirlo al día siguiente desde el ordenador.
  await sql`UPDATE emails SET last_opened_at = now() - interval '1 day', open_alert_at = now() - interval '1 day' WHERE id = ${m.id}`;
  await sql`UPDATE email_opens SET at = at - interval '1 day' WHERE email_id = ${m.id}`;
  await fetch(`${BASE}/t/o/${tok}.gif`, { headers: { "user-agent": UA_DESKTOP, "x-forwarded-for": "198.51.100.7" } });
  const [c3] = await sql`SELECT open_count FROM emails WHERE id = ${m.id}`;
  const [re] = await sql`SELECT count(*)::int AS n FROM events WHERE event_type = 'email.reopened' AND payload->>'email_id' = ${m.id}`;
  const [rn] = await sql`SELECT title FROM notifications WHERE user_id = ${ADMIN_ID} AND kind = 'email.reopened' ORDER BY created_at DESC LIMIT 1`;
  check(c3.open_count === 2 && re.n === 1 && rn?.title.includes("ha vuelto a abrir") && rn.title.includes("2.ª vez"),
        "lectura: volver a abrirlo otro día queda en la historia y avisa («2.ª vez»)", JSON.stringify({ c3, re, rn }));
  // Clic con las imágenes bloqueadas: cuenta como apertura.
  const tok2 = "lectura-e2e-sin-imagenes-01234";
  const [m2] = await sql`INSERT INTO emails (direction, status, deal_id, person_id, user_id, to_email, subject, body, track, token, sent_at)
                         VALUES ('out', 'sent', ${DEAL_OPEN}, ${PERSON}, ${ADMIN_ID}, 'ana@paco.example', 'Sin imágenes e2e', 'Mira https://aikit.example/x',
                                 true, ${tok2}, now() - interval '1 hour') RETURNING id`;
  const cl = await fetch(`${BASE}/t/c/${tok2}?u=${encodeURIComponent("https://aikit.example/x")}`, { redirect: "manual", headers: { "user-agent": UA_DESKTOP } });
  const [c4] = await sql`SELECT open_count, click_count FROM emails WHERE id = ${m2.id}`;
  check(cl.status === 302 && c4.open_count === 1 && c4.click_count === 1, "lectura: un clic sin apertura registrada cuenta también como apertura", JSON.stringify(c4));
  // Bandeja de enviados y detalle.
  const sent = await (await get("/emails?who=all&f=opened_no_reply")).text();
  check(sent.includes("Correos enviados") && sent.includes("Propuesta revisada e2e") && sent.includes("Abiertos sin responder"),
        "/emails: bandeja de enviados con filtro «abiertos sin responder»");
  const unopened = await (await get("/emails?who=all&f=unopened")).text();
  check(!unopened.includes("Propuesta revisada e2e"), "/emails: el filtro «sin abrir» deja fuera los abiertos");
  const det = await (await get(`/emails/${m.id}`)).text();
  check(det.includes("2 veces</strong>") && det.includes("en 2 días distintos") && det.includes("Madrid, ES") && det.includes("Móvil")
        && det.includes("Automática") && det.includes("Apple Mail"), "/emails/[id]: cada apertura con fecha, dispositivo, programa y lugar", det.slice(0, 0));
  const dealPage = await (await get(`/deals/${DEAL_OPEN}`)).text();
  check(dealPage.includes("Aperturas") && dealPage.includes("Ver el detalle completo"), "ficha del deal: el correo muestra su lista de aperturas");
  const bell = await (await get("/notifications")).text();
  check(bell.includes("ha abierto «Propuesta revisada e2e»"), "avisos: «ha abierto tu correo» en la campana");
  // Ajustes: solo cuando lo vuelven a abrir.
  await sql`UPDATE app_settings SET open_alerts = 'reopen'`;
  const tok3 = "lectura-e2e-solo-reaperturas-01";
  await sql`INSERT INTO emails (direction, status, deal_id, user_id, to_email, subject, body, track, token, sent_at)
            VALUES ('out', 'sent', ${DEAL_OPEN}, ${ADMIN_ID}, 'ana@paco.example', 'Solo reaperturas e2e', 'Hola', true, ${tok3}, now() - interval '1 hour')`;
  await fetch(`${BASE}/t/o/${tok3}.gif`, { headers: { "user-agent": UA_DESKTOP } });
  const [n3] = await sql`SELECT count(*)::int AS n FROM notifications WHERE title LIKE '%Solo reaperturas e2e%'`;
  check(n3.n === 0, "ajustes: con «solo reaperturas», la primera apertura no avisa");
  await sql`UPDATE app_settings SET open_alerts = 'all'`;
  const sig = await (await get("/settings/signals")).text();
  check(sig.includes("Señales y avisos") && sig.includes("Competidores"), "/settings/signals");

  // Propuesta: el equipo con sesión no suma visitas; el cliente sí, con su registro.
  const ptok = "propuesta-lectura-e2e-012345";
  await sql`INSERT INTO proposals (deal_id, token, title, intro, lines, total, valid_until)
            VALUES (${DEAL_OPEN}, ${ptok}, 'Propuesta lectura e2e', 'Hola', '[]', 100, (now() + interval '10 days')::date)`;
  await get(`/p/${ptok}`);
  await fetch(`${BASE}/p/${ptok}`, { headers: { "user-agent": UA_IPHONE, "cf-ipcity": "Valencia", "cf-ipcountry": "ES" } });
  const [pv] = await sql`SELECT p.view_count, (SELECT count(*)::int FROM proposal_views v WHERE v.proposal_id = p.id) AS log,
                                (SELECT place FROM proposal_views v WHERE v.proposal_id = p.id LIMIT 1) AS place FROM proposals p WHERE token = ${ptok}`;
  check(pv.view_count === 1 && pv.log === 1 && pv.place === "Valencia, ES", "propuesta: las visitas del equipo no cuentan; las del cliente, con su registro", JSON.stringify(pv));
  await sql`UPDATE proposals SET last_viewed_at = now() - interval '2 days' WHERE token = ${ptok}`;
  await sql`UPDATE proposal_views SET at = at - interval '2 days' WHERE proposal_id = (SELECT id FROM proposals WHERE token = ${ptok})`;
  await fetch(`${BASE}/p/${ptok}`, { headers: { "user-agent": UA_DESKTOP } });
  const [rv] = await sql`SELECT count(*)::int AS n FROM events WHERE event_type = 'proposal.reviewed' AND payload->>'title' = 'Propuesta lectura e2e'`;
  check(rv.n === 1, "propuesta: volver a abrirla otro día queda en la historia (y avisa al responsable)");

  // Salud de los deals.
  await sql`UPDATE app_settings SET competitors = ARRAY['Acme CRM']`;
  await sql`INSERT INTO notes (deal_id, content) VALUES (${DEAL_OPEN}, 'Nos dicen que Acme CRM les sale más barato.')`;
  const RED_DEAL = "90000000-0000-0000-0000-0000000000e1";
  await sql`INSERT INTO deals (id, title, pipeline_id, stage_id, stage_entered_at, expected_close_date, value)
            VALUES (${RED_DEAL}, 'Deal en apuros e2e', ${P.inbound}, '20000000-0000-0000-0000-000000000011', now() - interval '20 days',
                    current_date - 5, 5000) ON CONFLICT (id) DO NOTHING`;
  await run();
  const [h] = await sql`SELECT score, signals FROM deal_health WHERE deal_id = ${DEAL_OPEN}`;
  const keys = (h?.signals ?? []).map((x) => x.key);
  check(h && h.score >= 0 && h.score <= 100 && keys.includes("competition") && (h.signals.find((x) => x.key === "competition")?.label ?? "").includes("acme crm"),
        "salud: se calcula para cada deal abierto con sus señales (competidor en una nota)", JSON.stringify(h).slice(0, 300));
  const [r1] = await sql`SELECT score, red_since FROM deal_health WHERE deal_id = ${RED_DEAL}`;
  check(r1 && r1.score < 40, "salud: un deal parado, sin contactos y con el cierre pasado sale en rojo", JSON.stringify(r1));
  // Al pasar de verde a rojo: historia y aviso (la primera vez que se calcula no avisa).
  await sql`UPDATE deals SET owner_id = ${ADMIN_ID} WHERE id = ${RED_DEAL}`;
  await sql`UPDATE deal_health SET score = 80, red_since = NULL WHERE deal_id = ${RED_DEAL}`;
  await run();
  const [hr] = await sql`SELECT count(*)::int AS n FROM events WHERE event_type = 'deal.health_red' AND entity_id = ${RED_DEAL}`;
  const [hn] = await sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'health' AND link = ${`/deals/${RED_DEAL}`}`;
  await run();
  const [hn2] = await sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'health' AND link = ${`/deals/${RED_DEAL}`}`;
  check(hr.n === 1 && hn.n === 1 && hn2.n === 1, "salud: al entrar en rojo se avisa al responsable una sola vez", JSON.stringify({ hr, hn, hn2 }));
  const dp = await (await get(`/deals/${RED_DEAL}`)).text();
  check(dp.includes("Señales") && dp.includes("Riesgos") && dp.includes("Sin ningún contacto") && dp.includes("En riesgo"),
        "ficha: la salud y sus señales a la vista");
  const board = await (await get(`/pipelines/${P.inbound}?sort=health`)).text();
  check(board.includes("health health-bad") && board.includes("Deal en apuros e2e"), "tablero: cada tarjeta con su salud (y orden «peor primero»)");
  const list = await (await get(`/pipelines/${P.inbound}?view=list&flag=at_risk`)).text();
  check(list.includes("Deal en apuros e2e") && list.includes(">Salud</a>"), "lista: columna «Salud» y filtro «En riesgo»");
  // Parte del día: cambios desde ayer y abiertos sin responder.
  await sql`INSERT INTO deal_health_daily (deal_id, day, score) VALUES (${RED_DEAL}, current_date - 1, 90)
            ON CONFLICT (deal_id, day) DO UPDATE SET score = 90`;
  const today = await (await get("/")).text();
  check(today.includes("Señales") && today.includes("Deal en apuros e2e") && today.includes("Abiertos sin responder"),
        "hoy: deals que empeoran desde ayer y correos abiertos sin responder");
  await sql`DELETE FROM deals WHERE id = ${RED_DEAL}`;
  await sql`UPDATE app_settings SET competitors = '{}'`;
}

// ------------------------------------------------------------- Fase 2: agente ejecutivo de deal
{
  const SECRET = process.env.CRON_SECRET ?? "";
  const MOCK = process.env.MOCK_URL;
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  const enc = (plain) => {
    const key = createHash("sha256").update(process.env.TOKEN_ENCRYPTION_KEY ?? "").digest();
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  };
  const pending = async (key, dealId) => (await sql`SELECT x.* FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
                                                     WHERE r.key = ${key} AND x.deal_id = ${dealId} ORDER BY x.created_at DESC LIMIT 1`)[0];
  // Un deal nuevo para estas pruebas, con su contacto.
  const D2 = "90000000-0000-0000-0000-0000000000f2";
  await sql`INSERT INTO deals (id, title, pipeline_id, stage_id, owner_id, organization_id, value, created_at)
            VALUES (${D2}, 'Agente ejecutivo e2e', ${P.inbound}, '20000000-0000-0000-0000-000000000011', ${ADMIN_ID}, ${ORG}, 12000, now() - interval '20 days')
            ON CONFLICT (id) DO NOTHING`;
  await sql`INSERT INTO deal_participants (deal_id, person_id, is_primary) VALUES (${D2}, ${PERSON}, true) ON CONFLICT DO NOTHING`;

  if (MOCK && process.env.TOKEN_ENCRYPTION_KEY) {
    await sql`UPDATE ai_settings SET provider = 'anthropic', base_url = ${`${MOCK}/llm/anthropic`}, model = 'modelo-de-pruebas',
                     api_key = ${enc("clave-llm-de-pruebas")}, last_error = NULL`;
    // Reunión hecha con transcripción → «lo que sabemos», tareas con los próximos pasos y cambio de importe y fecha.
    const [act] = await sql`INSERT INTO activities (type, subject, due_at, done, done_at, outcome, deal_id, person_id, owner_id, transcript)
                            VALUES ('video_call', 'Demo con Ana e2e', now() - interval '2 hours', true, now() - interval '1 hour', 'held', ${D2}, ${PERSON}, ${ADMIN_ID},
                                    'Ana: necesitamos automatizar la captación. Luis, el director financiero, decide. Presupuesto unos 30.000 al año, queremos arrancar en enero.')
                            RETURNING id`;
    await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type, payload)
              VALUES ('deal', ${D2}, 'activity.completed', 'user', ${sql.json({ activity_id: act.id, outcome: "held" })})`;
    await run();
    const [ins] = await sql`SELECT needs, decision_makers, budget, timeline, objections, competitors FROM deal_insights WHERE deal_id = ${D2}`;
    check(ins?.needs.includes("(IA) Automatizar la captación") && ins.decision_makers[0]?.nombre === "Luis Martín" && ins.budget.includes("30.000")
          && ins.competitors.includes("(IA) Acme CRM"), "tras la reunión: necesidades, decisores, presupuesto, plazos y competidores en el deal", JSON.stringify(ins));
    const steps = await pending("call_next_steps", D2);
    check(steps?.status === "pending" && steps.payload.note.includes("(IA) Enviar la propuesta revisada") && steps.payload.note.includes("(IA) Agendar la demo técnica")
          && steps.payload.due_in_days === 2, "tras la reunión: propone las tareas con los próximos pasos", JSON.stringify(steps?.payload));
    const upd = await pending("call_deal_update", D2);
    check(upd?.status === "pending" && upd.payload.changes.value === 30000 && upd.payload.changes.expected_close_date === "2027-01-15",
          "tras la reunión: propone actualizar importe y fecha de cierre", JSON.stringify(upd?.payload));
    const page = await (await get(`/deals/${D2}`)).text();
    check(page.includes("Lo que sabemos") && page.includes("Luis Martín, Director Financiero") && page.includes("(IA) Unos 30.000 € al año"),
          "ficha: «lo que sabemos» del deal");

    // Preparación de la reunión de dentro de 50 minutos, con aviso.
    const [soon] = await sql`INSERT INTO activities (type, subject, due_at, deal_id, person_id, owner_id)
                             VALUES ('demo', 'Demo técnica e2e', now() + interval '50 minutes', ${D2}, ${PERSON}, ${ADMIN_ID}) RETURNING id`;
    await run();
    const [prep] = await sql`SELECT prep, prep_notified_at FROM activities WHERE id = ${soon.id}`;
    const [pn] = await sql`SELECT title, link FROM notifications WHERE kind = 'meeting_prep' AND link = ${`/deals/${D2}#act-${soon.id}`}`;
    check(prep?.prep?.includes("Objetivo: (IA) Cerrar fecha de la demo técnica") && prep.prep.includes("Quién viene:") && prep.prep.includes("Ana García")
          && prep.prep.includes("(IA) ¿Quién firma el contrato?") && prep.prep_notified_at && pn?.title.includes("Demo técnica e2e"),
          "reuniones: ficha de preparación (IA) y aviso antes de empezar", JSON.stringify({ prep, pn }));
    const page2 = await (await get(`/deals/${D2}`)).text();
    check(page2.includes("Ficha de preparación") && page2.includes(`id="act-${soon.id}"`), "ficha: la preparación, en la reunión pendiente");
    await sql`UPDATE ai_settings SET api_key = ${enc("clave-mala")}`;
    // Sin IA: la ficha se prepara con los datos del CRM.
    const [later] = await sql`INSERT INTO activities (type, subject, due_at, deal_id, person_id, owner_id)
                              VALUES ('call', 'Llamada de seguimiento e2e', now() + interval '20 hours', ${D2}, ${PERSON}, ${ADMIN_ID}) RETURNING id`;
    await run();
    const [prep2] = await sql`SELECT prep, prep_notified_at FROM activities WHERE id = ${later.id}`;
    check(prep2?.prep?.startsWith("Objetivo: avanzar") && prep2.prep.includes("Presupuesto: (IA) Unos 30.000") && !prep2.prep_notified_at,
          "reuniones: sin IA, ficha con los datos del CRM (y sin aviso hasta que falte poco)", prep2?.prep?.slice(0, 200));
  }

  // Fecha de cierre pasada → propone una nueva; un solo contacto → a quién implicar.
  await sql`UPDATE deals SET expected_close_date = current_date - 3 WHERE id = ${D2}`;
  await run();
  const cd = await pending("close_date_past", D2);
  check(cd?.status === "pending" && cd.payload.changes.expected_close_date > new Date().toISOString().slice(0, 10), "fecha de cierre pasada: propone una realista", JSON.stringify(cd?.payload));
  const mt = await pending("multithread", D2);
  check(mt?.status === "pending" && /Implicar a|Identificar al decisor/.test(mt.title), "un solo contacto: propone a quién más implicar", mt?.title);
  // El cliente abre la propuesta con el deal en una fase anterior → propone «Propuesta enviada».
  await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type, payload)
            VALUES ('deal', ${D2}, 'proposal.viewed', 'integration', ${sql.json({ proposal_id: "00000000-0000-0000-0000-00000000abcd" })})`;
  await run();
  const ps = await pending("proposal_stage", D2);
  check(ps?.status === "pending" && ps.payload.stage_name === "Propuesta enviada", "propuesta abierta: propone mover el deal a «Propuesta enviada»", JSON.stringify(ps?.payload));

  // Plan de cierre: un paso vencido baja la salud; compartido, el cliente lo ve.
  const ptok = "plan-de-cierre-e2e-0123456789";
  await sql`INSERT INTO close_plans (deal_id, token, shared) VALUES (${D2}, ${ptok}, false) ON CONFLICT (deal_id) DO NOTHING`;
  await sql`INSERT INTO close_plan_steps (deal_id, position, title, side, due_date, done, done_at) VALUES
            (${D2}, 1, 'Validación de seguridad e2e', 'client', current_date - 2, false, NULL),
            (${D2}, 2, 'Firma del contrato e2e', 'client', current_date + 20, false, NULL),
            (${D2}, 3, 'Demo técnica hecha e2e', 'both', current_date - 5, true, now())`;
  check((await fetch(`${BASE}/cp/${ptok}`)).status === 404, "plan de cierre: sin compartir, el enlace no funciona");
  await sql`UPDATE close_plans SET shared = true WHERE deal_id = ${D2}`;
  const cp = await fetch(`${BASE}/cp/${ptok}`);
  const cph = (await cp.text()).replace(/<!-- -->/g, "");
  check(cp.status === 200 && cph.includes("Plan de trabajo conjunto") && cph.includes("Firma del contrato e2e") && cph.includes("1 de 3 pasos hechos"),
        "plan de cierre: compartido, el cliente lo ve sin iniciar sesión");
  await run();
  const [hp] = await sql`SELECT signals FROM deal_health WHERE deal_id = ${D2}`;
  check(hp?.signals.some((x) => x.key === "plan_overdue"), "salud: un paso del plan de cierre vencido es un riesgo");
  const dp = await (await get(`/deals/${D2}`)).text();
  check(dp.includes("Plan de cierre") && dp.includes("Validación de seguridad e2e") && dp.includes("Dejar de compartir"), "ficha: plan de cierre con sus pasos");

  // Descuento por encima del límite: espera aprobación y bloquea la propuesta.
  const [prod] = await sql`SELECT id FROM products WHERE is_active LIMIT 1`;
  if (prod) {
    await sql`UPDATE app_settings SET max_discount_pct = 10`;
    await sql`INSERT INTO deal_products (deal_id, product_id, quantity, unit_price, discount_pct, discount_status, discount_limit, requested_by)
              VALUES (${D2}, ${prod.id}, 1, 1000, 25, 'pending', 10, ${MEMBER_ID})`;
    const inbox = await (await get("/inbox")).text();
    check(inbox.includes("Descuentos por aprobar") && inbox.includes("Agente ejecutivo e2e") && inbox.includes("Dejar en 10 %"),
          "descuentos: los que superan el límite esperan aprobación en la bandeja");
    const dpp = await (await get(`/deals/${D2}`)).text();
    check(dpp.includes("Pendiente de aprobación"), "descuentos: la línea muestra que está pendiente");
    const sp = await (await get("/settings/products")).text();
    check(sp.includes("Descuento máximo sin aprobación"), "/settings/products: límite de descuento");
    await sql`UPDATE app_settings SET max_discount_pct = NULL`;
  }
  await sql`DELETE FROM deals WHERE id = ${D2}`;
}

// ------------------------------------------------------------- Fase 3: captación y outbound
if (process.env.MOCK_URL && process.env.TOKEN_ENCRYPTION_KEY) {
  const SECRET = process.env.CRON_SECRET ?? "";
  const MOCK = process.env.MOCK_URL;
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  const mock = async (path, method = "GET") => (await fetch(`${MOCK}${path}`, { method })).json();
  const enc = (plain) => {
    const key = createHash("sha256").update(process.env.TOKEN_ENCRYPTION_KEY ?? "").digest();
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
  };
  const [{ owner_id: OWNER }] = await sql`SELECT owner_id FROM deals WHERE id = ${DEAL_OPEN}`;
  const oauth = async (purpose) => {
    const r1 = await get(`/api/integrations/microsoft/connect?user=${OWNER}${purpose ? `&purpose=${purpose}` : ""}`);
    const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
    const r2 = await fetch(r1.headers.get("location"), { redirect: "manual" });
    const r3 = await get(r2.headers.get("location").replace(/^https?:\/\/[^/]+/, ""), { headers: { cookie } });
    return r3.headers.get("location") ?? "";
  };
  await oauth(null);
  await sql`UPDATE ai_settings SET provider = 'anthropic', base_url = ${`${MOCK}/llm/anthropic`}, model = 'modelo-de-pruebas',
                   api_key = ${enc("clave-llm-de-pruebas")}, last_error = NULL`;

  // Sin perfil de cliente ideal: nadie se descarta.
  const lead0 = await api({ email: "rosa@sinperfil-e2e.example", full_name: "Rosa Sin Perfil", company: "Sin Perfil S.L.", source: "web" });
  const l0 = await lead0.json();
  await run();
  const [q0] = await sql`SELECT fit, fit_reason FROM leads WHERE id = ${l0.lead_id}`;
  check(q0?.fit === "unknown" && q0.fit_reason.startsWith("Sin perfil"), "cualificación: sin perfil de cliente ideal no descarta a nadie", JSON.stringify(q0));

  // Con perfil: enriquecimiento desde la web, encaje y atribución UTM.
  await sql`UPDATE icp_profile SET sectors = ARRAY['Software'], countries = ARRAY['España'], min_employees = 50, max_employees = 1000, updated_at = now()`;
  const lead1 = await api({ email: "laura@logistica-e2e.example", full_name: "Laura Logística", company: "Logística E2E", job_title: "Directora comercial",
                            source: "web", utm_source: "linkedin", utm_medium: "cpc", utm_campaign: "otono-e2e" });
  const l1 = await lead1.json();
  await run();
  const [org1] = await sql`SELECT industry, employee_count, country, city, description, enriched_at FROM organizations WHERE id = ${l1.organization_id}`;
  check(org1?.enriched_at && org1.industry === "Software" && org1.employee_count === 120 && org1.country === "España" && org1.description.includes("(IA)"),
        "enriquecimiento: sector, tamaño, país y a qué se dedica desde la web de la empresa", JSON.stringify(org1));
  const [q1] = await sql`SELECT fit, fit_reason, utm, score_reasons FROM leads WHERE id = ${l1.lead_id}`;
  check(q1?.fit === "fit" && q1.fit_reason.includes("Software") && q1.utm.campaign === "otono-e2e" && q1.utm.source === "linkedin",
        "cualificación: encaja con el perfil, con el motivo; y la campaña de origen (UTM) queda en el lead", JSON.stringify(q1));
  await run();
  const [q1b] = await sql`SELECT score_reasons FROM leads WHERE id = ${l1.lead_id}`;
  check(q1b.score_reasons.some((r) => r.label === "Encaja con el perfil de cliente ideal"), "puntuación: el encaje suma", JSON.stringify(q1b.score_reasons));
  const [fr] = await sql`SELECT x.status, x.payload, x.subject_type FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
                         WHERE r.key = 'inbound_first_reply' AND x.subject_id = ${l1.lead_id}`;
  check(fr?.status === "pending" && fr.subject_type === "lead" && fr.payload.to === "laura@logistica-e2e.example" && fr.payload.body.includes("Hola Laura"),
        "captación: propone responder en minutos al lead que encaja", JSON.stringify(fr));
  const inbox = await (await get("/inbox")).text();
  check(inbox.includes("Responder a Laura Logística") && inbox.includes(`/leads/${l1.lead_id}`), "bandeja: la propuesta enlaza al lead");
  const leadPage = await (await get(`/leads/${l1.lead_id}`)).text();
  check(leadPage.includes("Encaje con vuestro perfil") && leadPage.includes("Encaja") && leadPage.includes("campaña: otono-e2e"),
        "ficha del lead: encaje, datos de la empresa y atribución");
  const fitList = await (await get("/leads?fit=fit")).text();
  const noFitList = await (await get("/leads?fit=no_fit")).text();
  check(fitList.includes("Laura Logística") && !noFitList.includes("Laura Logística"), "leads: filtro por encaje");
  // Exclusión: deja de encajar.
  await sql`UPDATE icp_profile SET exclusions = ARRAY['logistica-e2e'], updated_at = now()`;
  await run();
  const [q2] = await sql`SELECT fit, fit_reason FROM leads WHERE id = ${l1.lead_id}`;
  check(q2.fit === "no_fit" && q2.fit_reason.includes("exclusión"), "cualificación: una exclusión descarta (y se recalcula al cambiar el perfil)", JSON.stringify(q2));
  const icpPage = await (await get("/settings/icp")).text();
  check(icpPage.includes("Perfil de cliente ideal") && icpPage.includes("Software"), "/settings/icp");
  const rep = await (await get("/reports")).text();
  check(rep.includes("Atribución") && rep.includes("otono-e2e"), "informes: atribución por canal y campaña");
  await sql`UPDATE icp_profile SET sectors = '{}', countries = '{}', min_employees = NULL, max_employees = NULL, exclusions = '{}', updated_at = now()`;

  // Buzón de outbound (dominio secundario), aparte del principal.
  const loc = await oauth("outbound");
  const conns = await sql`SELECT id, purpose, sync_calendar FROM mailbox_connections WHERE user_id = ${OWNER} ORDER BY purpose`;
  const ob = conns.find((c) => c.purpose === "outbound");
  check(loc.includes("outbound=1") && conns.some((c) => c.purpose === "main") && ob && !ob.sync_calendar,
        "buzones de outbound: se conectan aparte del principal (sin calendario)", JSON.stringify(conns));
  const mbPage = await (await get("/settings/mailbox")).text();
  check(mbPage.includes("Buzones de outbound") && mbPage.includes("hoy 0 de 10"), "ajustes: buzón de outbound con su calentamiento (10 al día el primer día)");

  // Campaña: contactos por la API, verificación y primera línea, aprobación, envío y respuestas.
  const [seq] = await sql`SELECT id FROM sequences WHERE name = 'Seguimiento tras la propuesta'`;
  const [camp] = await sql`INSERT INTO campaigns (name, status, sequence_id, mailbox_ids, owner_id, require_approval, send_days, send_from, send_to, target)
                           VALUES ('Outbound e2e', 'active', ${seq.id}, ${[ob.id]}, ${OWNER}, true, '{1,2,3,4,5,6,7}', 0, 24, ${sql.json({ sector: "Software" })})
                           RETURNING id`;
  const add = await fetch(`${BASE}/api/v1/campaigns/${camp.id}/contacts`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ contacts: [
      { email: "marta@prospecto-e2e.example", full_name: "Marta Prospecto", company: "Prospecto E2E", job_title: "CEO" },
      { email: "pedro@prospecto-e2e.example", full_name: "Pedro Prospecto", company: "Prospecto E2E", job_title: "CTO" },
      { email: "nadie@mailinator.com", full_name: "Temporal" },
      { email: "esto-no-es-un-email" },
    ] }),
  });
  const added = await add.json();
  check(add.status === 201 && added.added === 3 && added.skipped.length === 1, "campañas: contactos por la API (descarta los emails mal escritos)", JSON.stringify(added));
  check((await fetch(`${BASE}/api/v1/campaigns/${camp.id}/contacts`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 401,
        "campañas: la API pide clave");
  await run();
  const cc = await sql`SELECT cc.email, cc.status, cc.personal_line, cc.verify_note FROM campaign_contacts cc WHERE campaign_id = ${camp.id} ORDER BY email`;
  const marta = cc.find((x) => x.email.startsWith("marta"));
  check(marta?.status === "ready" && marta.personal_line?.startsWith("(IA)") && cc.find((x) => x.email.includes("mailinator"))?.status === "invalid",
        "campañas: verificación del email y primera línea personalizada, a la espera de aprobación", JSON.stringify(cc));
  const cpage = await (await get(`/campaigns/${camp.id}`)).text();
  check(cpage.includes("Para aprobar") && cpage.includes("(IA) He visto que estáis ampliando") && cpage.includes("Aprobar todos (2)"), "campañas: lista para aprobar por lotes");
  await sql`UPDATE campaign_contacts SET status = 'approved' WHERE campaign_id = ${camp.id} AND status = 'ready'`;
  const before = (await mock("/__state")).sent.length;
  await run();
  const enrolled = await sql`SELECT cc.email, cc.status, cc.mailbox_id, e.status AS enr FROM campaign_contacts cc LEFT JOIN sequence_enrollments e ON e.id = cc.enrollment_id
                             WHERE cc.campaign_id = ${camp.id} AND cc.status = 'enrolled'`;
  check(enrolled.length === 2 && enrolled.every((x) => x.mailbox_id === ob.id && x.enr === "active"), "campañas: los aprobados entran en la secuencia desde el buzón de outbound", JSON.stringify(enrolled));
  // El primer paso no tiene espera: sale en la misma revisión (dentro del horario y del cupo del buzón).
  const st = await mock("/__state");
  const out = await sql`SELECT to_email, body, mailbox_id, campaign_id FROM emails WHERE campaign_id = ${camp.id} AND direction = 'out' ORDER BY to_email`;
  check(st.sent.length === before + 2 && out.length === 2 && out.every((e) => e.mailbox_id === ob.id && e.body.includes("/u/") && e.body.includes("darte de baja")),
        "campañas: salen desde el buzón de outbound con el enlace de baja", JSON.stringify(out.map((e) => ({ to: e.to_email, mb: e.mailbox_id === ob.id }))));
  check(out[0].body.includes("Prospecto E2E"), "campañas: {empresa} en el texto");
  // Enlace de baja: página pública.
  const unsubUrl = /\/u\/[^\s]+/.exec(out[0].body)[0];
  const up = await fetch(`${BASE}${unsubUrl}`);
  const uh = await up.text();
  check(up.status === 200 && uh.includes("Darme de baja"), "baja: el enlace abre la página sin iniciar sesión");
  check((await (await fetch(`${BASE}/u/00000000-0000-0000-0000-000000000000.firma-falsa`)).text()).includes("no es válido"), "baja: un enlace manipulado no sirve");
  // Límite diario del buzón (calentamiento): con el cupo agotado, se aplaza.
  await sql`UPDATE mailbox_connections SET daily_limit = 2 WHERE id = ${ob.id}`;
  // Respuestas: interesada → deal; de vacaciones → pausa y retoma.
  const people = Object.fromEntries((await sql`SELECT cc.email, cc.person_id FROM campaign_contacts cc WHERE cc.campaign_id = ${camp.id}`).map((x) => [x.email, x.person_id]));
  await sql`INSERT INTO emails (direction, status, person_id, from_email, subject, body, sent_at)
            VALUES ('in', 'sent', ${people["marta@prospecto-e2e.example"]}, 'marta@prospecto-e2e.example', 'Re: propuesta', 'Me interesa, ¿hablamos el jueves?', now()),
                   ('in', 'sent', ${people["pedro@prospecto-e2e.example"]}, 'pedro@prospecto-e2e.example', 'Respuesta automática', 'Estoy de vacaciones hasta el lunes.', now())`;
  await run();
  const [mi] = await sql`SELECT cc.status, cc.reply_class, cc.deal_id, d.source, d.title FROM campaign_contacts cc LEFT JOIN deals d ON d.id = cc.deal_id
                         WHERE cc.campaign_id = ${camp.id} AND cc.email = 'marta@prospecto-e2e.example'`;
  check(mi?.status === "interested" && mi.deal_id && mi.source === "Outbound: Outbound e2e", "respuestas: interesada → deal en el pipeline, con su origen", JSON.stringify(mi));
  const [mn] = await sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'campaign' AND title LIKE '%Marta Prospecto está interesado%'`;
  check(mn.n === 1, "respuestas: aviso al responsable cuando alguien está interesado");
  const [pe] = await sql`SELECT cc.status, cc.reply_class, e.status AS enr, e.next_run_at > now() + interval '6 days' AS later FROM campaign_contacts cc
                         JOIN sequence_enrollments e ON e.id = cc.enrollment_id WHERE cc.campaign_id = ${camp.id} AND cc.email = 'pedro@prospecto-e2e.example'`;
  await run();
  const [pe2] = await sql`SELECT e.status FROM campaign_contacts cc JOIN sequence_enrollments e ON e.id = cc.enrollment_id
                          WHERE cc.campaign_id = ${camp.id} AND cc.email = 'pedro@prospecto-e2e.example'`;
  check(pe?.reply_class === "fuera_oficina" && pe.enr === "active" && pe.later && pe2.status === "active",
        "respuestas: fuera de la oficina → la secuencia se pausa y se retoma después (no se para)", JSON.stringify({ pe, pe2 }));
  const list = await (await get("/campaigns")).text();
  check(list.includes("Outbound e2e") && list.includes("Campañas de outbound"), "/campaigns lista las campañas con sus resultados");
  const cpage2 = await (await get(`/campaigns/${camp.id}`)).text();
  check(cpage2.includes("Interesado") && cpage2.includes("Ver deal") && cpage2.includes("Fuera de la oficina"), "campañas: cada contacto con su estado y respuesta");

  // Un agente externo prepara la lista y la vuelca por MCP.
  const key = "crm_clave-agente-outbound-e2e-0123456789";
  await sql`INSERT INTO agent_keys (name, key_hash, prefix, can_write) VALUES ('Agente de listas', ${createHash("sha256").update(key).digest("hex")}, 'crm_clave', true)
            ON CONFLICT (key_hash) DO NOTHING`;
  const mcp = async (name, args) => {
    const r = await fetch(`${BASE}/api/v1/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const j = await r.json();
    try { return JSON.parse(j.result.content[0].text); } catch { return j; }
  };
  const lc = await mcp("listar_campanas", {});
  check(Array.isArray(lc) && lc.some((c) => c.nombre === "Outbound e2e"), "MCP: listar campañas", JSON.stringify(lc).slice(0, 200));
  const ac = await mcp("anadir_contactos_campana", { campana_id: camp.id, contactos: [{ email: "lucia@prospecto-e2e.example", nombre: "Lucía Prospecto", empresa: "Prospecto E2E" }] });
  check(ac.anadidos === 1, "MCP: un agente añade contactos a una campaña", JSON.stringify(ac));
  const risk = await mcp("deals_en_riesgo", { limite: 3 });
  check(Array.isArray(risk), "MCP: deals en riesgo", JSON.stringify(risk).slice(0, 150));

  await sql`UPDATE campaigns SET status = 'finished' WHERE id = ${camp.id}`;
  await sql`UPDATE ai_settings SET api_key = ${enc("clave-mala")}`;
}

// ------------------------------------------------------------- Fase 4: clientes y Customer Success
{
  const SECRET = process.env.CRON_SECRET ?? "";
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  const CONTRACT = "c0000000-0000-0000-0000-000000000001";
  await run();
  // Renovación: el contrato de Paco vence en ~100 días → deal de renovación.
  const [ren] = await sql`SELECT d.id, d.deal_type, d.origin, d.value::float8 AS value, d.expected_close_date::text AS close, p.kind
                          FROM deals d JOIN pipelines p ON p.id = d.pipeline_id WHERE d.contract_id = ${CONTRACT} AND d.deal_type = 'renewal'`;
  const [ct] = await sql`SELECT renewal_date::text FROM contracts WHERE id = ${CONTRACT}`;
  check(ren && ren.kind === "renewal" && ren.origin === "cs" && ren.value === 12000 && ren.close === ct.renewal_date,
        "renovaciones: deal de renovación 120 días antes, con el importe y la fecha del contrato", JSON.stringify(ren));
  // QBR: tarea con el resumen de la cuenta.
  const [qbr] = await sql`SELECT subject, note, type FROM activities WHERE organization_id = ${ORG} AND subject LIKE 'QBR con %' ORDER BY created_at DESC LIMIT 1`;
  check(qbr?.note?.includes("licencias en uso") || qbr?.note?.includes("licencias_en_uso"), "QBR: tarea trimestral con el resumen de uso, salud y renovación", JSON.stringify(qbr));
  // Salud de la cuenta con los datos de uso.
  const [ah] = await sql`SELECT score, signals FROM account_health WHERE organization_id = ${ORG}`;
  const keys = (ah?.signals ?? []).map((x) => x.key);
  check(ah && keys.includes("seats_full") && keys.includes("usage_up"), "salud de la cuenta: licencias casi llenas y uso al alza", JSON.stringify(ah?.signals));
  // Datos de uso por la API.
  const up = await fetch(`${BASE}/api/v1/accounts/usage`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify([{ domain: "paco.example", metric: "tickets_abiertos", value: 7 }, { domain: "no-existe.example", metric: "x", value: 1 }]) });
  const upj = await up.json();
  check(up.status === 201 && upj.saved === 1 && upj.results[1].ok === false, "uso: la API guarda los datos y avisa de los que no encajan", JSON.stringify(upj));
  check((await fetch(`${BASE}/api/v1/accounts/usage`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 401, "uso: la API pide clave");
  await run();
  const [ah2] = await sql`SELECT signals FROM account_health WHERE organization_id = ${ORG}`;
  check(ah2.signals.some((x) => x.key === "tickets"), "salud de la cuenta: muchos tickets abiertos es un riesgo");
  const accounts = await (await get("/accounts")).text();
  check(accounts.includes("Clientes") && accounts.includes("Paco S.L.") && accounts.includes("12.000") && accounts.includes("Renuevan en 120 días"),
        "/accounts: cartera de clientes con importe, salud y renovaciones");
  const orgPage = await (await get(`/organizations/${ORG}`)).text();
  check(orgPage.includes("Uso del producto") && orgPage.includes("licencias en uso") && orgPage.includes("Contratos") && orgPage.includes("Renovación — Paco S.L."),
        "ficha de la empresa: cliente con contrato, uso, renovación y expansión");

  // Deal de venta ganado → contrato, onboarding con su plan y ficha del kick-off.
  const NEWORG = "60000000-0000-0000-0000-0000000000c1", WON = "90000000-0000-0000-0000-0000000000c1";
  await sql`INSERT INTO organizations (id, name, domain) VALUES (${NEWORG}, 'Cliente Nuevo E2E', 'cliente-nuevo-e2e.example') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO deals (id, title, organization_id, pipeline_id, stage_id, owner_id, value)
            VALUES (${WON}, 'Cliente Nuevo — licencias', ${NEWORG}, ${P.inbound}, '20000000-0000-0000-0000-000000000014', ${ADMIN_ID}, 18000) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO deal_participants (deal_id, person_id, is_primary) VALUES (${WON}, ${PERSON}, true) ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO deal_products (deal_id, product_id, quantity, unit_price) VALUES (${WON}, '40000000-0000-0000-0000-000000000003', 2, 9000)`;
  await sql`INSERT INTO deal_insights (deal_id, needs, timeline) VALUES (${WON}, ARRAY['Unificar la facturación'], 'Arrancar en enero') ON CONFLICT DO NOTHING`;
  await sql`UPDATE deals SET status = 'won' WHERE id = ${WON}`;
  await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type, payload) VALUES ('deal', ${WON}, 'deal.won', 'user', '{}')`;
  await run();
  const [c2] = await sql`SELECT c.id, c.annual_value::float8 AS annual, c.seats, c.renewal_date - c.start_date AS days,
                                (SELECT count(*)::int FROM contract_items i WHERE i.contract_id = c.id) AS items FROM contracts c WHERE c.deal_id = ${WON}`;
  check(c2 && c2.annual === 18000 && c2.seats === 2 && c2.items === 1 && c2.days >= 365, "cliente nuevo: contrato con sus productos, importe anual y renovación a un año", JSON.stringify(c2));
  const [ob] = await sql`SELECT d.id, d.deal_type, d.origin, p.kind, (SELECT count(*)::int FROM close_plan_steps s WHERE s.deal_id = d.id) AS steps,
                                (SELECT count(*)::int FROM deal_participants dp WHERE dp.deal_id = d.id) AS people,
                                (SELECT content FROM notes n WHERE n.deal_id = d.id LIMIT 1) AS note
                         FROM deals d JOIN pipelines p ON p.id = d.pipeline_id WHERE d.contract_id = ${c2?.id ?? null} AND d.deal_type = 'onboarding'`;
  check(ob?.kind === "onboarding" && ob.origin === "cs" && ob.steps === 5 && ob.people === 1 && ob.note?.includes("Unificar la facturación") && ob.note.includes("Arrancar en enero"),
        "cliente nuevo: onboarding con su plan de hitos, los contactos y lo prometido en la venta", JSON.stringify(ob));
  const obPage = await (await get(`/deals/${ob?.id}`)).text();
  check(obPage.includes("Plan de onboarding") && obPage.includes("Formación del equipo") && obPage.includes("Onboarding"), "ficha del onboarding: plan de hitos");
  // Onboarding terminado → encuesta de satisfacción.
  await sql`UPDATE deals SET status = 'won' WHERE id = ${ob.id}`;
  await sql`INSERT INTO events (entity_type, entity_id, event_type, actor_type, payload) VALUES ('deal', ${ob.id}, 'deal.won', 'user', '{}')`;
  await run();
  const [sv] = await sql`SELECT x.status, x.payload FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id WHERE r.key = 'onboarding_survey' AND x.deal_id = ${ob.id}`;
  const link = /\/s\/[A-Za-z0-9_-]+/.exec(sv?.payload?.body ?? "")?.[0];
  check(sv?.status === "pending" && link, "onboarding terminado: propone la encuesta de satisfacción", JSON.stringify(sv?.payload));
  const sp = await fetch(`${BASE}${link}`);
  check(sp.status === 200 && (await sp.text()).includes("¿Qué tal ha ido la puesta en marcha?"), "encuesta: se abre sin iniciar sesión");
  await sql`UPDATE surveys SET score = 4, comment = 'Lento al principio', answered_at = now() WHERE token = ${link.slice(3)}`;
  await run();
  const [ah3] = await sql`SELECT signals FROM account_health WHERE organization_id = ${NEWORG}`;
  check(ah3?.signals.some((x) => x.key === "nps_low"), "salud de la cuenta: una mala nota en la encuesta es un riesgo", JSON.stringify(ah3));
  // Un deal ganado sin empresa no crea cliente (no hay a quién).
  await sql`DELETE FROM deals WHERE id IN (${WON}, ${ob.id})`;
  await sql`DELETE FROM organizations WHERE id = ${NEWORG}`;
}

// ------------------------------------------------------------- Fase 5: expansión y orquestación
{
  const SECRET = process.env.CRON_SECRET ?? "";
  const MOCK = process.env.MOCK_URL;
  const run = async () => (await fetch(`${BASE}/api/v1/automations/run`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } })).json();
  // Cliente con las licencias llenas → oportunidad de upsell (con la regla en «Sola», se crea el deal en Expansión).
  const XORG = "60000000-0000-0000-0000-0000000000d1";
  await sql`INSERT INTO organizations (id, name, domain) VALUES (${XORG}, 'Expande E2E', 'expande-e2e.example') ON CONFLICT DO NOTHING`;
  const [xc] = await sql`INSERT INTO contracts (organization_id, name, start_date, renewal_date, annual_value, seats)
                         VALUES (${XORG}, 'Expande — anual', current_date - 200, current_date + 165, 10000, 10) RETURNING id`;
  await sql`INSERT INTO contract_items (contract_id, product_id, quantity, unit_price) VALUES (${xc.id}, '40000000-0000-0000-0000-000000000001', 10, 1000)`;
  await sql`INSERT INTO account_usage (organization_id, metric, value) VALUES (${XORG}, 'licencias_en_uso', 10)`;
  await sql`UPDATE automation_rules SET autonomy = 'auto' WHERE key = 'expansion_opportunity'`;
  await run();
  const [xd] = await sql`SELECT d.title, d.deal_type, d.origin, d.value::float8 AS value, p.kind, d.contract_id FROM deals d JOIN pipelines p ON p.id = d.pipeline_id
                         WHERE d.organization_id = ${XORG} AND d.deal_type = 'upsell'`;
  check(xd?.kind === "expansion" && xd.origin === "cs" && xd.value === 3000 && xd.contract_id === xc.id && xd.title.includes("licencias"),
        "expansión: licencias llenas → oportunidad de upsell en el pipeline de expansión, con importe estimado", JSON.stringify(xd));
  const [xa] = await sql`SELECT x.reason FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id WHERE r.key = 'expansion_opportunity' AND x.subject_id = ${XORG}`;
  check(xa?.reason.toLowerCase().includes("usa 10 de 10 licencias"), "expansión: la propuesta explica su porqué", xa?.reason);
  await sql`UPDATE automation_rules SET autonomy = 'ask' WHERE key = 'expansion_opportunity'`;
  const matrix = await (await get("/accounts/matrix")).text();
  check(matrix.includes("Matriz de productos") && matrix.includes("Expande E2E") && matrix.includes("Segunda plataforma") && matrix.includes("matrix-gap"),
        "matriz de productos: qué tiene cada cliente y qué le falta");
  const rep = await (await get("/reports")).text();
  check(rep.includes("Nuevo negocio, expansión y renovaciones") && rep.includes("Upsell"), "informes: nuevo negocio frente a expansión");

  // Panel de agentes y consumo de IA.
  const ag = await (await get("/agents")).text();
  check(ag.includes("Jefe de agentes") && ag.includes("Captación") && ag.includes("Prospección (outbound)") && ag.includes("Ejecutivo de deal")
        && ag.includes("Riesgo y forecast") && ag.includes("Onboarding (CS)") && ag.includes("Cuenta y expansión (CS)") && ag.includes("Detectar upselling y cross-selling")
        && ag.includes("Límites"), "/agents: los seis agentes con sus reglas, trabajos y límites");
  const [use] = await sql`SELECT count(*)::int AS n, count(DISTINCT agent)::int AS agents, sum(cost)::float8 AS cost FROM ai_usage`;
  check(use.n > 0 && use.agents >= 2 && use.cost > 0, "consumo de IA: cada llamada queda registrada con su agente y su coste estimado", JSON.stringify(use));
  if (MOCK && process.env.TOKEN_ENCRYPTION_KEY) {
    const enc = (plain) => {
      const key = createHash("sha256").update(process.env.TOKEN_ENCRYPTION_KEY ?? "").digest();
      const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
      const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
    };
    await sql`UPDATE ai_settings SET api_key = ${enc("clave-llm-de-pruebas")}, last_error = NULL, budget_alerts = '{}'`;
    // Presupuesto casi gastado: una llamada urgente lo cruza → aviso; lo no urgente deja de usar la IA.
    const [{ spent }] = await sql`SELECT coalesce(sum(cost), 0)::float8 AS spent FROM ai_usage WHERE at >= date_trunc('month', now())`;
    await sql`UPDATE ai_settings SET monthly_budget = ${Math.round((spent + 0.000001) * 1e6) / 1e6 + 0.000001}`;
    await get(`/reports?q=${encodeURIComponent("¿Cuánto ganamos por origen?")}`);
    const [al] = await sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'ai_budget' AND title = 'Presupuesto de IA del mes agotado'`;
    check(al.n >= 1, "presupuesto de IA: al agotarse, aviso a los administradores");
    await sql`DELETE FROM deal_briefs`;
    await run();
    const [st] = await sql`SELECT last_error FROM ai_settings`;
    const [{ ai }] = await sql`SELECT count(*)::int AS ai FROM deal_briefs`;
    check(st.last_error?.includes("Presupuesto de IA del mes agotado") && ai === 0, "presupuesto de IA: agotado, lo no urgente sigue con reglas", JSON.stringify({ st, ai }));
    await sql`UPDATE ai_settings SET monthly_budget = NULL, api_key = ${enc("clave-mala")}`;
  }
  // Un agente externo consulta las cuentas y propone una expansión (queda para aprobar).
  const key = "crm_clave-agente-cuentas-e2e-0123456789";
  await sql`INSERT INTO agent_keys (name, key_hash, prefix, can_write) VALUES ('Agente de cuentas', ${createHash("sha256").update(key).digest("hex")}, 'crm_clave', true)
            ON CONFLICT (key_hash) DO NOTHING`;
  const mcp = async (name, args) => {
    const r = await fetch(`${BASE}/api/v1/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const j = await r.json();
    try { return JSON.parse(j.result.content[0].text); } catch { return j; }
  };
  const cuentas = await mcp("cuentas", {});
  check(Array.isArray(cuentas) && cuentas.some((c) => c.cliente === "Expande E2E" && typeof c.salud === "number"), "MCP: cuentas con su salud", JSON.stringify(cuentas).slice(0, 200));
  const pe = await mcp("proponer_expansion", { organization_id: XORG, tipo: "cross_sell", titulo: "Segunda plataforma", importe: 9000, motivo: "Lo pidieron en la QBR" });
  check(pe.estado === "pendiente", "MCP: un agente propone una expansión y queda para aprobar", JSON.stringify(pe));
  const reg = await mcp("registrar_uso", { dominio: "expande-e2e.example", metrica: "usuarios_activos", valor: 8 });
  check(reg.organization_id === XORG, "MCP: registrar datos de uso", JSON.stringify(reg));
  await sql`DELETE FROM deals WHERE organization_id = ${XORG}`;
  await sql`DELETE FROM organizations WHERE id = ${XORG}`;
}

// ------------------------------------------------------------- Avisos, importar CSV, duplicados
{
  // Abrir una propuesta avisa al responsable del deal.
  const [own] = await sql`SELECT owner_id FROM deals WHERE id = ${DEAL_OPEN}`;
  const [pn] = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${own.owner_id} AND kind = 'proposal.viewed'`;
  check(pn.n >= 1, "avisos: el responsable sabe que el cliente abrió la propuesta", JSON.stringify(pn));
  const nl = await (await get("/api/notifications")).json();
  check(Array.isArray(nl.items) && typeof nl.unread === "number", "avisos: la campana lista los avisos", JSON.stringify(nl).slice(0, 100));
  const mr = await (await get("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  check(mr.unread === 0, "avisos: marcar todo como leído", JSON.stringify(mr));
  check((await fetch(`${BASE}/api/notifications`)).status === 401, "avisos: sin sesión → 401");

  // CSV: vista previa con las columnas reconocidas e importación.
  const csvText = "\uFEFFNombre completo;Email;Empresa;Cargo;Teléfono;Notas\r\n"
    + "Elena CSV;elena.csv@csv-uno.example;CSV Uno S.L.;Directora;600111222;\"Vino de la feria; muy interesada\"\r\n"
    + "Pablo CSV;pablo.csv@csv-dos.example;CSV Dos;;;\r\n"
    + "Sin Email;no-es-un-email;;;;\r\n";
  const imp = (body) => get("/api/import/csv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  const pv = await imp({ text: csvText, step: "preview" });
  check(pv.total === 3 && pv.mapping.join(",") === "full_name,email,company,job_title,phone,message" && pv.sample[0][5] === "Vino de la feria; muy interesada",
        "CSV: reconoce las columnas por su título (también con «;» dentro de comillas)", JSON.stringify(pv.mapping));
  const ir = await imp({ text: csvText, mapping: pv.mapping, mode: "leads", source: "feria e2e" });
  const [el] = await sql`SELECT l.source, p.full_name, o.name AS org, (SELECT content FROM notes n WHERE n.lead_id = l.id LIMIT 1) AS note
                         FROM leads l JOIN persons p ON p.id = l.person_id LEFT JOIN organizations o ON o.id = l.organization_id
                         JOIN person_emails pe ON pe.person_id = p.id WHERE pe.email = 'elena.csv@csv-uno.example'`;
  check(ir.created === 2 && ir.skipped === 1 && ir.errors[0]?.row === 4 && el?.source === "feria e2e" && el.org === "CSV Uno S.L." && el.note?.includes("feria"),
        "CSV: importa los leads con su empresa y notas, y dice qué filas no", JSON.stringify({ ir, el }));
  const ir2 = await imp({ text: csvText, mapping: pv.mapping, mode: "contacts" });
  check(ir2.created === 0 && ir2.updated === 2, "CSV: volver a importar no duplica contactos", JSON.stringify(ir2));

  // Duplicados: dos contactos con el mismo nombre en la misma empresa.
  const [org] = await sql`INSERT INTO organizations (name) VALUES ('Duplis S.L.') RETURNING id`;
  const [a] = await sql`INSERT INTO persons (first_name, last_name) VALUES ('Marta', 'Doble') RETURNING id`;
  const [b] = await sql`INSERT INTO persons (first_name, last_name) VALUES ('marta', 'doble') RETURNING id`;
  await sql`INSERT INTO person_organizations (person_id, organization_id, status) VALUES (${a.id}, ${org.id}, 'current'), (${b.id}, ${org.id}, 'current')`;
  const dup = await (await get("/duplicates")).text();
  check(dup.includes("Marta Doble") && dup.includes("Fusionar (2)"), "duplicados: detecta contactos repetidos");
  const dupOrg = await (await get("/duplicates?kind=organization")).text();
  check(dupOrg.includes("Duplicados"), "duplicados: pestaña de empresas");
  const trash = await (await get("/trash")).text();
  check(trash.includes("Papelera"), "/trash muestra la papelera");
}

// ------------------------------------------------------------- Agentes externos por MCP
{
  const key = "crm_clave-de-agente-de-pruebas-0123456789";
  const keyRO = "crm_clave-de-solo-lectura-de-pruebas-0123";
  const h = (k) => createHash("sha256").update(k).digest("hex");
  await sql`INSERT INTO agent_keys (name, key_hash, prefix, can_write) VALUES ('Grok Bot', ${h(key)}, 'crm_clave', true), ('Lector', ${h(keyRO)}, 'crm_clave', false)
            ON CONFLICT (key_hash) DO NOTHING`;
  let rid = 0;
  const rpc = async (method, params, k = key) => {
    const r = await fetch(`${BASE}/api/v1/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${k}` },
                                                   body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
    return { status: r.status, body: r.status === 202 ? null : await r.json() };
  };
  const call = async (name, args, k) => {
    const r = await rpc("tools/call", { name, arguments: args }, k);
    const text = r.body?.result?.content?.[0]?.text ?? "";
    let data = null; try { data = JSON.parse(text); } catch { /* texto de error */ }
    return { isError: Boolean(r.body?.result?.isError), text, data };
  };
  check((await rpc("initialize", {}, "crm_inventada-0000000000000000000000")).status === 401, "MCP: sin clave válida → 401");
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  check(init.body?.result?.serverInfo?.name === "crm" && init.body.result.protocolVersion === "2025-06-18" && init.body.result.capabilities.tools,
        "MCP: initialize", JSON.stringify(init.body));
  check((await fetch(`${BASE}/api/v1/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
                                              body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) })).status === 202,
        "MCP: las notificaciones no tienen respuesta (202)");
  const tl = await rpc("tools/list", {});
  const names = (tl.body?.result?.tools ?? []).map((t) => t.name);
  check(["buscar", "ver_deal", "listar_deals", "proponer_tarea", "proponer_mover_fase"].every((n) => names.includes(n)), "MCP: lista de herramientas", names.join(","));
  const roNames = ((await rpc("tools/list", {}, keyRO)).body?.result?.tools ?? []).map((t) => t.name);
  check(roNames.includes("buscar") && !roNames.includes("proponer_nota"), "MCP: una clave de solo lectura no ve las acciones");
  const b = await call("buscar", { texto: "paco" });
  check(Array.isArray(b.data) && b.data.some((x) => x.tipo === "deal" && x.nombre.includes("Paco")), "MCP: buscar", b.text.slice(0, 120));
  const vd = await call("ver_deal", { deal_id: DEAL_OPEN });
  check(vd.data?.titulo === "Paco — ampliación de servicio" && Array.isArray(vd.data.fases_del_pipeline) && vd.data.resumen?.siguiente_paso,
        "MCP: ver_deal con resumen y siguiente paso", vd.text.slice(0, 160));
  await sql`UPDATE ai_permissions SET autonomy = 'ask' WHERE actor = 'external' AND action_type = 'add_note'`;
  const p1 = await call("proponer_nota", { deal_id: DEAL_OPEN, texto: "Nota de Grok (ask)", motivo: "Resumen de la llamada" });
  const [x1] = await sql`SELECT actor, agent_name, status, mode FROM automation_actions WHERE id = ${p1.data?.propuesta_id ?? null}`;
  check(p1.data?.estado === "pendiente" && x1?.actor === "external" && x1.agent_name === "Grok Bot" && x1.status === "pending",
        "MCP: con «Preguntar», la acción del agente queda en la bandeja", JSON.stringify({ p1: p1.data, x1 }));
  await sql`UPDATE ai_permissions SET autonomy = 'auto' WHERE actor = 'external' AND action_type = 'add_note'`;
  const p2 = await call("proponer_nota", { deal_id: DEAL_OPEN, texto: "Nota de Grok (auto)" });
  const [nn] = await sql`SELECT count(*)::int AS n FROM notes WHERE deal_id = ${DEAL_OPEN} AND content = 'Nota de Grok (auto)'`;
  check(p2.data?.estado === "hecho" && nn.n === 1, "MCP: con «Sola», el agente la hace directamente", JSON.stringify(p2.data));
  await sql`UPDATE ai_permissions SET autonomy = 'off' WHERE actor = 'external' AND action_type = 'move_stage'`;
  const p3 = await call("proponer_mover_fase", { deal_id: DEAL_OPEN, fase: "Propuesta enviada" });
  check(p3.isError && p3.text.includes("no tienen permiso"), "MCP: sin permiso, el agente no puede", p3.text);
  const p4 = await call("proponer_nota", { deal_id: DEAL_OPEN, texto: "x" }, keyRO);
  check(p4.isError, "MCP: una clave de solo lectura no puede actuar");
  await sql`UPDATE ai_permissions SET autonomy = 'ask' WHERE actor = 'external'`;
  const ag = await (await get("/settings/agents")).text();
  check(ag.includes("Agentes externos (MCP)") && ag.includes("Grok Bot") && ag.includes("/api/v1/mcp"), "/settings/agents lista las claves y cómo conectarlas");
}

// ------------------------------------------------------------- Reservas y semana
{
  check((await fetch(`${BASE}/book/no-existe`)).status === 404, "reservas: una página que no existe → 404 (sin pedir sesión)");
  await sql`INSERT INTO booking_pages (user_id, slug, title) VALUES (${ADMIN_ID}, 'gestor-e2e', 'Charla e2e') ON CONFLICT (user_id) DO UPDATE SET slug = 'gestor-e2e', is_active = true`;
  const pub = await fetch(`${BASE}/book/gestor-e2e`);
  const pubHtml = await pub.text();
  check(pub.status === 200 && pubHtml.includes("Charla e2e") && !pubHtml.includes('aria-label="Principal"'), "reservas: la página pública abre sin sesión y sin el menú del CRM", `HTTP ${pub.status}`);
  const settings = await (await get("/settings/booking")).text();
  check(settings.includes("Enlace de reserva") && settings.includes("/book/gestor-e2e"), "/settings/booking muestra tu enlace");
  const week = await (await get("/activities?view=week")).text();
  check(week.includes("Semana siguiente") && week.includes("week-grid"), "actividades: vista de semana");
}

// ------------------------------------------------------------- Fichas como en Pipedrive: archivos, seguidores, llamadas, listas
{
  // Archivos: subir, listar en la ficha, descargar; no se aceptan ejecutables.
  const form = new FormData();
  form.append("file", new Blob(["hola contrato"], { type: "text/plain" }), "contrato e2e.txt");
  form.append("person_id", PERSON);
  const up = await get("/api/files", { method: "POST", body: form });
  const upj = await up.json();
  const bad = new FormData();
  bad.append("file", new Blob(["MZ"], { type: "application/octet-stream" }), "virus.exe");
  bad.append("person_id", PERSON);
  const upBad = await get("/api/files", { method: "POST", body: bad });
  const anon = await fetch(`${BASE}/api/files/${upj.ids?.[0]}`, { redirect: "manual" });
  const dl = await get(`/api/files/${upj.ids?.[0]}`);
  const dlText = await dl.text();
  check(up.status === 200 && upj.ids?.length === 1 && upBad.status === 400 && dl.status === 200 && dlText === "hola contrato"
        && (dl.headers.get("content-disposition") ?? "").includes("attachment") && anon.status !== 200,
        "archivos: se suben a la ficha, se descargan con sesión (y sin ella no); los ejecutables no", JSON.stringify({ up: up.status, bad: upBad.status, dl: dl.status, anon: anon.status }));
  const page = await (await get(`/persons/${PERSON}`)).text();
  check(page.includes("contrato e2e.txt") && page.includes("Registrar llamada") && page.includes("Seguidores") && page.includes("Último contacto")
        && page.includes("Fusionar con otro contacto") && page.includes("Descargar vCard") && page.includes("WhatsApp"),
        "ficha de contacto: acciones rápidas, archivos, seguidores, resumen y fusionar");
  const vc = await (await get(`/api/persons/${PERSON}/vcard`)).text();
  check(vc.startsWith("BEGIN:VCARD") && vc.includes("FN:Ana García") && vc.includes("EMAIL;TYPE=INTERNET:ana@paco.example"), "vCard del contacto", vc.slice(0, 120));
  // Seguidores: quien sigue un deal recibe aviso de un cambio (y quien lo hizo no).
  await sql`INSERT INTO followers (entity_type, entity_id, user_id) VALUES ('deal', ${DEAL_OPEN}, ${MEMBER_ID}) ON CONFLICT DO NOTHING`;
  const [nb] = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${MEMBER_ID} AND kind = 'follow'`;
  await get("/api/files", { method: "POST", body: (() => { const f = new FormData(); f.append("file", new Blob(["x"], { type: "text/plain" }), "acta.txt"); f.append("deal_id", DEAL_OPEN); return f; })() });
  const [na] = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${MEMBER_ID} AND kind = 'follow' AND title LIKE '%Nuevo archivo: acta.txt%'`;
  const [own] = await sql`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${ADMIN_ID} AND kind = 'follow' AND title LIKE '%acta.txt%'`;
  check(na.n === 1 && nb.n === 0 && own.n === 0, "seguidores: quien sigue el deal recibe el aviso del archivo nuevo", JSON.stringify({ nb, na, own }));
  const deal = await (await get(`/deals/${DEAL_OPEN}`)).text();
  check(deal.includes("acta.txt") && deal.includes("Seguidores") && deal.includes("Llamada") && deal.includes("Etiqueta"), "ficha del deal: archivos, seguidores, llamada y etiquetas");
  // Listas con filtros.
  await sql`INSERT INTO tags (name, color) VALUES ('vip-e2e', 'green') ON CONFLICT DO NOTHING`;
  const [tg] = await sql`SELECT id FROM tags WHERE name = 'vip-e2e'`;
  await sql`INSERT INTO person_tags (person_id, tag_id) VALUES (${PERSON}, ${tg.id}) ON CONFLICT DO NOTHING`;
  const byTag = await (await get(`/persons?tag=${tg.id}`)).text();
  const none = await (await get(`/persons?tag=${tg.id}&deals=none`)).text();
  const orgs = await (await get(`/organizations?owner=me&sort=recent`)).text();
  check(byTag.includes("Ana García") && byTag.includes("vip-e2e") && !none.includes("Ana García") && orgs.includes("Empresas"),
        "listas: filtro por etiqueta, deals y responsable");
}

// ------------------------------------------------------------- Usuarios y permisos
{
  const as = async (userId, path) => {
    const token = await createSessionToken(sql, userId);
    const res = await fetch(`${BASE}${path}`, { redirect: "manual", headers: { cookie: `crm_session=${token}` } });
    return { res, html: (await res.text()).replace(/<!-- -->/g, "") };
  };
  await sql`UPDATE users SET password_hash = ${hashPassword("otra-contraseña-123")}, role = 'member', is_active = true, must_change_password = false WHERE id = ${MEMBER_ID}`;
  const usersPage = await (await get("/settings/users")).text();
  check(usersPage.includes("Usuarios y permisos") && usersPage.includes("Generación de leads") && usersPage.includes("Dar acceso a alguien"),
        "/settings/users lista el equipo");
  const settingsMember = await as(MEMBER_ID, "/settings");
  check(settingsMember.html.includes("Correo, calendario y documentos") && !settingsMember.html.includes("Importar desde Pipedrive"),
        "un comercial solo ve sus ajustes");
  const denied = await as(MEMBER_ID, "/settings/ai");
  check(denied.res.status === 307 || denied.html.includes("denied=1"), "un comercial no entra en los ajustes de la IA", `HTTP ${denied.res.status}`);
  const deal = await as(MEMBER_ID, `/deals/${DEAL_OPEN}`);
  check(deal.res.status === 200 && deal.html.includes("Generación de leads"), "un comercial trabaja con los deals (y se ve su nombre)");
  const mailboxMember = await as(MEMBER_ID, "/settings/mailbox");
  check(mailboxMember.html.includes("Tu cuenta") && !mailboxMember.html.includes("Cuenta de Customer Success"), "en el correo, cada comercial ve solo su cuenta");
  const tempUser = await as(MEMBER_ID, "/");
  check(tempUser.res.status === 200, "la portada abre para un comercial", `HTTP ${tempUser.res.status}`);
  await sql`UPDATE users SET must_change_password = true WHERE id = ${MEMBER_ID}`;
  const forced = await as(MEMBER_ID, "/pipelines");
  check(forced.res.status === 307 && (forced.res.headers.get("location") ?? "").includes("/account?change=1") || forced.html.includes("/account?change=1"),
        "con contraseña temporal, primero hay que cambiarla", `HTTP ${forced.res.status}`);
  await sql`UPDATE users SET is_active = false WHERE id = ${MEMBER_ID}`;
  const inactive = await as(MEMBER_ID, "/pipelines");
  check(inactive.res.status === 307 && (inactive.res.headers.get("location") ?? "").includes("/login"), "un usuario desactivado ya no entra");
  await sql`UPDATE users SET is_active = true, must_change_password = false, password_hash = NULL, role = 'member' WHERE id = ${MEMBER_ID}`;
}

await sql.end();
console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} correctas, ${failed} fallidas`);
process.exit(failed === 0 ? 0 : 1);
