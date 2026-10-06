import postgres from "postgres";

// Una única conexión compartida (también entre recargas en desarrollo).
const globalForDb = globalThis as unknown as { sql?: postgres.Sql };

export const sql =
  globalForDb.sql ??
  postgres(process.env.DATABASE_URL ?? "postgres://crm:crm@localhost:5432/crm", {
    max: Number(process.env.DB_POOL_MAX ?? 10),
  });

if (process.env.NODE_ENV !== "production") globalForDb.sql = sql;

/** Conexión o transacción: las funciones de dominio aceptan cualquiera de las dos. */
export type Db = postgres.Sql;

/** Ejecuta `fn` dentro de una transacción. */
export function transaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  return sql.begin((tx) => fn(tx as unknown as Db)) as Promise<T>;
}

export const json = (value: unknown) => sql.json(value as postgres.JSONValue);
