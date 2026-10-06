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
import { existsSync } from "node:fs";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const DATA = path.join(root, ".demo-data");
const DB_PORT = Number(process.env.DEMO_DB_PORT ?? 54329);
const MOCK_PORT = Number(process.env.DEMO_MOCK_PORT ?? 3998);
const APP_PORT = Number(process.env.PORT ?? 3000);
const fresh = args.includes("--reset") || !existsSync(DATA);
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
  GOOGLE_AUTH_URL: `${MOCK}/o/oauth2/v2/auth`, GOOGLE_TOKEN_URL: `${MOCK}/token`, GOOGLE_API_BASE: MOCK,
  NEXT_TELEMETRY_DISABLED: "1",
};

const children = [];
function start(name, cmd, cmdArgs, extraEnv = {}, waitFor) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd: root, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let done = !waitFor;
    if (done) resolve(child);
    const onData = (buf) => {
      const text = buf.toString();
      if (process.env.DEMO_VERBOSE || name === "app") process.stdout.write(text.split("\n").filter(Boolean).map((l) => `[${name}] ${l}\n`).join(""));
      if (!done && waitFor.test(text)) { done = true; resolve(child); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => { if (!done) reject(new Error(`${name} terminó (código ${code})`)); });
  });
}
const run = (cmdArgs) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, cmdArgs, { cwd: root, env, stdio: "inherit" });
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmdArgs.join(" ")} falló`))));
});
const stop = () => { for (const c of children) c.kill("SIGTERM"); };
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });

try {
  console.log("▸ Base de datos de la demo");
  await start("db", process.execPath, ["scripts/dev-db.mjs"], { DEV_DB_PORT: String(DB_PORT), DEV_DB_DIR: DATA }, /PostgreSQL de desarrollo/);
  if (fresh) {
    console.log("▸ Datos de ejemplo (desde cero)");
    await run(["scripts/db.mjs", "reset"]);
  } else {
    await run(["scripts/db.mjs", "migrate"]);
  }
  if (args.includes("--ia-simulada")) {
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

  Qué probar:
   · «Hoy» (la portada): el parte del día.
   · Ajustes → Correo, calendario y documentos → «Conectar Microsoft 365» o «Conectar Google Workspace»
     (simulados: no se envía nada de verdad).
   · Un deal → «Correo» → «Insertar mis huecos», y «Documentos» → buscar «paco».
   · Bandeja de la IA → «Revisar ahora».
   · Ajustes → Modelo de IA: pon tu clave real para ver resúmenes de verdad.

  Para parar: Ctrl+C. Los datos se guardan en .demo-data (npm run demo -- --reset para empezar de cero).
`);
} catch (err) {
  console.error(`✗ ${err.message}`);
  stop();
  process.exit(1);
}
