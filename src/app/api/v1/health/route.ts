import { sql } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Comprobación de que la app está viva y llega a la base de datos (para el balanceador y el despliegue). */
export async function GET() {
  try {
    await sql`SELECT 1`;
    return Response.json({ ok: true, db: true }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false, db: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
