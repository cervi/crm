#!/usr/bin/env node
// Base de datos de desarrollo sin Docker: PostgreSQL (PGlite) dentro de Node,
// escuchando en localhost:5432 con el protocolo normal de PostgreSQL.
// Los datos se guardan en .pgdata/ (ignorado por git).
//
//   npm run db:dev        (déjalo abierto en otra terminal)
//
// En producción se usa un PostgreSQL normal (RDS, Supabase, Neon, Docker…).
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const port = Number(process.env.DEV_DB_PORT ?? 5432);
const db = await PGlite.create(process.env.DEV_DB_DIR ?? "./.pgdata");
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
console.log(`PostgreSQL de desarrollo en postgres://crm:crm@localhost:${port}/crm`);

const stop = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
