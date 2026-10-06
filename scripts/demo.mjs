#!/usr/bin/env node
// Arranca el CRM para probarlo en local con un solo comando:
//   base de datos con datos de ejemplo + Microsoft 365 y Google simulados + la app.
//
//   npm run demo                  conserva los datos entre arranques
//   npm run demo -- --reset       empieza de cero con los datos de ejemplo
//   npm run demo -- --ia-simulada además deja configurada una IA simulada
//
// Para usar una IA real, ponla en Ajustes → Modelo de IA (con tu clave).
// Abre http://localhost:3000 y para con Ctrl+C.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import net from "node:net";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DATA = path.join(root, ".demo-data");
const PIDFILE = path.join(root, ".demo.pid");
const reset = args.includes("--reset") || process.env.npm_config_reset === "true"; // también «npm run demo --reset»
const simulatedAi = args.includes("--ia-simulada") || process.env["npm_config_ia_simulada"] === "true";
const fail = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

// Comprobaciones previas, con mensajes claros.
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) fail(`Hace falta Node.js 22 o superior (tienes ${process.versions.node}). Instálalo desde nodejs.org o con «brew install node».`);
if (!existsSync(path.join(root, "node_modules", "next"))) fail("Faltan las dependencias: ejecuta primero «npm install».");

// Si hay una demo anterior abierta (en otra terminal), se cierra: si no, la base de datos y los puertos siguen ocupados.
async function stopPrevious() {
  if (!existsSync(PIDFILE)) return;
  const pid = Number(readFileSync(PIDFILE, "utf8"));
  try {
    process.kill(pid, 0);
    console.log("▸ Cerrando la demo que seguía abierta…");
    process.kill(pid, "SIGTERM");
    for (let i = 0; i < 50; i++) { await new Promise((r) => setTimeout(r, 200)); try { process.kill(pid, 0); } catch { break; } }
  } catch { /* ya no estaba en marcha */ }
  try { unlinkSync(PIDFILE); } catch { /* nada */ }
}
await stopPrevious();

/** Primer puerto libre a partir de `from`. */
async function freePort(from) {
  for (let port = from; port < from + 50; port++) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer().once("error", () => resolve(false)).once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port, "127.0.0.1");
    });
    if (ok) return port;
  }
  fail(`No hay puertos libres a partir del ${from}.`);
}
const DB_PORT = await freePort(Number(process.env.DEMO_DB_PORT ?? 54329));
const MOCK_PORT = await freePort(Number(process.env.DEMO_MOCK_PORT ?? 3998));
const APP_PORT = await freePort(Number(process.env.PORT ?? 3000));

