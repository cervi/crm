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

await step("capturas de las pantallas principales", async () => {
  for (const [name, path] of [["tablero", "/pipelines/10000000-0000-0000-0000-000000000001"], ["empresa", "/organizations/60000000-0000-0000-0000-000000000001"],
                              ["leads", "/leads?status=all"], ["actividades", "/activities"], ["contacto", "/persons/70000000-0000-0000-0000-000000000001"]]) {
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
