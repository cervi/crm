#!/usr/bin/env node
// Pruebas de interfaz con navegador (Playwright) contra la app en marcha con
// los datos de ejemplo: los flujos que una persona hace a mano.
//
//   BASE_URL=... BASIC_AUTH_USER=... BASIC_AUTH_PASSWORD=... DATABASE_URL=... node scripts/ui-check.mjs
//
// Requiere Playwright con Chromium (no es dependencia del proyecto):
//   npm i -D playwright && npx playwright install chromium
// Opcional: SCREENSHOTS=carpeta guarda capturas de las pantallas principales.
import { createRequire } from "node:module";
import postgres from "postgres";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SHOTS = process.env.SCREENSHOTS;
const sql = postgres(process.env.DATABASE_URL ?? "postgres://crm:crm@localhost:5432/crm", { max: 1 });
const stamp = Date.now().toString().slice(-6);

let passed = 0, failed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log(`OK   · ${name}`); }
  catch (err) { failed++; console.log(`FALLO · ${name} — ${String(err.message ?? err).split("\n")[0]}`); }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const browser = await chromium.launch();
const context = await browser.newContext({
  baseURL: BASE,
  locale: "es-ES",
  viewport: { width: 1360, height: 900 },
  httpCredentials: process.env.BASIC_AUTH_USER
    ? { username: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASSWORD ?? "" } : undefined,
});
context.setDefaultTimeout(Number(process.env.UI_TIMEOUT ?? 8000));
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const submit = (label) => page.getByRole("button", { name: label, exact: true }).click();

const orgName = `Prueba UI ${stamp}`;
let orgId = "", dealId = "";

await step("crear empresa desde el formulario", async () => {
  await page.goto("/organizations/new");
  await page.getByLabel("Nombre *").fill(orgName);
  await page.getByLabel("Dominio").fill(`https://www.pruebaui${stamp}.com/contacto`);
  await page.locator("[name=industry]").fill("SaaS");
  await submit("Crear empresa");
  await page.waitForURL(/\/organizations\/[0-9a-f-]{36}$/);
  orgId = page.url().split("/").pop();
  await page.getByRole("heading", { name: orgName }).waitFor();
  const [o] = await sql`SELECT domain FROM organizations WHERE id = ${orgId}`;
  expect(o?.domain === `pruebaui${stamp}.com`, `dominio normalizado: ${o?.domain}`);
});

await step("un error de validación se muestra y no borra lo escrito", async () => {
  await page.goto("/organizations/new");
  await page.getByLabel("Nombre *").fill("Duplicada");
  await page.getByLabel("Dominio").fill(`pruebaui${stamp}.com`);
  await page.locator("[name=industry]").fill("Retail");
  await submit("Crear empresa");
  await page.getByRole("alert").filter({ hasText: "Ya existe una empresa con ese dominio" }).waitFor();
  expect(await page.locator("[name=industry]").inputValue() === "Retail", "el campo Sector se ha vaciado");
  expect(await page.getByLabel("Nombre *").inputValue() === "Duplicada", "el campo Nombre se ha vaciado");
});

await step("crear contacto eligiendo su empresa con el buscador", async () => {
  await page.goto(`/persons/new`);
  await page.getByLabel("Nombre", { exact: true }).fill("Lucía");
  await page.getByLabel("Apellidos").fill(`Pérez ${stamp}`);
  await page.getByLabel("Email principal").fill(`lucia.${stamp}@pruebaui${stamp}.com`);
  await page.getByRole("combobox", { name: "Empresa" }).fill(`Prueba UI ${stamp}`);
  await page.getByRole("option", { name: new RegExp(orgName) }).click();
  await page.getByLabel("Cargo").fill("CTO");
  await submit("Crear contacto");
  await page.waitForURL(/\/persons\/[0-9a-f-]{36}$/);
  await page.getByText(`CTO · `).first().waitFor();
});

await step("crear deal desde la ficha de la empresa (pipeline y fases dependientes)", async () => {
  await page.goto(`/organizations/${orgId}`);
  await page.getByRole("link", { name: "Nuevo deal" }).click();
  await page.waitForURL(/\/deals\/new/);
  await page.getByLabel("Título *").fill(`${orgName} — licencia`);
  await page.getByLabel("Pipeline *").selectOption({ label: "Outbound" });
  const stages = await page.getByLabel("Fase *").locator("option").allTextContents();
  expect(stages.includes("Primer contacto") && !stages.includes("Demo solicitada"), `fases: ${stages.join(", ")}`);
  await page.getByLabel("Pipeline *").selectOption({ label: "Inbound" });
  await page.getByLabel("Importe").fill("15000");
  await page.getByRole("combobox", { name: "Contacto principal" }).fill(`Lucía Pérez ${stamp}`);
  await page.getByRole("option", { name: new RegExp(`Lucía Pérez ${stamp}`) }).click();
  await submit("Crear deal");
  await page.waitForURL(/\/deals\/[0-9a-f-]{36}$/);
  dealId = page.url().split("/").pop();
  await page.getByText("Demo solicitada").first().waitFor();
  await shot("ficha-deal");
});

