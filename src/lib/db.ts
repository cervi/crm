import postgres from "postgres";

// Una única conexión compartida (también entre recargas en desarrollo).
const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

export const sql =
  globalForDb.sql ??
  postgres(process.env.DATABASE_URL ?? "postgres://crm:crm@localhost:5432/crm", {
    max: 10,
  });

if (process.env.NODE_ENV !== "production") globalForDb.sql = sql;