// «--reset»: se empieza de cero de verdad (también arregla una carpeta de datos que quedó a medias al cortar la demo).
if (reset && existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
const fresh = !existsSync(DATA);
const DEMO_LOGIN = { email: "ventas@example.com", password: "demo-crm-2026" };
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

const env = {
  ...process.env,
  DATABASE_URL: `postgres://crm:crm@127.0.0.1:${DB_PORT}/crm`,
  TZ: process.env.TZ || "Europe/Madrid",
  APP_URL: `http://localhost:${APP_PORT}`,
  TOKEN_ENCRYPTION_KEY: "clave-de-cifrado-de-la-demo-0123456789abcdef",
  INBOUND_API_KEYS: "clave-de-la-demo-0123456789",
  CRON_SECRET: "secreto-de-la-demo-0123456789",
  AUTOMATIONS_INTERVAL_MINUTES: "5",
  // Microsoft 365 y Google simulados (scripts/mock-providers.mjs)
  MS_CLIENT_ID: "demo", MS_CLIENT_SECRET: "secreto-ms-demo", MS_TENANT_ID: "demo",
  MS_LOGIN_URL: MOCK, MS_GRAPH_URL: `${MOCK}/v1.0`,
  GOOGLE_CLIENT_ID: "demo", GOOGLE_CLIENT_SECRET: "secreto-google-demo",
  PIPEDRIVE_API_URL: MOCK, // Pipedrive simulado: token «token-pipedrive-de-pruebas-0123456789»
  GOOGLE_AUTH_URL: `${MOCK}/o/oauth2/v2/auth`, GOOGLE_TOKEN_URL: `${MOCK}/token`, GOOGLE_API_BASE: MOCK,
  NEXT_TELEMETRY_DISABLED: "1",
  // La pantalla de entrada muestra este acceso (solo en la demo).
  DEMO_LOGIN_HINT: `${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}`,
};

const children = [];
const logs = new Map();
function start(name, cmd, cmdArgs, extraEnv = {}, waitFor) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    logs.set(name, "");
    let done = !waitFor;
    if (done) resolve(child);
    const onData = (buf) => {
      const text = buf.toString();
      logs.set(name, (logs.get(name) + text).slice(-4000));
      if (process.env.DEMO_VERBOSE || name === "app") process.stdout.write(text.split("\n").filter(Boolean).map((l) => `[${name}] ${l}\n`).join(""));
      if (!done && waitFor.test(text)) { done = true; resolve(child); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (!done) reject(new Error(`«${name}» se cerró al arrancar (código ${code}). Últimas líneas:\n${logs.get(name).trim().split("\n").slice(-15).join("\n")}`));
      else if (name === "app" && code !== 0 && code !== null) { console.error(`\n✗ La aplicación se ha cerrado (código ${code}).`); stop(); process.exit(1); }
    });
  });
}
const run = (cmdArgs) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, cmdArgs, { cwd: root, env, stdio: "inherit" });
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmdArgs.join(" ")} falló`))));
});
const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  try { if (readFileSync(PIDFILE, "utf8") === String(process.pid)) unlinkSync(PIDFILE); } catch { /* nada */ }
};
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
process.on("SIGHUP", () => { stop(); process.exit(0); });
writeFileSync(PIDFILE, String(process.pid));

try {
  console.log("▸ Base de datos de la demo");
  await start("db", process.execPath, ["scripts/dev-db.mjs"], { DEV_DB_PORT: String(DB_PORT), DEV_DB_DIR: DATA }, /PostgreSQL de desarrollo/);
  if (fresh) {
    console.log("▸ Datos de ejemplo (desde cero)");
    await run(["scripts/db.mjs", "reset"]);
  } else {
    await run(["scripts/db.mjs", "migrate"]);
  }
  // Acceso a la demo: el administrador de los datos de ejemplo (siempre con la misma contraseña).
  await run(["scripts/db.mjs", "user", DEMO_LOGIN.email, DEMO_LOGIN.password, "admin"]);
  if (simulatedAi) {
    // Mismo cifrado que src/lib/crypto.ts.
    const key = createHash("sha256").update(env.TOKEN_ENCRYPTION_KEY).digest();
    const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([c.update("clave-llm-de-pruebas", "utf8"), c.final()]);
    const secret = ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
    const { default: postgres } = await import("postgres");
    const sql = postgres(env.DATABASE_URL, { max: 1 });
    await sql`UPDATE ai_settings SET provider = 'compatible', base_url = ${`${MOCK}/llm/openai`}, model = 'ia-simulada', api_key = ${secret}`;
    await sql.end();
    console.log("▸ IA simulada configurada (sus textos empiezan por «(IA)»)");
  }
  console.log("▸ Microsoft 365 y Google simulados");
  await start("simulador", process.execPath, ["scripts/mock-providers.mjs"],
    { MOCK_PORT: String(MOCK_PORT), MS_CLIENT_SECRET: env.MS_CLIENT_SECRET, GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET }, /simulado/);
  console.log("▸ Aplicación (la primera carga de cada página tarda unos segundos)");
  const next = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
  await start("app", next, ["dev", "-p", String(APP_PORT)], {}, /Ready|Local:/);
  console.log(`
  ✓ CRM de prueba en http://localhost:${APP_PORT}

  Entra con ${DEMO_LOGIN.email} / ${DEMO_LOGIN.password}

  Qué probar:
   · «Hoy» (la portada): el parte del día.
   · Ajustes → Usuarios y permisos: da acceso a leads@example.com o cs@example.com con otro rol.
   · Ajustes → Correo, calendario y documentos → «Conectar Microsoft 365» o «Conectar Google Workspace»
     (simulados: no se envía nada de verdad).
   · Un deal → «Correo» → «Insertar mis huecos», y «Documentos» → buscar «paco».
   · Bandeja de la IA → «Revisar ahora».
   · Ajustes → Modelo de IA: pon tu clave real para ver resúmenes de verdad.
   · Ajustes → Importar desde Pipedrive (simulado): token «token-pipedrive-de-pruebas-0123456789».

  Para parar: Ctrl+C. Los datos se guardan en .demo-data (npm run demo -- --reset para empezar de cero).
`);
} catch (err) {
  console.error(`\n✗ ${err.message}\n`);
  console.error("  Si no lo ves claro, prueba «npm run demo -- --reset» o copia este mensaje y pásamelo.\n");
  stop();
  process.exit(1);
}