await step("mover de fase con la barra de fases", async () => {
  await page.getByRole("button", { name: "Demo realizada" }).click();
  await page.locator('.stagebar button[aria-current="step"]', { hasText: "Demo realizada" }).waitFor();
  const [d] = await sql`SELECT s.name FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ${dealId}`;
  expect(d?.name === "Demo realizada", d?.name);
});

await step("arrastrar el deal en el tablero a otra fase", async () => {
  await page.goto("/pipelines/10000000-0000-0000-0000-000000000001");
  const card = page.locator(".deal-card", { hasText: `${orgName} — licencia` });
  const target = page.locator(".stage", { has: page.getByRole("heading", { name: "Negociación" }) });
  await shot("tablero-antes");
  await card.dragTo(target.locator("ul"));
  await target.locator(".deal-card", { hasText: `${orgName} — licencia` }).waitFor();
  for (let i = 0; i < 20; i++) {
    const [d] = await sql`SELECT s.name FROM deals d JOIN stages s ON s.id = d.stage_id WHERE d.id = ${dealId}`;
    if (d?.name === "Negociación") return;
    await page.waitForTimeout(150);
  }
  throw new Error("la fase no se guardó en la base de datos");
});

await step("programar una demo y marcar que no se presentó", async () => {
  await page.goto(`/deals/${dealId}`);
  await page.getByRole("tab", { name: "Actividad", exact: true }).click();
  await page.getByLabel("Tipo").selectOption({ label: "Demo" });
  await page.getByLabel("Asunto").fill("Demo del producto");
  await page.getByLabel("Fecha y hora").fill("2026-12-01T10:30");
  await submit("Programar");
  const item = page.locator(".item", { hasText: "Demo del producto" });
  await item.waitFor();
  expect((await item.textContent()).includes("10:30"), `hora mostrada: ${await item.locator(".meta").first().textContent()}`);
  await item.getByText("Marcar como hecha").click();
  await item.getByLabel("Resultado").selectOption({ label: "No se presentó" });
  await item.getByRole("button", { name: "Guardar" }).click();
  await page.locator(".feed-item", { hasText: "no se presentó" }).first().waitFor();
});

await step("añadir una nota", async () => {
  await page.getByRole("tab", { name: "Nota", exact: true }).click();
  await page.getByLabel("Nota", { exact: true }).fill("Interesados en la integración con su ERP.");
  await submit("Guardar nota");
  await page.locator(".note-body", { hasText: "integración con su ERP" }).waitFor();
  expect(await page.getByLabel("Nota", { exact: true }).inputValue() === "", "la nota no se ha vaciado tras guardar");
});

await step("perder el deal con motivo programa el seguimiento", async () => {
  await page.locator("summary", { hasText: "Perdido" }).click();
  await page.getByLabel("Motivo *").selectOption({ label: "Sin presupuesto ahora (seguimiento a 90 días)" });
  await page.getByLabel("Comentario").fill("Vuelven a mirarlo el próximo año");
  await submit("Marcar como perdido");
  await page.getByText(/Sin presupuesto ahora\. Vuelven a mirarlo/).waitFor();
  const [t] = await sql`SELECT due_at::date - now()::date AS days FROM activities WHERE deal_id = ${dealId} AND subject LIKE 'Retomar contacto%'`;
  expect(t?.days === 90, `tarea de seguimiento a ${t?.days} días`);
});

await step("reabrir y ganar el deal", async () => {
  await submit("Reabrir");
  await page.getByRole("button", { name: "Ganado", exact: true }).click();
  await page.getByText(/Ganado el/).waitFor();
  const [d] = await sql`SELECT status, lost_reason_id FROM deals WHERE id = ${dealId}`;
  expect(d.status === "won" && d.lost_reason_id === null, JSON.stringify(d));
});

