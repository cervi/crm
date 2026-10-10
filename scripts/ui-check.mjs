#!/usr/bin/env node
// Pruebas de interfaz con navegador (Playwright) contra la app en marcha con
// los datos de ejemplo: los flujos que una persona hace a mano.
//
//   BASE_URL=... DATABASE_URL=... node scripts/ui-check.mjs
//
// Requiere Playwright con Chromium (no es dependencia del proyecto):
//   npm i -D playwright && npx playwright install chromium
// Opcional: SCREENSHOTS=carpeta guarda capturas de las pantallas principales.
import { createRequire } from "node:module";
import postgres from "postgres";
import { hashPassword } from "./password.mjs";

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
});
context.setDefaultTimeout(Number(process.env.UI_TIMEOUT ?? 8000));
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const submit = (label) => page.getByRole("button", { name: label, exact: true }).click();

// Acceso: el administrador de los datos de ejemplo entra con su contraseña.
const ADMIN = { email: "ventas@example.com", password: "contraseña-de-pruebas-ui" };
await sql`UPDATE users SET password_hash = ${hashPassword(ADMIN.password)}, must_change_password = false, failed_logins = 0, locked_until = NULL
          WHERE lower(email) = ${ADMIN.email}`;

await step("sin sesión se pide entrar; con la contraseña mal no entra; bien, vuelve a donde iba", async () => {
  await page.goto("/pipelines?view=list");
  await page.waitForURL(/\/login\?next=/);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Contraseña").fill("no-es-esta-contraseña");
  await submit("Entrar");
  await page.getByRole("alert").filter({ hasText: "Email o contraseña incorrectos" }).waitFor();
  await page.getByLabel("Contraseña").fill(ADMIN.password);
  await submit("Entrar");
  await page.waitForURL(/\/pipelines\/[0-9a-f-]{36}\?view=list|\/pipelines\?view=list/);
  await page.getByRole("button", { name: /Tu cuenta \(Gestor de cuentas\)/ }).waitFor();
});

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
  const composer = page.locator(".composer form", { has: page.getByRole("button", { name: "Programar" }) });
  await composer.getByLabel("Tipo").selectOption({ label: "Demo" });
  await composer.getByLabel("Asunto").fill("Demo del producto");
  await composer.getByLabel("Fecha y hora").fill("2026-12-01T10:30");
  await composer.getByRole("button", { name: "Programar" }).click();
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
  await page.waitForLoadState("networkidle");
  await page.keyboard.press("Control+k");
  if (!(await page.evaluate(() => document.activeElement?.matches("input[type=search], [role=combobox]")))) {
    await page.getByPlaceholder(/Buscar deals/).click(); // si el atajo llegó antes de que la página estuviera lista
  }
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
  const card = section.getByRole("article", { name: x.title });
  await card.getByRole("button", { name: "Entendido" }).click();
  await section.getByRole("heading", { name: x.title }).waitFor({ state: "detached" });
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

  await step("correo con plantilla, programado para mañana y cancelado", async () => {
    await page.goto(`/deals/${PACO_OPEN}`);
    await page.getByRole("tab", { name: "Correo", exact: true }).click();
    const form = page.locator(".composer form", { has: page.getByRole("button", { name: "Insertar mis huecos" }) });
    await form.getByLabel("Plantilla").selectOption({ label: "Envío de propuesta" });
    expect((await form.getByLabel("Asunto").inputValue()) === "Propuesta para Paco S.L.", `asunto: ${await form.getByLabel("Asunto").inputValue()}`);
    expect((await form.locator("textarea[name=body]").inputValue()).startsWith("Hola Ana,"), "la plantilla no rellenó el nombre");
    await form.getByLabel("Programar el envío").check();
    const tomorrow = new Date(Date.now() + 86400000);
    const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 11) + "10:00";
    await form.getByLabel("Enviar el").fill(local);
    await form.getByRole("button", { name: "Enviar desde Outlook" }).click();
    const item = page.locator(".email-item", { hasText: "Propuesta para Paco S.L." });
    await item.getByText("Programado").waitFor();
    expect((await form.getByLabel("Asunto").inputValue()) === "", "el formulario no se vació");
    await shot("correo-programado");
    await item.locator("summary").click();
    await item.getByRole("button", { name: "Cancelar el envío" }).click();
    await item.waitFor({ state: "detached" });
    const [e] = await sql`SELECT status FROM emails WHERE subject = 'Propuesta para Paco S.L.' ORDER BY created_at DESC LIMIT 1`;
    expect(e?.status === "cancelled", `estado: ${e?.status}`);
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

  await step("enlace de reserva: un contacto nuevo elige hueco y queda con su deal y la invitación", async () => {
    await page.goto("/settings/booking");
    await page.getByLabel("Dirección").fill(`gestor-${stamp}`);
    await page.getByLabel("Título").fill("Charla de 30 minutos");
    await submit("Guardar");
    const link = page.getByRole("link", { name: new RegExp(`/book/gestor-${stamp}$`) });
    await link.waitFor();
    // Quien reserva no tiene sesión en el CRM.
    const visitor = await browser.newContext({ baseURL: BASE, locale: "es-ES" });
    const v = await visitor.newPage();
    v.on("pageerror", (e) => errors.push(e.message));
    await v.goto(`/book/gestor-${stamp}`);
    await v.getByRole("heading", { name: "Charla de 30 minutos" }).waitFor();
    await v.locator(".booking-slots .slot").first().click();
    await v.getByLabel("Tu nombre").fill(`Marta Reserva ${stamp}`);
    await v.getByLabel("Tu email").fill(`marta.${stamp}@cliente-reserva.example`);
    await v.getByLabel("Empresa").fill(`Cliente Reserva ${stamp}`);
    await v.getByRole("button", { name: "Reservar" }).click();
    await v.getByRole("heading", { name: "¡Reserva confirmada!" }).waitFor();
    if (SHOTS) await v.screenshot({ path: `${SHOTS}/reserva.png`, fullPage: true });
    await visitor.close();
    const [a] = await sql`SELECT a.deal_id, a.subject, d.owner_id FROM activities a JOIN deals d ON d.id = a.deal_id
                          WHERE a.booked_via IS NOT NULL AND a.subject = ${`Charla de 30 minutos con Marta Reserva ${stamp}`}`;
    expect(a?.deal_id && a.owner_id, "la reserva no quedó en un deal con responsable");
    const ev = (await mockState()).events.find((e) => e.subject === `Charla de 30 minutos con Marta Reserva ${stamp}`);
    expect(ev?.attendees?.some((x) => x.emailAddress.address === `marta.${stamp}@cliente-reserva.example`), "no se creó la invitación en el calendario");
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
    const form = page.locator(".composer form", { has: page.getByRole("button", { name: "Programar" }) });
    await form.locator("select[name=type]").selectOption("demo");
    await form.locator("input[name=subject]").fill(`Demo ${stamp}`);
    const d = new Date(Date.now() + 3 * 86400000);
    const pad = (n) => String(n).padStart(2, "0");
    await form.locator("input[name=due_at]").fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T16:00`);
    await form.getByLabel(/Invitar a Ana García desde mi calendario/).check();
    await form.getByRole("button", { name: "Programar" }).click();
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
  const plan = brief.locator(".step-plan");
  expect(!(await plan.isVisible()), "los detalles no deberían verse sin pasar el ratón");
  await brief.locator(".brief-next").hover();
  await plan.getByText("Quién").waitFor();
  await shot("siguiente-paso");
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

await step("tipos de actividad: crear uno nuevo y usarlo en un deal", async () => {
  await page.goto("/settings/activity-types");
  const add = page.locator("form", { has: page.getByRole("button", { name: "Añadir tipo" }) });
  await add.getByLabel("Nombre").fill("Onboarding");
  await add.getByLabel("Sesión con el cliente").check();
  await add.getByRole("button", { name: "Añadir tipo" }).click();
  await page.getByRole("listitem", { name: "Tipo Onboarding" }).waitFor();
  await page.goto(`/deals/${PACO_OPEN}`);
  await page.getByRole("tab", { name: "Actividad", exact: true }).click();
  const form = page.locator(".composer form", { has: page.getByRole("button", { name: "Programar" }) });
  await form.locator("select[name=type]").selectOption("onboarding");
  await form.locator("input[name=subject]").fill(`Onboarding ${stamp}`);
  await form.getByRole("button", { name: "Programar" }).click();
  await page.locator(".item", { hasText: `Onboarding ${stamp}` }).waitFor();
});

await step("regla personalizada: al hacer el onboarding, la IA crea la tarea siguiente sola", async () => {
  await page.goto("/settings/automations#reglas-personalizadas");
  const card = page.getByRole("article", { name: "Nueva regla" });
  await card.getByLabel("Nombre de la regla").fill(`Tras el onboarding ${stamp}`);
  await card.locator("select[name=trigger_type]").selectOption("onboarding");
  await card.locator("select[name=trigger_kind]").selectOption("activity_done");
  await card.locator("select[name=trigger_outcome]").selectOption("held");
  await card.locator("select[name=action_kind]").selectOption("create_activity");
  await card.locator("select[name=action_type]").selectOption("task");
  await card.locator("input[name=action_subject]").fill("Enviar el resumen del onboarding a {nombre}");
  await card.locator("input[name=action_due_days]").fill("1");
  await card.locator("select[name=autonomy]").selectOption("auto");
  await card.getByRole("button", { name: "Crear regla" }).click();
  const rule = page.getByRole("article", { name: `Tras el onboarding ${stamp}` });
  await rule.getByText(/Cuando una actividad «Onboarding» de un deal se marca como hecha con resultado «Realizada»/).waitFor();

  await page.goto(`/deals/${PACO_OPEN}`);
  const item = page.locator(".item", { hasText: `Onboarding ${stamp}` });
  await item.getByText("Marcar como hecha").click();
  await item.locator("select[name=outcome]").selectOption("held");
  await item.getByRole("button", { name: "Guardar" }).click();
  await item.waitFor({ state: "detached" });
  await page.goto("/inbox");
  await submit("Revisar ahora");
  await page.waitForTimeout(500);
  const [t] = await sql`SELECT a.subject, a.created_by_id FROM activities a WHERE a.deal_id = ${PACO_OPEN} AND a.subject = 'Enviar el resumen del onboarding a Ana'`;
  expect(t?.created_by_id === "00000000-0000-0000-0000-0000000000a1", "la tarea no la creó la IA");
  await page.goto(`/deals/${PACO_OPEN}`);
  await page.locator(".item", { hasText: "Enviar el resumen del onboarding a Ana" }).waitFor();
  await shot("reglas-personalizadas");
});

await step("Customer Success: dirección por defecto y responsable por empresa", async () => {
  await page.goto("/settings/automations");
  const rule = page.getByRole("article", { name: "Deal ganado: enviar el resumen a Customer Success" });
  await rule.getByText("Falta el email de Customer Success por defecto").waitFor();
  await rule.getByText("Ajustes de la regla", { exact: true }).click();
  await rule.getByLabel("Email de Customer Success por defecto").fill("cs@aikit.example");
  await rule.getByRole("button", { name: "Guardar" }).click();
  await rule.getByText("Falta el email de Customer Success por defecto").waitFor({ state: "detached" });
  const [r] = await sql`SELECT params FROM automation_rules WHERE key = 'won_handoff_email'`;
  expect(r.params.cs_email === "cs@aikit.example", JSON.stringify(r.params));
  await page.goto("/organizations/60000000-0000-0000-0000-000000000001/edit");
  await page.getByLabel("Responsable de CS", { exact: true }).fill("Lucía CS");
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
  expect(await card.getByLabel("Para", { exact: true }).inputValue() === "lucia@aikit.example", "destinatario incorrecto");
  expect((await card.getByLabel("Texto").inputValue()).startsWith("Hola Lucía CS"), "saludo incorrecto");
  await shot("traspaso-cs");
});

await step("exportar contactos a CSV desde el listado y cambiar el separador", async () => {
  await page.goto("/persons?q=ana");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Exportar CSV" }).click()]);
  expect(/^contactos-\d{4}-\d{2}-\d{2}\.csv$/.test(download.suggestedFilename()), download.suggestedFilename());
  const fs = await import("node:fs/promises");
  const text = await fs.readFile(await download.path(), "utf8");
  expect(text.startsWith("﻿Nombre completo;") && text.includes("ana@paco.example"), text.slice(0, 80));
  await page.goto("/settings/export");
  await page.locator("select[name=separator]").selectOption(",");
  await submit("Guardar");
  await page.waitForTimeout(400);
  const [d2] = await Promise.all([page.waitForEvent("download"), page.locator(".export-list li", { hasText: "Empresas" }).getByRole("link").click()]);
  const t2 = await fs.readFile(await d2.path(), "utf8");
  expect(t2.startsWith("﻿Empresa,Dominio,"), t2.slice(0, 40));
  await sql`UPDATE app_settings SET csv_separator = ';'`;
});

if (MOCK) {
  await step("importar desde Pipedrive desde la pantalla, con progreso y comprobación", async () => {
    await page.goto("/settings/import");
    await page.locator("input[name=token]").fill("token-pipedrive-de-pruebas-0123456789");
    await submit("Conectar");
    await page.getByRole("heading", { name: "Conectado a Aikit (simulado)" }).waitFor();
    await submit("Importar todo");
    await page.getByRole("region", { name: "Resultado de la importación" }).waitFor({ timeout: 60_000 });
    await page.getByText("No cuadra").waitFor();
    const [{ paused }] = await sql`SELECT paused FROM automation_settings`;
    expect(paused, "la IA debería quedar en pausa tras la importación");
    await page.getByRole("button", { name: "Reanudarla" }).click();
    await page.getByRole("button", { name: "Reanudarla" }).waitFor({ state: "detached" });
    await shot("importacion");
    await page.goto("/pipelines");
    const [pl] = await sql`SELECT id FROM pipelines WHERE name = 'Ventas PD'`;
    await page.goto(`/pipelines/${pl.id}`);
    await page.locator(".deal-card", { hasText: "Acme — licencias" }).waitFor();
  });
}

await step("capturas de las pantallas principales", async () => {
  for (const [name, path] of [["tablero", "/pipelines/10000000-0000-0000-0000-000000000001"], ["empresa", "/organizations/60000000-0000-0000-0000-000000000001"],
                              ["leads", "/leads?status=all"], ["actividades", "/activities"], ["contacto", "/persons/70000000-0000-0000-0000-000000000001"],
                              ["bandeja", "/inbox"], ["registro", "/inbox?view=log"], ["ia", "/settings/automations"], ["correo-ajustes", "/settings/mailbox"], ["ia-modelo", "/settings/ai"], ["deal", `/deals/${PACO_OPEN}`]]) {
    await page.goto(path);
    await shot(name);
  }
});

await step("lista de deals: filtrar, guardar la vista y cambiar el responsable de varios a la vez", async () => {
  const inbound = "10000000-0000-0000-0000-000000000001";
  await page.goto(`/pipelines/${inbound}?view=list&status=all`);
  await page.getByLabel("Buscar en la lista").fill("Paco");
  await page.getByRole("button", { name: "Filtrar", exact: true }).click();
  await page.waitForURL(/q=Paco/);
  await page.getByText("+ Guardar esta vista").click();
  await page.getByLabel("Nombre", { exact: true }).fill(`Deals de Paco ${stamp}`);
  await page.getByRole("button", { name: "Guardar vista" }).click();
  await page.getByRole("link", { name: new RegExp(`Deals de Paco ${stamp}`) }).waitFor();
  // Columnas: se añade «Creado».
  await page.getByRole("button", { name: "Columnas" }).click();
  await page.getByRole("dialog", { name: "Columnas" }).getByLabel("Creado").check();
  await page.getByRole("button", { name: "Aplicar", exact: true }).click();
  await page.waitForURL(/cols=/);
  await page.locator("thead th", { hasText: "Creado" }).waitFor();
  // Acción en bloque.
  await page.getByLabel("Seleccionar Paco — contrato anual").check();
  await page.getByLabel("Seleccionar Paco — otra plataforma").check();
  const bar = page.getByRole("region", { name: "Acciones en bloque" });
  await bar.getByText("2 seleccionados").waitFor();
  await bar.getByLabel("Acción").selectOption("owner");
  await bar.getByLabel("Nuevo responsable").selectOption({ label: "Customer Success" });
  await bar.getByRole("button", { name: "Aplicar" }).click();
  await bar.getByText("2 deals actualizados").waitFor();
  const owners = await sql`SELECT DISTINCT u.name FROM deals d JOIN users u ON u.id = d.owner_id
                           WHERE d.id IN ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000003')`;
  expect(owners.length === 1 && owners[0].name === "Customer Success", `responsables: ${owners.map((o) => o.name)}`);
  const [ev] = await sql`SELECT count(*)::int AS n FROM events WHERE event_type = 'deal.owner_changed'`;
  expect(ev.n >= 2, "no queda en la historia");
  await shot("lista-acciones-en-bloque");
  await sql`UPDATE deals SET owner_id = '00000000-0000-0000-0000-000000000001'
            WHERE id IN ('90000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000003')`;
});

await step("secuencias: crear una, añadir un paso y meter al contacto de un deal; luego pararla", async () => {
  await page.goto("/sequences");
  await page.getByLabel("Nombre").fill(`Reactivar ${stamp}`);
  await submit("Crear y añadir pasos");
  await page.waitForURL(/\/sequences\/[0-9a-f-]{36}$/);
  const add = page.locator("section", { has: page.getByRole("heading", { name: "Añadir un paso" }) });
  await add.getByLabel("Días de espera").fill("0");
  await add.getByLabel("Asunto del nuevo paso").fill("¿Retomamos {deal}?");
  await add.getByRole("button", { name: "Añadir paso" }).click();
  await page.getByRole("listitem", { name: "Paso 1" }).getByText("¿Retomamos {deal}?").waitFor();
  // Un deal abierto con contacto (el de Paco ya se ganó en una prueba anterior).
  const [open] = await sql`SELECT d.id FROM deals d WHERE d.status = 'open' AND d.deleted_at IS NULL
                           AND EXISTS (SELECT 1 FROM deal_participants dp JOIN person_emails pe ON pe.person_id = dp.person_id WHERE dp.deal_id = d.id)
                           ORDER BY d.created_at LIMIT 1`;
  await page.goto(`/deals/${open.id}`);
  const side = page.getByRole("region", { name: "Secuencias" });
  await side.getByText("+ Añadir a una secuencia").click();
  await side.getByLabel("Secuencia").selectOption({ label: `Reactivar ${stamp} (1 pasos)` });
  await side.getByRole("button", { name: "Añadir" }).click();
  await side.getByRole("link", { name: `Reactivar ${stamp}` }).waitFor();
  await shot("secuencia-en-deal");
  await side.locator("li", { hasText: `Reactivar ${stamp}` }).getByRole("button", { name: "Parar" }).click();
  await side.locator("li", { hasText: `Reactivar ${stamp}` }).getByText("Parada a mano").waitFor();
});

await step("formulario web: crearlo en Ajustes y que un visitante lo envíe", async () => {
  await page.goto("/settings/forms");
  await page.getByLabel("Nombre interno").fill(`Precios ${stamp}`);
  await page.getByLabel("Dirección").fill(`precios-${stamp}`);
  await page.getByLabel("Título visible").fill("Pide precio");
  await page.locator("input[name=field_phone]").check();
  await submit("Crear formulario");
  await page.waitForURL(/\/settings\/forms\/[0-9a-f-]{36}$/);
  await page.getByText(`/f/precios-${stamp}`).first().waitFor();
  const visitor = await browser.newContext({ baseURL: BASE, locale: "es-ES" });
  const v = await visitor.newPage();
  v.on("pageerror", (e) => errors.push(e.message));
  await v.goto(`/f/precios-${stamp}`);
  await v.getByRole("heading", { name: "Pide precio" }).waitFor();
  await v.getByLabel("Nombre *").fill(`Visitante ${stamp}`);
  await v.getByLabel("Email *").fill(`visitante.${stamp}@web-precios.example`);
  await v.getByLabel("Teléfono").fill("600000000");
  await v.waitForTimeout(2100); // el tiempo mínimo del antispam
  await v.getByRole("button", { name: "Enviar" }).click();
  await v.getByText("¡Gracias! Te escribimos muy pronto.").waitFor();
  if (SHOTS) await v.screenshot({ path: `${SHOTS}/formulario-web.png`, fullPage: true });
  await visitor.close();
  const [l] = await sql`SELECT l.source, l.score FROM leads l JOIN person_emails pe ON pe.person_id = l.person_id
                        WHERE pe.email = ${`visitante.${stamp}@web-precios.example`}`;
  expect(l?.source === "formulario web" && l.score !== null, `lead: ${JSON.stringify(l)}`);
});

await step("productos en un deal (el importe se recalcula) y propuesta que el cliente abre y acepta", async () => {
  await page.goto("/settings/products");
  const add = page.locator("section", { has: page.getByRole("heading", { name: "Nuevo producto" }) });
  await add.getByLabel("Nombre").fill(`Licencia ${stamp}`);
  await add.getByLabel("Precio (€)").fill("1200");
  await add.getByLabel("Cobro").selectOption("yearly");
  await add.getByRole("button", { name: "Añadir producto" }).click();
  await page.getByRole("article", { name: `Producto Licencia ${stamp}` }).waitFor();
  const [open] = await sql`SELECT d.id FROM deals d WHERE d.status = 'open' AND d.deleted_at IS NULL
                           AND EXISTS (SELECT 1 FROM deal_participants dp WHERE dp.deal_id = d.id) ORDER BY d.created_at DESC LIMIT 1`;
  await page.goto(`/deals/${open.id}`);
  const box = page.getByRole("region", { name: "Productos y propuestas" });
  await box.getByText("+ Añadir producto").click();
  const [pr] = await sql`SELECT id FROM products WHERE name = ${`Licencia ${stamp}`}`;
  await box.getByLabel("Producto").selectOption(pr.id);
  await box.getByLabel("Cantidad").fill("3");
  await box.getByLabel("Dto. %").fill("10");
  await box.getByRole("button", { name: "Añadir", exact: true }).click();
  await box.getByText("Total (es el importe del deal)").waitFor();
  const [d] = await sql`SELECT value::float8 AS v FROM deals WHERE id = ${open.id}`;
  expect(d.v === 3240, `importe del deal: ${d.v}`);
  await box.getByRole("button", { name: /Crear propuesta/ }).click();
  const link = box.locator(".proposal-item a").first();
  await link.waitFor();
  const href = await link.getAttribute("href");
  const visitor = await browser.newContext({ locale: "es-ES" });
  const v = await visitor.newPage();
  v.on("pageerror", (e) => errors.push(e.message));
  await v.goto(href);
  await v.getByText("Total (impuestos no incluidos)").waitFor();
  if (SHOTS) await v.screenshot({ path: `${SHOTS}/propuesta.png`, fullPage: true });
  await v.getByLabel("Tu nombre").fill("Cliente UI");
  await v.getByRole("button", { name: "Aceptar la propuesta" }).click();
  await v.getByText("¡Propuesta aceptada!").waitFor();
  await visitor.close();
  await page.reload();
  await page.getByRole("region", { name: "Productos y propuestas" }).getByText("Aceptada por Cliente UI").waitFor();
});

await step("mención en una nota avisa; borrar un lead y recuperarlo; fusionar duplicados", async () => {
  // Mención: «@Customer Success» en una nota del deal.
  const [open] = await sql`SELECT id FROM deals WHERE status = 'open' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  await page.goto(`/deals/${open.id}`);
  await page.locator(".composer textarea[name=content]").fill(`@Customer Success revisa esto ${stamp}`);
  await submit("Guardar nota");
  await page.getByText(`revisa esto ${stamp}`).first().waitFor();
  const [n] = await sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'mention' AND body LIKE ${`%revisa esto ${stamp}%`}
                          AND user_id = (SELECT id FROM users WHERE name = 'Customer Success')`;
  expect(n.n === 1, "no llegó el aviso de la mención");

  // Papelera.
  const [lead] = await sql`SELECT id, title FROM leads WHERE deleted_at IS NULL AND status = 'open' ORDER BY created_at DESC LIMIT 1`;
  await page.goto(`/leads/${lead.id}`);
  await page.getByRole("button", { name: "Borrar", exact: true }).click();
  await page.waitForURL(/\/leads$/);
  await page.goto("/trash");
  const row = page.getByRole("row", { name: new RegExp(lead.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
  await row.getByRole("button", { name: "Recuperar" }).click();
  await row.waitFor({ state: "detached" });
  const [back] = await sql`SELECT deleted_at FROM leads WHERE id = ${lead.id}`;
  expect(back.deleted_at === null, "no se recuperó el lead");

  // Duplicados.
  const [org] = await sql`INSERT INTO organizations (name) VALUES (${`Gemelos ${stamp} S.L.`}) RETURNING id`;
  const [a] = await sql`INSERT INTO persons (first_name, last_name) VALUES ('Luis', ${`Gemelo ${stamp}`}) RETURNING id`;
  const [b] = await sql`INSERT INTO persons (first_name, last_name) VALUES ('luis', ${`gemelo ${stamp}`}) RETURNING id`;
  await sql`INSERT INTO person_organizations (person_id, organization_id, status) VALUES (${a.id}, ${org.id}, 'current'), (${b.id}, ${org.id}, 'current')`;
  await sql`INSERT INTO person_emails (person_id, email, is_primary) VALUES (${b.id}, ${`luis.${stamp}@gemelos.example`}, true)`;
  await sql`INSERT INTO notes (content, person_id) VALUES ('Nota del duplicado', ${b.id})`;
  await page.goto("/duplicates");
  const card = page.getByRole("article", { name: new RegExp(`Duplicados Luis Gemelo ${stamp}`, "i") });
  await card.getByRole("button", { name: /Fusionar/ }).click();
  await card.waitFor({ state: "detached" });
  const survivors = await sql`SELECT id FROM persons WHERE id IN (${a.id}, ${b.id}) AND deleted_at IS NULL`;
  const keep = survivors[0]?.id;
  const [moved] = await sql`SELECT (SELECT count(*)::int FROM person_emails WHERE person_id = ${keep}) AS emails,
                                   (SELECT count(*)::int FROM notes WHERE person_id = ${keep}) AS notes`;
  expect(survivors.length === 1 && moved.emails === 1 && moved.notes === 1, `fusión: ${JSON.stringify({ survivors, moved })}`);
});

await step("dar acceso a un comercial, que entra, cambia su contraseña temporal y no ve los ajustes de admin", async () => {
  await page.goto("/settings/users");
  const card = page.getByRole("article", { name: "Usuario Customer Success" });
  await card.locator("summary").click();
  await card.getByLabel("Contraseña inicial").fill("temporal-cs-12345");
  await card.getByRole("button", { name: "Dar acceso" }).click();
  await card.locator("p.meta", { hasText: "contraseña temporal" }).waitFor();
  // Sale el administrador y entra el comercial.
  await page.getByRole("button", { name: /Tu cuenta/ }).click();
  await page.getByRole("menuitem", { name: "Cerrar sesión" }).click();
  await page.waitForURL(/\/login/);
  await page.getByLabel("Email").fill("cs@example.com");
  await page.getByLabel("Contraseña").fill("temporal-cs-12345");
  await submit("Entrar");
  await page.waitForURL(/\/account\?change=1/);
  await page.getByLabel("Contraseña actual").fill("temporal-cs-12345");
  await page.getByLabel("Nueva contraseña").fill("la-mia-de-verdad-2026");
  await page.getByLabel("Repítela").fill("la-mia-de-verdad-2026");
  await submit("Cambiar contraseña");
  await page.waitForURL((u) => new URL(u).pathname === "/");
  await page.goto("/settings");
  await page.getByText("Los demás ajustes los gestiona un administrador").waitFor();
  expect(await page.getByRole("link", { name: /Importar desde Pipedrive/ }).count() === 0, "un comercial ve la importación");
  await page.goto("/settings/automations");
  await page.waitForURL(/denied=1/);
  await shot("ajustes-comercial");
  // Vuelve el administrador para el resto de pruebas.
  await page.getByRole("button", { name: /Tu cuenta/ }).click();
  await page.getByRole("menuitem", { name: "Cerrar sesión" }).click();
  await page.waitForURL(/\/login/);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Contraseña").fill(ADMIN.password);
  await submit("Entrar");
  await page.waitForURL((u) => new URL(u).pathname === "/");
  await sql`UPDATE users SET password_hash = NULL, must_change_password = false WHERE lower(email) = 'cs@example.com'`;
});

await step("plan de cierre: crear el de partida, marcar un paso y compartirlo con el cliente", async () => {
  const [d] = await sql`SELECT ods.id FROM open_deals_status ods WHERE ods.pipeline_id = '10000000-0000-0000-0000-000000000001'
                        AND NOT EXISTS (SELECT 1 FROM close_plan_steps c WHERE c.deal_id = ods.id) ORDER BY ods.title LIMIT 1`;
  await page.goto(`/deals/${d.id}`);
  const plan = page.locator("section.close-plan");
  await plan.getByRole("button", { name: "Crear un plan de partida" }).click();
  await plan.getByText("Firma del contrato").waitFor();
  const first = plan.locator("ol.plan-steps li").first();
  await first.locator("button.plan-check").click();
  await plan.locator("ol.plan-steps li.done").first().waitFor();
  await plan.getByRole("button", { name: "Compartir con el cliente" }).click();
  const url = await plan.locator("code").first().textContent({ timeout: 8000 });
  const cp = await context.newPage();
  await cp.goto(new URL(url).pathname);
  await cp.getByRole("heading", { name: "Plan de trabajo conjunto" }).waitFor();
  expect(await cp.getByText(/1 de \d+ pasos hechos/).count() === 1, "el cliente no ve el progreso");
  await cp.close();
  await shot("plan-de-cierre");
});

await step("lo que sabemos del deal: se rellena a mano", async () => {
  const [d] = await sql`SELECT id FROM open_deals_status WHERE pipeline_id = '10000000-0000-0000-0000-000000000001' ORDER BY title DESC LIMIT 1`;
  await page.goto(`/deals/${d.id}`);
  const box = page.locator("section.insights");
  await box.locator("summary").click();
  await box.locator("textarea[name=needs]").fill(`Centralizar la facturación ${stamp}`);
  await box.locator("input[name=budget]").fill("20.000 € al año");
  await box.getByRole("button", { name: "Guardar" }).click();
  await box.locator("dd", { hasText: `Centralizar la facturación ${stamp}` }).waitFor();
  await box.locator("dd", { hasText: "20.000 € al año" }).waitFor();
});

await step("descuento por encima del límite: queda pendiente y el administrador lo aprueba", async () => {
  await sql`UPDATE app_settings SET max_discount_pct = 10`;
  const [d] = await sql`SELECT id FROM open_deals_status WHERE pipeline_id = '10000000-0000-0000-0000-000000000001' ORDER BY title LIMIT 1 OFFSET 2`;
  await page.goto(`/deals/${d.id}`);
  const box = page.locator("section.deal-products");
  await box.getByText("+ Añadir producto").click();
  await box.locator("select[name=product_id]").selectOption({ index: 1 });
  await box.locator("input[name=discount_pct]").fill("30");
  await box.getByRole("button", { name: "Añadir", exact: true }).click();
  await box.getByText("Pendiente de aprobación").waitFor();
  await box.getByRole("button", { name: "Aprobar" }).click();
  await box.getByText("Aprobado").waitFor();
  await sql`UPDATE app_settings SET max_discount_pct = NULL`;
});

await step("baja de las comunicaciones: un clic desde el enlace del correo", async () => {
  const { createHmac } = await import("node:crypto");
  const [p] = await sql`SELECT id FROM persons WHERE unsubscribed_at IS NULL AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`;
  const sig = createHmac("sha256", process.env.TOKEN_ENCRYPTION_KEY || process.env.CRON_SECRET || "crm").update(`baja:${p.id}`).digest("base64url").slice(0, 22);
  const other = await context.newPage();
  await other.goto(`/u/${p.id}.${sig}`);
  await other.getByRole("button", { name: "Darme de baja" }).click();
  await other.getByText("Hecho: no volverás a recibir").waitFor();
  await other.close();
  const [after] = await sql`SELECT unsubscribed_at FROM persons WHERE id = ${p.id}`;
  expect(after.unsubscribed_at, "no quedó dado de baja");
  await sql`UPDATE persons SET unsubscribed_at = NULL WHERE id = ${p.id}`;
});

await step("encuesta: el cliente puntúa del 0 al 10 sin iniciar sesión", async () => {
  const token = `encuesta-ui-${stamp}-abcdef`.slice(0, 28);
  await sql`INSERT INTO surveys (token, kind, organization_id) VALUES (${token}, 'onboarding', '60000000-0000-0000-0000-000000000001')`;
  const other = await context.newPage();
  await other.goto(`/s/${token}`);
  await other.locator(".nps label", { hasText: /^9$/ }).click();
  await other.getByLabel("¿Algo que debamos mejorar? (opcional)").fill("Todo muy claro");
  await other.getByRole("button", { name: "Enviar" }).click();
  await other.getByText("¡Gracias! Nos ayuda mucho.").waitFor();
  await other.close();
  const [s] = await sql`SELECT score FROM surveys WHERE token = ${token}`;
  expect(s.score === 9, `puntuación ${s.score}`);
});

await step("renovación ganada: el contrato renueva un año más", async () => {
  const [c] = await sql`SELECT id, renewal_date FROM contracts WHERE status = 'active' ORDER BY created_at LIMIT 1`;
  let [d] = await sql`SELECT id FROM deals WHERE contract_id = ${c.id} AND deal_type = 'renewal' AND status = 'open' AND deleted_at IS NULL`;
  if (!d) {
    await page.goto(`/organizations/${(await sql`SELECT organization_id FROM contracts WHERE id = ${c.id}`)[0].organization_id}`);
    await page.locator("section.account").getByText("Editar").first().click();
    await page.getByRole("button", { name: "Preparar la renovación ahora" }).click();
    await page.locator("section.account").getByText(/Renovación —/).waitFor();
    [d] = await sql`SELECT id FROM deals WHERE contract_id = ${c.id} AND deal_type = 'renewal' AND status = 'open' AND deleted_at IS NULL`;
  }
  await page.goto(`/deals/${d.id}`);
  await page.getByRole("button", { name: "Ganado", exact: true }).click();
  await page.getByText(/Ganado el/).first().waitFor();
  const [after] = await sql`SELECT renewal_date FROM contracts WHERE id = ${c.id}`;
  expect(new Date(after.renewal_date) > new Date(c.renewal_date), "la fecha de renovación no avanzó");
  await shot("renovacion-ganada");
});

await step("agentes: el panel muestra los seis y se puede apagar un trabajo", async () => {
  await page.goto("/agents");
  await page.getByRole("heading", { name: "Jefe de agentes" }).waitFor();
  const card = page.getByRole("article", { name: "Agente Ejecutivo de deal" });
  await card.locator("button.job-toggle").first().click();
  await card.locator('button.job-toggle[aria-pressed="false"]').first().waitFor();
  const [j] = await sql`SELECT enabled FROM agent_jobs WHERE key = 'meeting_prep'`;
  expect(j.enabled === false, "el trabajo sigue activo");
  await card.locator('button.job-toggle[aria-pressed="false"]').first().click();
  await card.locator('button.job-toggle[aria-pressed="true"]').nth(0).waitFor();
  await shot("agentes");
});

await step("campañas: crear una campaña y añadir contactos pegando un CSV", async () => {
  await page.goto("/campaigns");
  await page.getByLabel("Nombre *").fill(`Campaña UI ${stamp}`);
  await page.getByRole("button", { name: "Crear campaña" }).click();
  await page.waitForURL(/\/campaigns\/[0-9a-f-]{36}/);
  await page.locator("textarea[name=csv]").fill(`email;nombre;empresa;cargo\nmaria.ui${stamp}@empresa-ui.example;María UI;Empresa UI;CEO`);
  await page.getByRole("button", { name: "Añadir", exact: true }).click();
  await page.getByText(/1 añadidos/).waitFor();
  await page.locator("table td", { hasText: "María UI" }).first().waitFor();
  await shot("campana");
});

if (MOCK) {
  await step("secuencias: escribir un correo con formato, variables, condición, IA, vista previa y prueba", async () => {
    await page.goto("/sequences");
    await page.getByLabel("Nombre").fill(`Secuencia UI ${stamp}`);
    await submit("Crear y añadir pasos");
    await page.waitForURL(/\/sequences\/[0-9a-f-]{36}$/);
    const add = page.getByRole("region", { name: "Añadir un paso" });
    await add.getByLabel("Formato del correo").selectOption("html");
    await add.getByLabel("Asunto del nuevo paso").fill(`Idea para {{empresa}} ${stamp}`);
    const body = add.getByRole("textbox", { name: "Texto del nuevo paso" });
    await body.click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Hola ");
    await add.getByRole("button", { name: /Variables/ }).click();
    await add.locator(".ee-vars button", { hasText: "{{nombre}}" }).click();
    await body.click();
    await page.keyboard.press("End");
    await page.keyboard.type(", ¿hablamos el jueves?");
    expect((await body.innerHTML()).includes("Hola {{nombre}}, ¿hablamos el jueves?"), `texto: ${await body.innerHTML()}`);
    await add.locator(".ee-checks").getByText(/Personalizado/).waitFor();
    // Vista previa: con datos de ejemplo y con un contacto real.
    await add.getByRole("tab", { name: "Vista previa" }).click();
    const frame = add.frameLocator('iframe[title="Vista previa del correo"]');
    await frame.getByText("Hola Laura, ¿hablamos el jueves?").waitFor();
    await add.getByLabel("Buscar otro contacto").fill("Ana Garc");
    await add.locator(".ee-found button", { hasText: "Ana García" }).first().click();
    await frame.getByText("Hola Ana, ¿hablamos el jueves?").waitFor();
    await add.getByText("Idea para Paco S.L.").first().waitFor().catch(() => {});
    await shot("secuencia-editor-previa");
    // Prueba a mi correo.
    await add.getByRole("tab", { name: "Enviar prueba" }).click();
    await add.getByRole("button", { name: "Enviar prueba" }).click();
    await add.getByText(/Prueba enviada a .* con los datos de Ana García/).waitFor();
    const test = (await mockState()).sent.find((m) => m.subject?.startsWith("[Prueba] Idea para") && m.subject.includes(stamp));
    expect(test && test.body.contentType === "HTML" && test.body.content.includes("Hola Ana"), "la prueba no salió en HTML con los datos de Ana");
    // IA: acortar (y se puede deshacer); luego una condición.
    await add.getByRole("button", { name: "✦ Escribir con IA" }).click();
    await add.getByRole("button", { name: "Acortar" }).click();
    await add.getByText("Listo. Revísalo antes de guardar").waitFor();
    expect((await body.innerHTML()).includes("(IA) Hola {{nombre}}"), "la IA no reescribió el correo");
    await add.getByRole("button", { name: "Deshacer" }).click();
    expect((await body.innerHTML()).includes("¿hablamos el jueves?"), "no se deshizo");
    await body.click();
    await page.keyboard.press("ControlOrMeta+End");
    await add.getByRole("button", { name: "Si… / si no" }).click();
    await add.getByLabel("Texto si se cumple").fill(" Como {{cargo}}, te interesará.");
    await add.getByRole("button", { name: "Insertar" }).click();
    expect((await body.innerHTML()).includes("{{#if cargo}} Como {{cargo}}, te interesará.{{#endif}}"), `sin condición: ${await body.innerHTML()}`);
    await shot("secuencia-editor");
    await submit("Añadir paso");
    await page.getByRole("listitem", { name: "Paso 1" }).waitFor();
    const [st] = await sql`SELECT st.id, st.format, st.subject, st.body FROM sequence_steps st JOIN sequences s ON s.id = st.sequence_id WHERE s.name = ${`Secuencia UI ${stamp}`}`;
    expect(st?.format === "html" && st.body.includes("{{#if cargo}}") && st.body.includes("Hola {{nombre}}"), JSON.stringify(st));
    // Prueba A/B: una variante B con otro asunto.
    const step1 = page.getByRole("listitem", { name: "Paso 1" });
    await step1.getByText("+ Prueba A/B: añadir una variante").click();
    await step1.getByLabel("Asunto del paso 1 nueva variante").fill(`Otra idea {{nombre}} ${stamp}`);
    await step1.getByRole("button", { name: "Añadir variante" }).click();
    await step1.getByText(/Variante B: Otra idea/).waitFor();
    const [v] = await sql`SELECT label, subject FROM sequence_step_variants WHERE step_id = ${st.id}`;
    expect(v?.label === "B", JSON.stringify(v));
  });

  await step("mi cuenta: firma de los correos con formato", async () => {
    await page.goto("/account");
    const box = page.getByRole("textbox", { name: "Firma" });
    await box.click();
    await page.keyboard.type(`Gestor ${stamp} · aikit`);
    await page.getByRole("button", { name: "Guardar firma" }).click();
    await page.getByText("Firma guardada.").waitFor();
    const [u] = await sql`SELECT email_signature FROM users WHERE lower(email) = ${ADMIN.email}`;
    expect(u.email_signature?.includes(`Gestor ${stamp}`), JSON.stringify(u));
  });

  await step("la firma va en los correos que escribes desde el deal (y se puede quitar)", async () => {
    const [open] = await sql`SELECT d.id FROM deals d JOIN deal_participants dp ON dp.deal_id = d.id JOIN person_emails pe ON pe.person_id = dp.person_id
                             WHERE d.status = 'open' AND d.deleted_at IS NULL ORDER BY d.created_at LIMIT 1`;
    await page.goto(`/deals/${open.id}`);
    await page.getByRole("tab", { name: "Correo", exact: true }).click();
    const form = page.locator(".composer form", { has: page.getByRole("button", { name: "Insertar mis huecos" }) });
    await form.getByLabel("Firma").getByText(`Gestor ${stamp} · aikit`).waitFor();
    await form.getByLabel("Asunto").fill(`Con firma ${stamp}`);
    await form.locator("textarea[name=body]").fill("Hola, te escribo por lo que hablamos.");
    await form.getByRole("button", { name: /Enviar desde/ }).click();
    await page.getByText(`Email: Con firma ${stamp}`).waitFor();
    const m = (await mockState()).sent.find((x) => x.subject === `Con firma ${stamp}`);
    expect(m && m.body.contentType === "HTML" && m.body.content.includes(`Gestor ${stamp} · aikit`) && m.body.content.includes("Hola, te escribo"), "el correo no llevaba la firma");
    await form.getByLabel("Asunto").fill(`Sin firma ${stamp}`);
    await form.locator("textarea[name=body]").fill("Sin firma esta vez.");
    await form.getByLabel("Añadir mi firma").uncheck();
    await form.getByRole("button", { name: /Enviar desde/ }).click();
    await page.getByText(`Email: Sin firma ${stamp}`).waitFor();
    const m2 = (await mockState()).sent.find((x) => x.subject === `Sin firma ${stamp}`);
    expect(m2 && !JSON.stringify(m2.body).includes(`Gestor ${stamp}`), "salió con firma aunque se quitó");
  });

  await step("ficha de contacto: registrar una llamada, etiquetar, seguir, subir un archivo y escribirle", async () => {
    const [p] = await sql`SELECT p.id, p.full_name FROM persons p JOIN person_emails e ON e.person_id = p.id
                          WHERE p.deleted_at IS NULL AND p.unsubscribed_at IS NULL ORDER BY p.created_at LIMIT 1`;
    await page.goto(`/persons/${p.id}`);
    // Llamada
    await page.getByRole("link", { name: "Registrar llamada" }).click();
    const call = page.getByRole("tabpanel", { name: "Llamada" });
    await call.getByLabel("No contestó").check();
    await call.getByLabel("Siguiente llamada").selectOption("1");
    await call.getByLabel("Notas de la llamada").fill(`Sin respuesta ${stamp}`);
    await call.getByRole("button", { name: "Registrar llamada" }).click();
    await call.getByText("Llamada registrada.").waitFor();
    await page.locator(".feed-item.call", { hasText: "no contestó" }).first().waitFor();
    const [a] = await sql`SELECT call_outcome, done FROM activities WHERE person_id = ${p.id} AND note = ${`Sin respuesta ${stamp}`}`;
    const [next] = await sql`SELECT count(*)::int AS n FROM activities WHERE person_id = ${p.id} AND NOT done AND subject LIKE 'Volver a llamar%'`;
    expect(a?.call_outcome === "no_answer" && a.done && next.n >= 1, JSON.stringify({ a, next }));
    // Etiqueta
    await page.getByText("+ Etiqueta").first().click();
    await page.getByLabel("Etiquetas (separadas por comas)").fill(`vip-ui-${stamp}`);
    await page.locator(".tags-edit").getByRole("button", { name: "Guardar" }).click();
    await page.locator(".tags-block .tag", { hasText: `vip-ui-${stamp}` }).waitFor();
    // Seguir
    await page.getByRole("region", { name: "Seguidores" }).getByRole("button", { name: "Seguir" }).click();
    await page.getByRole("region", { name: "Seguidores" }).getByRole("button", { name: "Dejar de seguir" }).waitFor();
    // Archivo
    await page.getByRole("tab", { name: /^Archivos/ }).first().click();
    await page.getByLabel("Elegir archivos").setInputFiles({ name: `propuesta-${stamp}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 prueba") });
    await page.getByRole("link", { name: `propuesta-${stamp}.pdf` }).first().waitFor();
    // Correo desde la ficha
    await page.getByRole("tab", { name: "Correo", exact: true }).click();
    const mail = page.getByRole("tabpanel", { name: "Correo" });
    await mail.getByLabel("Asunto").fill(`Desde la ficha ${stamp}`);
    await mail.locator("textarea[name=body]").fill("Hola, te escribo desde tu ficha.");
    await mail.getByRole("button", { name: /^Enviar a / }).click();
    await mail.getByText("Correo enviado.").waitFor();
    expect((await mockState()).sent.some((m) => m.subject === `Desde la ficha ${stamp}`), "el correo no salió");
    await shot("ficha-contacto");
  });

  await step("lista de contactos: filtrar por etiqueta y etiquetar en bloque", async () => {
    const [t] = await sql`SELECT id FROM tags WHERE name = ${`vip-ui-${stamp}`}`;
    await page.goto(`/persons?tag=${t.id}`);
    const rows = page.locator("tbody tr");
    expect(await rows.count() === 1, `filas: ${await rows.count()}`);
    await page.goto("/persons");
    const checks = page.locator("input.bulk-check");
    await checks.nth(0).check();
    await checks.nth(1).check();
    const bar = page.getByRole("region", { name: "Acciones en bloque" });
    await bar.getByLabel("Acción").selectOption("tag");
    await bar.getByLabel("Etiqueta").fill(`lote-${stamp}`);
    await bar.getByRole("button", { name: "Aplicar" }).click();
    await bar.getByText(/2 contactos con el cambio/).waitFor();
    const [n] = await sql`SELECT count(*)::int AS n FROM person_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name = ${`lote-${stamp}`}`;
    expect(n.n === 2, `etiquetados: ${n.n}`);
    await shot("contactos");
  });

  await step("IA por fase: desde la columna del tablero, escribir una instrucción, ver cómo la entiende y activarla", async () => {
    const [pl] = await sql`SELECT p.id FROM pipelines p WHERE EXISTS (SELECT 1 FROM deals d WHERE d.pipeline_id = p.id AND d.status = 'open') ORDER BY p.position LIMIT 1`;
    const [st] = await sql`SELECT s.id, s.name FROM stages s WHERE s.pipeline_id = ${pl.id} AND s.is_active
                           AND EXISTS (SELECT 1 FROM deals d WHERE d.stage_id = s.id AND d.status = 'open') ORDER BY s.position LIMIT 1`;
    await page.goto(`/pipelines/${pl.id}`);
    await page.getByRole("link", { name: `IA en la fase ${st.name}` }).click();
    await page.waitForURL(/\/agentes\?fase=/);
    const stage = page.getByRole("listitem", { name: `Fase ${st.name}` });
    await stage.getByLabel(`Instrucción en «${st.name}»`).fill("Cuando un deal entre aquí, escríbele para agendar una reunión con mis huecos (también a los que ya están).");
    await stage.getByRole("button", { name: "Ver cómo lo va a hacer" }).click();
    const plan = stage.getByLabel("Cómo lo ha entendido");
    await plan.getByText(/lo redacta la IA, con tus huecos libres/).waitFor();
    await plan.getByText("Lo he entendido así:").waitFor();
    await shot("ia-por-fase-plan");
    await plan.getByRole("button", { name: "Activar" }).click();
    await stage.getByText(/te propondrá cada acción en la bandeja/).waitFor();
    await stage.locator(".instr-card", { hasText: "escríbele para agendar" }).waitFor();
    const [ins] = await sql`SELECT i.id, i.autonomy, (SELECT count(*)::int FROM automation_rules r WHERE r.instruction_id = i.id) AS rules
                            FROM stage_instructions i WHERE i.stage_id = ${st.id}`;
    expect(ins?.autonomy === "ask" && ins.rules === 1, JSON.stringify(ins));
    // Probar con un deal (sin hacer nada)
    const card = stage.locator(".instr-card", { hasText: "escríbele para agendar" });
    await card.getByText("Probar con un deal").click();
    await card.getByRole("button", { name: "Probar con este deal" }).click();
    await card.getByLabel("Resultado de la prueba").getByText(/Haría:/).waitFor();
    // Cambiar a «Sola» y volver a «Preguntarme»
    await card.getByRole("button", { name: "Sola", exact: true }).click();
    await card.locator('button[aria-pressed="true"]', { hasText: "Sola" }).waitFor();
    const [a] = await sql`SELECT autonomy FROM automation_rules WHERE instruction_id = ${ins.id}`;
    expect(a.autonomy === "auto", a.autonomy);
    await card.getByRole("button", { name: "Preguntarme", exact: true }).click();
    await card.locator('button[aria-pressed="true"]', { hasText: "Preguntarme" }).waitFor();
    await shot("ia-por-fase");
    await page.goto(`/pipelines/${pl.id}`);
    await page.locator(".stage-ai.on").first().waitFor();
  });

  await step("ajustes de correo: firma de cada cuenta", async () => {
    await page.goto("/settings/mailbox");
    const card = page.locator("article.mailbox").first();
    await card.getByText(/Firma de los correos/).click();
    await card.getByRole("button", { name: "HTML" }).click();
    await card.getByLabel("HTML de la firma").fill(`<p><b>Firma ajustes ${stamp}</b><script>alert(1)</script></p>`);
    await card.getByRole("button", { name: "Aplicar" }).click();
    await card.getByRole("button", { name: "Guardar firma" }).click();
    await card.getByText("Firma guardada.").waitFor();
    const rows = await sql`SELECT email_signature FROM users WHERE email_signature LIKE ${`%Firma ajustes ${stamp}%`}`;
    expect(rows.length === 1 && !rows[0].email_signature.includes("script"), JSON.stringify(rows));
  });
}

await step("sin errores de JavaScript en el navegador", async () => {
  expect(errors.length === 0, errors.slice(0, 3).join(" | "));
});

await browser.close();
await sql.end();
console.log(`\n${failed === 0 ? "✓" : "✗"} ${passed} correctas, ${failed} fallidas`);
process.exit(failed === 0 ? 0 : 1);
