#!/usr/bin/env node
// Utilidades de base de datos (solo necesita Node; no requiere psql).
//
//   node scripts/db.mjs migrate   Aplica las migraciones pendientes de db/migrations
//   node scripts/db.mjs seed      Carga los datos de ejemplo (solo desarrollo)
//   node scripts/db.mjs test      Ejecuta las comprobaciones del modelo (db/tests)
//   node scripts/db.mjs reset     Borra todo, migra, carga ejemplos y comprueba (solo desarrollo)
//
// Usa DATABASE_URL (por defecto, la base de datos local de desarrollo).
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.DATABASE_URL ?? "postgres://crm:crm@localhost:5432/crm";
const notices = [];
const sql = postgres(url, { max: 1, onnotice: (n) => notices.push(n.message) });

const file = (rel) => readFile(path.join(root, rel), "utf8");

async function migrate() {
  await sql.unsafe(`SET client_min_messages = warning;
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(path.join(root, "db/migrations"))).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const version = f.replace(/\.sql$/, "");
    const [done] = await sql`SELECT 1 FROM schema_migrations WHERE version = ${version}`;
    if (done) continue;
    console.log(`→ aplicando ${version}`);
    await sql.unsafe(await file(`db/migrations/${f}`));
    await sql`INSERT INTO schema_migrations (version) VALUES (${version})`;
  }
  console.log("✓ migraciones al día");
}

async function seed() {
  await sql.unsafe(await file("db/seed/demo.sql"));
  console.log("✓ datos de ejemplo cargados");
}

async function test() {
  notices.length = 0;
  try {
    // Los resultados llegan como NOTICE: hay que verlos aunque antes se silenciaran.
    await sql.unsafe("SET client_min_messages = notice");
    await sql.unsafe(await file("db/tests/core_test.sql"));
  } catch (err) {
    notices.filter((n) => n.startsWith("OK")).forEach((n) => console.log(n));
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
    return;
  }
  const ok = notices.filter((n) => n.startsWith("OK"));
  ok.forEach((n) => console.log(n));
  if (ok.length === 0) {
    console.error("✗ no se ha recibido ninguna comprobación");
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${ok.length} comprobaciones superadas`);
}

async function reset() {
  await sql.unsafe("SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
  await seed();
  await test();
}

const commands = { migrate, seed, test, reset };
const cmd = commands[process.argv[2]];
if (!cmd) {
  console.error("uso: node scripts/db.mjs {migrate|seed|test|reset}");
  process.exit(2);
}
try {
  await cmd();
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