await step("crear un campo personalizado y usarlo en un deal", async () => {
  await page.goto("/settings/fields?entity=deal");
  await page.getByLabel("Nombre *").fill(`Prioridad ${stamp}`);
  await page.getByLabel("Tipo *").selectOption({ label: "Opción única" });
  await page.getByLabel(/Opciones \(solo/).fill("Alta\nMedia\nBaja");
  await submit("Crear campo");
  await page.locator(".item", { hasText: `Prioridad ${stamp}` }).waitFor();
  await page.goto(`/deals/${dealId}/edit`);
  await page.getByLabel(`Prioridad ${stamp}`).selectOption({ label: "Alta" });
  await submit("Guardar cambios");
  await page.waitForURL(new RegExp(`/deals/${dealId}$`));
  await page.locator("summary", { hasText: "Campos" }).click();
  await page.locator(".dl-row", { hasText: `Prioridad ${stamp}` }).getByText("Alta").waitFor();
});

await step("ajustes: añadir, reordenar y eliminar una fase", async () => {
  await page.goto("/settings/pipelines/10000000-0000-0000-0000-000000000002");
  const add = page.locator("form", { has: page.getByRole("button", { name: "Añadir" }) });
  await add.getByLabel("Nombre").fill(`Fase ${stamp}`);
  await add.getByRole("button", { name: "Añadir" }).click();
  const item = page.locator(".item", { hasText: `Fase ${stamp}` });
  await item.waitFor();
  await item.getByRole("button", { name: `Subir Fase ${stamp}` }).click();
  await page.waitForFunction((n) => [...document.querySelectorAll(".item strong")].map((e) => e.textContent).some((t) => t === `3. ${n}`), `Fase ${stamp}`);
  await item.getByText("Eliminar fase").click();
  await item.getByRole("button", { name: "Eliminar definitivamente" }).click();
  await item.waitFor({ state: "detached" });
});

await step("ajustes: no deja eliminar una fase con deals", async () => {
  await page.goto("/settings/pipelines/10000000-0000-0000-0000-000000000003");
  const item = page.locator(".item", { hasText: "Necesidad detectada" });
  await item.getByText("Eliminar fase").click();
  await item.getByRole("button", { name: "Eliminar definitivamente" }).click();
  await item.getByRole("alert").filter({ hasText: "Muévelos a otra fase" }).waitFor();
});

await step("crear un lead a mano y convertirlo en deal", async () => {
  await page.goto("/leads/new");
  await page.getByLabel("Email *").fill(`carlos.${stamp}@leadui${stamp}.com`);
  await page.getByLabel("Nombre").fill("Carlos");
  await page.getByLabel("Empresa", { exact: true }).fill(`Lead UI ${stamp}`);
  await page.getByLabel("Origen *").fill("evento");
  await page.getByLabel("Etapa").selectOption({ label: "MOFU" });
  await submit("Crear lead");
  await page.waitForURL(/\/leads\/[0-9a-f-]{36}$/);
  await shot("ficha-lead");
  await page.getByLabel("Importe").fill("3000");
  await submit("Crear deal");
  await page.waitForURL(/\/deals\/[0-9a-f-]{36}$/);
  await page.getByRole("link", { name: "evento" }).waitFor();
});

await step("cambio de empresa de un contacto conserva la anterior como antigua", async () => {
  await page.goto("/persons/70000000-0000-0000-0000-000000000001");
  await page.getByText("Cambio de empresa").click();
  await page.getByRole("combobox", { name: "Nueva empresa" }).fill(orgName);
  await page.getByRole("option", { name: new RegExp(orgName) }).click();
  await page.locator("form", { has: page.getByRole("combobox", { name: "Nueva empresa" }).or(page.getByText(orgName)) })
    .getByLabel("Cargo").fill("Directora Comercial");
  await submit("Guardar");
  await page.locator(".item", { hasText: "Paco S.L." }).getByText("Antigua").waitFor();
  await page.locator(".item", { hasText: orgName }).getByText("Directora Comercial").waitFor();
});

await step("crear un widget en un dashboard con vista previa", async () => {
  await page.goto("/dashboards");
  await page.waitForURL(/\/dashboards\/[0-9a-f-]{36}$/);
  await page.getByRole("link", { name: "Añadir widget" }).click();
  await page.getByLabel("Datos").selectOption({ label: "Leads" });
  await page.getByLabel("Métrica").selectOption({ label: "Número de leads" });
  await page.getByLabel("Agrupar por").selectOption({ label: "Origen" });
  await page.getByLabel("Periodo").selectOption({ label: "Todo el histórico" });
  await page.locator(".preview .bars li").first().waitFor();
  expect(await page.getByLabel("Título").inputValue() === "Número de leads por origen", `título sugerido: ${await page.getByLabel("Título").inputValue()}`);
  await page.getByLabel("Título").fill(`Leads por origen ${stamp}`);
  await page.getByLabel("Ancho").selectOption({ label: "Fila entera" });
  await submit("Añadir al dashboard");
  await page.waitForURL(/\/dashboards\/[0-9a-f-]{36}$/);
  const widget = page.locator(".widget", { hasText: `Leads por origen ${stamp}` });
  await widget.locator(".bars li").first().waitFor();
  await widget.getByRole("button", { name: "Ver tabla" }).click();
  await widget.locator(".widget-table td").first().waitFor();
  await shot("dashboard");
  await widget.getByLabel(`Opciones de Leads por origen ${stamp}`).click();
  await widget.getByRole("button", { name: "Eliminar" }).click();
  await widget.waitFor({ state: "detached" });
});

await step("cambiar a modo oscuro desde el menú de usuario y que se recuerde", async () => {
  await page.getByRole("button", { name: "Tu cuenta" }).click();
  await page.getByRole("menuitemradio", { name: "Oscuro" }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "no se aplicó el modo oscuro");
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme) === "dark", "el modo oscuro no se recuerda al recargar");
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg === "rgb(15, 19, 26)", `fondo en modo oscuro: ${bg}`);
  await shot("dashboard-oscuro");
  await page.getByRole("button", { name: "Tu cuenta" }).click();
  await page.getByRole("menuitemradio", { name: "Como el sistema" }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme) === undefined, "no volvió a seguir al sistema");
});

