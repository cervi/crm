#!/usr/bin/env node
// Pruebas de extremo a extremo contra la aplicación en marcha (con los datos
// de ejemplo cargados): todas las pantallas responden y la API de entrada
// deduplica correctamente.
//
//   BASE_URL=http://localhost:3000 DATABASE_URL=... INBOUND_API_KEYS=... node scripts/e2e.mjs
//
// Si la app tiene BASIC_AUTH_USER/BASIC_AUTH_PASSWORD, pásalos también.
import postgres from "postgres";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const KEY = (process.env.INBOUND_API_KEYS ?? "").split(",")[0]?.trim();
const user = process.env.BASIC_AUTH_USER, pass = process.env.BASIC_AUTH_PASSWORD;
const auth = user && pass ? { authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` } : {};
const sql = postgres(process.env.DATABASE_URL ?? "postgres://crm:crm@localhost:5432/crm", { max: 1 });

let passed = 0, failed = 0;
const ok = (name) => { passed++; console.log(`OK   · ${name}`); };
const fail = (name, detail) => { failed++; console.log(`FALLO · ${name}${detail ? ` — ${detail}` : ""}`); };
const check = (cond, name, detail) => (cond ? ok(name) : fail(name, detail));

// React separa trozos de texto con marcadores <!-- --> en el HTML: se quitan para comparar texto.
const get = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual", ...opts, headers: { ...auth, ...(opts.headers ?? {}) } });
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
check([307, 308].includes(root.status), "la portada redirige", `HTTP ${root.status}`);

const lookup = await (await get("/api/lookup?type=organizations&q=pac")).json();
check(Array.isArray(lookup) && lookup.some((o) => o.label === "Paco S.L."), "búsqueda de empresas");
const lookupP = await (await get("/api/lookup?type=persons&q=ana@")).json();
check(Array.isArray(lookupP) && lookupP.some((p) => p.label === "Ana García"), "búsqueda de contactos por email");

if (user && pass) {
  const noAuth = await fetch(`${BASE}/organizations`, { redirect: "manual" });
  check(noAuth.status === 401, "sin contraseña se pide autenticación", `HTTP ${noAuth.status}`);
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

await sql.end();
console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} correctas, ${failed} fallidas`);
process.exit(failed === 0 ? 0 : 1);
