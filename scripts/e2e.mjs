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
  await run();
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
    const [dA, dB, dC] = await sql`SELECT ods.id, ods.organization_id FROM open_deals_status ods
                                   WHERE ods.organization_id IS NOT NULL AND ods.id <> ${DEAL_OPEN}
                                     AND ods.organization_id NOT IN (SELECT organization_id FROM deals WHERE id = ${DEAL_OPEN})
                                   ORDER BY ods.id LIMIT 3`;
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
  check(pageHtml.includes("Conectado a Aikit (simulado)") && pageHtml.includes("No cuadra") && pageHtml.includes("Recorrido por fases"),
        "/settings/import muestra la conexión, el resultado y la comprobación");
  await sql`UPDATE automation_settings SET paused = false`;
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