await step("buscador global: escribir, elegir con el teclado y abrir", async () => {
  await page.goto("/activities");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Paco S");
  await page.getByRole("option", { name: /Paco S\.L\./ }).first().waitFor();
  const opts = await page.getByRole("option").allTextContents();
  const idx = opts.findIndex((t) => t.startsWith("Paco S.L.") && t.includes("paco.example"));
  for (let i = 0; i < idx; i++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/organizations\/60000000-0000-0000-0000-000000000001$/);
});

await step("panel lateral: abrir desde el tablero, navegar y cerrar con Esc", async () => {
  await page.goto("/pipelines/10000000-0000-0000-0000-000000000001?sort=title");
  const first = page.locator(".deal-card .deal-title").first();
  const firstTitle = (await first.textContent()).trim();
  await first.click();
  const panel = page.locator(".deal-panel");
  await panel.getByRole("heading", { level: 1, name: firstTitle }).waitFor();
  expect(page.url().includes("deal="), "la URL no recoge el deal abierto");
  await shot("panel-deal");
  await panel.getByRole("link", { name: "Deal siguiente (J)" }).click();
  await page.waitForFunction((t) => document.querySelector(".deal-panel h1")?.textContent !== t, firstTitle);
  await page.keyboard.press("k");
  await panel.getByRole("heading", { level: 1, name: firstTitle }).waitFor();
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "detached" });
  expect(await page.locator(".board").isVisible(), "el tablero no sigue a la vista");
});

await step("vista de lista y ordenar por importe", async () => {
  await page.goto("/pipelines/10000000-0000-0000-0000-000000000001");
  await page.getByRole("button", { name: "Vista de lista" }).click();
  await page.waitForURL(/view=list/);
  await page.getByRole("link", { name: "Importe" }).click();
  await page.getByRole("link", { name: "Importe ↑" }).waitFor();
  const values = await page.locator("tbody tr td.num:nth-of-type(4)").allTextContents();
  const nums = values.map((v) => Number(v.replace(/[^0-9]/g, ""))).filter((n) => !Number.isNaN(n));
  expect(nums.every((n, i) => i === 0 || n >= nums[i - 1]), `no está ordenado: ${nums.slice(0, 6).join(", ")}`);
  await page.getByLabel("Estado").selectOption({ label: "Todos (también cerrados)" });
  await page.waitForURL(/status=all/);
  await page.locator(".badge.won").first().waitFor();
});

await step("selector de pipeline en la barra del tablero", async () => {
  await page.goto("/pipelines/10000000-0000-0000-0000-000000000001");
  await page.getByRole("button", { name: /Inbound/ }).click();
  await page.getByRole("menuitemradio", { name: "Ampliaciones" }).click();
  await page.waitForURL(/10000000-0000-0000-0000-000000000003/);
  await page.locator(".stage-head", { hasText: "Necesidad detectada" }).waitFor();
});

// ------------------------------------------------------------- IA: bandeja y autonomía
const PACO_OPEN = "90000000-0000-0000-0000-000000000002";

await step("bandeja: «Revisar ahora» trae las propuestas de la IA", async () => {
  await page.goto("/inbox");
  await submit("Revisar ahora");
  await page.locator("article.proposal", { hasText: "retomar «Paco — ampliación de servicio»" }).waitFor();
  await page.goto("/inbox");
  await page.locator(".rail-count").waitFor();
});

await step("bandeja: editar el borrador y marcarlo como enviado", async () => {
  await page.goto("/inbox");
  const card = page.locator("article.proposal", { hasText: "retomar «Paco — ampliación de servicio»" });
  await card.getByLabel("Asunto").fill(`Seguimiento ${stamp}`);
  expect((await card.getByRole("link", { name: "Abrir en el correo" }).getAttribute("href")).includes(`Seguimiento%20${stamp}`), "el enlace mailto no lleva el asunto editado");
  await card.getByRole("button", { name: "Marcar como enviado" }).click();
  await card.waitFor({ state: "detached" });
  const [a] = await sql`SELECT done, note FROM activities WHERE deal_id = ${PACO_OPEN} AND type = 'email' AND subject = ${`Seguimiento ${stamp}`}`;
  expect(a?.done && a.note.includes("ana@paco.example"), "no se registró el correo enviado en el deal");
});

await step("bandeja: descartar una propuesta", async () => {
  await page.goto("/inbox");
  const card = page.locator("article.proposal", { hasText: "Decide qué hacer" }).first();
  const title = (await card.locator("h3").textContent()).trim();
  await card.getByRole("button", { name: "Descartar" }).click();
  await page.locator("article.proposal", { has: page.getByRole("heading", { name: title, exact: true }) }).waitFor({ state: "detached" });
  const [x] = await sql`SELECT status FROM automation_actions WHERE title = ${title} ORDER BY created_at DESC LIMIT 1`;
  expect(x?.status === "dismissed", `estado ${x?.status}`);
});

await step("registro: deshacer una tarea que la IA creó sola", async () => {
  const [x] = await sql`SELECT id, title, result FROM automation_actions WHERE status = 'done' AND mode = 'auto' AND action_type = 'create_task'
                        ORDER BY executed_at DESC LIMIT 1`;
  expect(x, "no hay tareas hechas solas");
  await page.goto("/inbox?view=log");
  const row = page.locator("tr", { hasText: x.title }).first();
  await row.getByRole("button", { name: "Deshacer" }).click();
  await row.getByText("Deshecha").waitFor();
  const [after] = await sql`SELECT status FROM automation_actions WHERE id = ${x.id}`;
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM activities WHERE id = ${x.result.activity_id}`;
  expect(after.status === "undone" && n === 0, `estado ${after.status}, tarea ${n}`);
});

await step("panel del deal: muestra y resuelve sus propuestas", async () => {
  const [x] = await sql`SELECT deal_id, title FROM automation_actions WHERE status = 'pending' AND action_type = 'notify' LIMIT 1`;
  expect(x, "no hay propuestas pendientes");
  await page.goto(`/deals/${x.deal_id}`);
  const section = page.getByRole("region", { name: "Propuestas de la IA" });
  await section.getByRole("heading", { name: x.title }).waitFor();
  await section.getByRole("button", { name: "Entendido" }).click();
  await section.waitFor({ state: "detached" });
});

await step("autonomía: limitar un permiso se refleja en las reglas", async () => {
  await page.goto("/settings/automations");
  const group = page.getByRole("group", { name: "Crear tareas — Asistente del CRM" });
  await group.getByRole("button", { name: "Preguntar" }).click();
  await group.locator('button[aria-pressed="true"]', { hasText: "Preguntar" }).waitFor();
  await page.getByRole("article", { name: "Fase sin su sesión agendada" }).getByText("Limitada a «Preguntar»").waitFor();
  await shot("autonomia");
  await group.getByRole("button", { name: "Sola" }).click();
  await group.locator('button[aria-pressed="true"]', { hasText: "Sola" }).waitFor();
  const [p] = await sql`SELECT autonomy FROM ai_permissions WHERE actor = 'assistant' AND action_type = 'create_task'`;
  expect(p.autonomy === "auto", p.autonomy);
});

await step("autonomía: sin correo conectado, un correo no puede salir solo", async () => {
  await page.goto("/settings/automations");
  const btn = page.getByRole("group", { name: "Enviar correos — Asistente del CRM" }).getByRole("button", { name: "Sola" });
  expect(await btn.isDisabled(), "el botón «Sola» de correos debería estar desactivado");
});

await step("reglas: cambiar la autonomía y la plantilla del correo", async () => {
  await page.goto("/settings/automations");
  const group = page.getByRole("group", { name: "Autonomía: Deal muy parado: pedir una decisión" });
  await group.getByRole("button", { name: "No", exact: true }).click();
  await group.locator('button[aria-pressed="true"]', { hasText: "No" }).waitFor();
  const rule = page.getByRole("article", { name: "Deal parado: escribir al contacto" });
  await rule.getByText("Ajustes de la regla").click();
  await rule.getByLabel("Asunto").fill(`Retomamos {deal} ${stamp}`);
  await rule.getByRole("button", { name: "Guardar" }).click();
  await page.waitForTimeout(400);
  const rows = await sql`SELECT key, autonomy, params FROM automation_rules WHERE key IN ('stale_deal_escalate', 'stale_deal_followup')`;
  const esc = rows.find((r) => r.key === "stale_deal_escalate"), fol = rows.find((r) => r.key === "stale_deal_followup");
  expect(esc.autonomy === "off" && fol.params.subject === `Retomamos {deal} ${stamp}`, JSON.stringify(rows.map((r) => [r.key, r.autonomy, r.params.subject])));
  await sql`UPDATE automation_rules SET autonomy = 'ask' WHERE key = 'stale_deal_escalate'`;
});

await step("pausar y reanudar la IA", async () => {
  await page.goto("/settings/automations");
  await submit("Pausar todo");
  await page.getByRole("heading", { name: "La IA está en pausa" }).waitFor();
  await page.goto("/inbox");
  await page.getByText("La IA está en pausa").waitFor();
  await page.getByRole("button", { name: "Reanudar" }).click();
  await page.getByText("La IA está en pausa").waitFor({ state: "detached" });
});

// ------------------------------------------------------------- Correo y calendario (Microsoft simulado)
const MOCK = process.env.MOCK_URL;
const mockState = async () => (await fetch(`${MOCK}/__state`)).json();

if (MOCK) {
  await step("conectar Microsoft 365 desde Ajustes", async () => {
    const [{ owner_id }] = await sql`SELECT owner_id FROM deals WHERE id = ${PACO_OPEN}`;
    const [u] = await sql`SELECT name FROM users WHERE id = ${owner_id}`;
    await page.goto("/settings/mailbox");
    await page.getByRole("article", { name: `Cuenta de ${u.name}` }).getByRole("link", { name: "Conectar Microsoft 365" }).click();
    await page.waitForURL(/\/settings\/mailbox\?connected=/);
    await page.getByText("Cuenta conectada: jesus@aikit.example").waitFor();
    await page.getByRole("article", { name: `Cuenta de ${u.name}` }).locator(".slots-preview").filter({ hasText: "(hora de Madrid)" }).waitFor();
    await shot("correo");
  });

  await step("preferencias de huecos: quitar el viernes", async () => {
    await page.goto("/settings/mailbox");
    const card = page.locator("article.mailbox", { has: page.getByText("jesus@aikit.example") });
    await card.getByLabel("Vie").uncheck();
    await card.getByRole("button", { name: "Guardar preferencias" }).click();
    await page.waitForTimeout(500);
    const [c] = await sql`SELECT scheduling FROM mailbox_connections`;
    expect(c.scheduling.days.join() === "1,2,3,4", c.scheduling.days.join());
  });

  await step("escribir desde el deal con mis huecos y enviarlo por Outlook", async () => {
    await page.goto(`/deals/${PACO_OPEN}`);
    await page.getByRole("tab", { name: "Correo", exact: true }).click();
    const form = page.locator(".composer form", { has: page.getByRole("button", { name: "Insertar mis huecos" }) });
    await form.getByLabel("Asunto").fill(`Huecos ${stamp}`);
    await form.getByRole("button", { name: "Insertar mis huecos" }).click();
    await page.waitForFunction(() => document.querySelector(".composer textarea[name=body]")?.value.includes("(hora de Madrid)"));
    await form.getByRole("button", { name: "Enviar desde Outlook" }).click();
    await page.getByText(`Email: Huecos ${stamp}`).waitFor();
    const st = await mockState();
    const m = st.sent.find((x) => x.subject === `Huecos ${stamp}`);
    expect(m && m.body.content.includes("(hora de Madrid)") && m.toRecipients[0].emailAddress.address === "ana@paco.example", "no salió por Outlook");
  });

  await step("bandeja: la IA ofrece huecos y se envía desde Outlook", async () => {
    await page.goto("/inbox");
    await submit("Revisar ahora");
    const card = page.locator("article.proposal", { hasText: "Ofrecer huecos a Ana García" });
    await card.waitFor();
    const subject = await card.getByLabel("Asunto").inputValue();
    expect((await card.getByLabel("Texto").inputValue()).includes("(hora de Madrid)"), "el borrador no lleva los huecos");
    await card.getByRole("button", { name: "Enviar desde mi correo" }).click();
    await card.waitFor({ state: "detached" });
    expect((await mockState()).sent.some((x) => x.subject === subject), "no salió por Outlook");
  });

  await step("documentos: buscar en OneDrive y enlazar al deal", async () => {
    await page.goto(`/deals/${PACO_OPEN}`);
    const docs = page.getByRole("region", { name: "Documentos" });
    await docs.getByText("+ Enlazar documento").click();
    await docs.getByLabel("Buscar en OneDrive / SharePoint").fill("paco");
    const results = docs.getByRole("list", { name: "Archivos encontrados" });
    await results.getByText("Presentación Paco.pptx").waitFor();
    expect(await results.getByText("Paco (carpeta)").count() === 0, "las carpetas no deberían salir");
    await results.locator("li", { hasText: "Presentación Paco.pptx" }).getByRole("button", { name: "Enlazar" }).click();
    await docs.getByRole("link", { name: "Presentación Paco.pptx" }).waitFor();
    const [d] = await sql`SELECT source, external_id, url FROM deal_documents WHERE deal_id = ${PACO_OPEN} AND title = 'Presentación Paco.pptx'`;
    expect(d?.source === "microsoft" && d.external_id === "mf1", JSON.stringify(d));
    expect((await docs.locator(".doc-list li", { hasText: "Presentación Paco.pptx" }).textContent()).includes("Presentación ·"), "falta el tipo");
  });

  await step("documentos: pegar un enlace, no duplicar y quitar", async () => {
    await page.goto(`/deals/${PACO_OPEN}`);
    const docs = page.getByRole("region", { name: "Documentos" });
    await docs.getByText("+ Enlazar documento").click();
    const form = docs.locator("form", { has: page.locator("input[name=url][type=url]") });
    await form.locator("input[name=url]").fill(`https://example.com/propuestas/propuesta-${stamp}.pdf`);
    await form.getByRole("button", { name: "Enlazar" }).click();
    const link = docs.getByRole("link", { name: `propuesta-${stamp}.pdf` });
    await link.waitFor();
    await form.locator("input[name=url]").fill(`https://example.com/propuestas/propuesta-${stamp}.pdf`);
    await form.getByRole("button", { name: "Enlazar" }).click();
    await form.getByRole("alert").filter({ hasText: "ya está enlazado" }).waitFor();
    await docs.locator(".doc-list li", { hasText: `propuesta-${stamp}.pdf` }).getByRole("button", { name: "Quitar" }).click();
    await link.waitFor({ state: "detached" });
  });

  await step("conectar Google Workspace para otra persona", async () => {
    await page.goto("/settings/mailbox");
    const card = page.locator("article.mailbox", { has: page.getByRole("link", { name: "Conectar Google Workspace" }) }).first();
    const name = (await card.getAttribute("aria-label")).replace("Cuenta de ", "");
    await card.getByRole("link", { name: "Conectar Google Workspace" }).click();
    await page.waitForURL(/connected=jesus%40empresa-google\.example/);
    await page.getByRole("article", { name: `Cuenta de ${name}` }).getByText("Google Workspace · jesus@empresa-google.example").waitFor();
  });

  await step("programar una demo invitando desde el calendario", async () => {
    await page.goto(`/deals/${PACO_OPEN}`);
    await page.getByRole("tab", { name: "Actividad", exact: true }).click();
    const form = page.locator("form", { has: page.getByRole("button", { name: "Programar" }) });
    await form.locator("select[name=type]").selectOption("demo");
    await form.locator("input[name=subject]").fill(`Demo ${stamp}`);
    const d = new Date(Date.now() + 3 * 86400000);
    const pad = (n) => String(n).padStart(2, "0");
    await form.locator("input[name=due_at]").fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T16:00`);
    await form.getByLabel(/Invitar a Ana García desde mi calendario/).check();
    await submit("Programar");
    await page.locator(".item", { hasText: `Demo ${stamp}` }).waitFor();
    const ev = (await mockState()).events.find((e) => e.subject === `Demo ${stamp}`);
    const [a] = await sql`SELECT external_ref, meeting_url FROM activities WHERE subject = ${`Demo ${stamp}`}`;
    expect(ev && ev.isOnlineMeeting && ev.attendees[0].emailAddress.address === "ana@paco.example", "no se creó el evento con Teams");
    expect(a.external_ref === `evt:${ev.id}` && a.meeting_url?.includes("teams.example"), JSON.stringify(a));
  });
}

// ------------------------------------------------------------- Hoy, resúmenes y modelo de IA
await step("Hoy: el parte del día con deals que piden atención", async () => {
  await page.goto("/");
  await page.getByRole("heading", { name: /^Buen(os|as) / }).waitFor();
  await page.getByRole("region", { name: "Enfoque del día" }).waitFor();
  const att = page.getByRole("region", { name: "Deals que piden atención" });
  const first = att.locator(".attention-title").first();
  const title = (await first.textContent()).trim();
  await first.click();
  await page.getByRole("heading", { name: title, level: 1 }).waitFor();
});

await step("ficha del deal: resumen con el siguiente paso", async () => {
  await page.goto(`/deals/${PACO_OPEN}`);
  const brief = page.getByRole("region", { name: "Resumen del deal" });
  await brief.getByText("Siguiente paso").waitFor();
});

if (MOCK) {
  await step("configurar el modelo de IA y probar la conexión", async () => {
    await page.goto("/settings/ai");
    await page.locator("select[name=provider]").selectOption("compatible");
    await page.locator("input[name=model]").fill("modelo-de-pruebas");
    await page.locator("input[name=api_key]").fill("clave-llm-de-pruebas");
    await page.locator("input[name=base_url]").fill(`${MOCK}/llm/openai`);
    await submit("Guardar");
    await page.getByRole("heading", { name: /^Activo: Otro compatible/ }).waitFor();
    await submit("Probar conexión");
    await page.getByText("Última respuesta correcta").waitFor();
    const [a] = await sql`SELECT provider, api_key FROM ai_settings`;
    expect(a.provider === "compatible" && a.api_key.startsWith("v1.") && !a.api_key.includes("clave-llm"), "la clave no se guardó cifrada");
  });

  await step("resumen del deal redactado por la IA", async () => {
    await page.goto(`/deals/${PACO_OPEN}`);
    const brief = page.getByRole("region", { name: "Resumen del deal" });
    await brief.getByRole("button", { name: /Redactar con IA|Actualizar/ }).click();
    await brief.getByText("(IA) Llama a Ana para cerrar fecha").waitFor();
    await brief.getByText(/Redactado por la IA/).waitFor();
  });

  await step("reunión celebrada con transcripción: la IA prepara el resumen para el cliente", async () => {
    await page.goto(`/deals/${PACO_OPEN}`);
    const item = page.locator(".item", { hasText: `Demo ${stamp}` });
    await item.getByText("Marcar como hecha").click();
    await item.locator("select[name=outcome]").selectOption("held");
    await item.locator("textarea[name=transcript]").fill("Ana: nos encaja la propuesta, revisad los plazos.");
    await item.getByRole("button", { name: "Guardar" }).click();
    await item.waitFor({ state: "detached" });
    await page.goto("/inbox");
    await submit("Revisar ahora");
    const card = page.locator("article.proposal", { hasText: "Enviar el resumen de la demo" });
    await card.waitFor();
    expect((await card.getByLabel("Texto").inputValue()).includes("(IA) Repasamos la propuesta"), "el correo no lleva el resumen de la IA");
    await shot("bandeja-resumen");
  });

  await step("parte del día: ajustes y enfoque redactado por la IA", async () => {
    await page.goto("/settings/automations");
    const digest = page.getByRole("region", { name: "Parte del día" });
    await digest.locator("select[name=hour]").selectOption("7");
    await digest.getByRole("button", { name: "Guardar" }).click();
    await page.waitForTimeout(400);
    const [d] = await sql`SELECT digest_hour FROM automation_settings`;
    expect(d.digest_hour === 7, `hora ${d.digest_hour}`);
    await page.goto("/");
    await page.getByRole("region", { name: "Enfoque del día" }).getByRole("button", { name: /con IA/ }).click();
    await page.getByText("(IA) Hoy, primero responde a Ana").waitFor();
    await shot("hoy");
  });
}

await step("tablero: las tarjetas marcan las propuestas de la IA pendientes", async () => {
  await page.goto("/pipelines/10000000-0000-0000-0000-000000000003");
  const card = page.locator(".deal-card", { hasText: "Paco — ampliación de servicio" });
  await card.waitFor();
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM automation_actions WHERE deal_id = ${PACO_OPEN} AND status = 'pending'`;
  if (n > 0) await card.locator(".badge.ai").filter({ hasText: String(n) }).waitFor();
});

await step("Customer Success: dirección por defecto y responsable por empresa", async () => {
  await page.goto("/settings/automations");
  const rule = page.getByRole("article", { name: "Deal ganado: enviar el resumen a Customer Success" });
  await rule.getByText("Falta el email de Customer Success por defecto").waitFor();
  await rule.getByText("Ajustes de la regla").click();
  await rule.getByLabel("Email de Customer Success por defecto").fill("cs@aikit.example");
  await rule.getByRole("button", { name: "Guardar" }).click();
  await rule.getByText("Falta el email de Customer Success por defecto").waitFor({ state: "detached" });
  const [r] = await sql`SELECT params FROM automation_rules WHERE key = 'won_handoff_email'`;
  expect(r.params.cs_email === "cs@aikit.example", JSON.stringify(r.params));
  await page.goto("/organizations/60000000-0000-0000-0000-000000000001/edit");
  await page.getByLabel("Responsable de CS").fill("Lucía CS");
  await page.getByLabel("Email del responsable de CS").fill("lucia@aikit.example");
  await submit("Guardar cambios");
  await page.waitForURL(/\/organizations\/60000000-0000-0000-0000-000000000001$/);
  await page.getByText("lucia@aikit.example").waitFor();
});

await step("ganar un deal deja en la bandeja el correo de traspaso a su responsable de CS", async () => {
  await page.goto(`/deals/${PACO_OPEN}`);
  await submit("Ganado");
  await page.getByText(/^Ganado el/).waitFor();
  await page.goto("/inbox");
  await submit("Revisar ahora");
  const card = page.locator("article.proposal", { hasText: "Enviar el traspaso de «Paco — ampliación de servicio» a Customer Success" });
  await card.waitFor();
  expect(await card.getByLabel("Para").inputValue() === "lucia@aikit.example", "destinatario incorrecto");
  expect((await card.getByLabel("Texto").inputValue()).startsWith("Hola Lucía CS"), "saludo incorrecto");
  await shot("traspaso-cs");
});

await step("capturas de las pantallas principales", async () => {
  for (const [name, path] of [["tablero", "/pipelines/10000000-0000-0000-0000-000000000001"], ["empresa", "/organizations/60000000-0000-0000-0000-000000000001"],
                              ["leads", "/leads?status=all"], ["actividades", "/activities"], ["contacto", "/persons/70000000-0000-0000-0000-000000000001"],
                              ["bandeja", "/inbox"], ["registro", "/inbox?view=log"], ["ia", "/settings/automations"], ["correo-ajustes", "/settings/mailbox"], ["ia-modelo", "/settings/ai"], ["deal", `/deals/${PACO_OPEN}`]]) {
    await page.goto(path);
    await shot(name);
  }
});

await step("sin errores de JavaScript en el navegador", async () => {
  expect(errors.length === 0, errors.slice(0, 3).join(" | "));
});

await browser.close();
await sql.end();
console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} correctas, ${failed} fallidas`);
process.exit(failed === 0 ? 0 : 1);
