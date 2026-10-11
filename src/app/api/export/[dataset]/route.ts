import { toCsv, type Separator } from "@/lib/csv";
import { DATASETS, exportFilename, getCsvSeparator } from "@/lib/export";
import { UserError } from "@/lib/errors";
import { activityTypes } from "@/lib/activity-types";
import { currentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { getRules, raiseAlert } from "@/lib/security";

export const dynamic = "force-dynamic";

/** Descarga en CSV de un listado con sus filtros (los mismos parámetros que la pantalla). */
export async function GET(req: Request, { params }: { params: Promise<{ dataset: string }> }) {
  const { dataset } = await params;
  const def = DATASETS[dataset];
  if (!def) return new Response("Exportación no encontrada.", { status: 404 });
  const q = new URL(req.url).searchParams;
  const me = await currentUser();
  if (!me) return new Response("Inicia sesión.", { status: 401 });
  // Regla de seguridad: solo los administradores descargan datos.
  if ((await getRules()).export_admin_only && me.role !== "admin") return new Response("Solo los administradores pueden descargar datos.", { status: 403 });
  try {
    await activityTypes(); // etiquetas de los tipos de actividad
    const table = await def.run(q);
    const sepParam = q.get("sep");
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    await sql`INSERT INTO export_log (user_id, dataset, rows, ip) VALUES (${me.id}, ${dataset}, ${table.rows.length}, ${ip})`;
    await raiseAlert({ kind: "export", severity: table.rows.length >= 500 ? "warn" : "info", actorId: me.id,
                       title: `${me.name} ha descargado ${table.name} (${table.rows.length} filas)`, detail: { dataset, rows: table.rows.length } });
    const sep: Separator = sepParam === "," ? "," : sepParam === "tab" ? "\t" : sepParam === ";" ? ";" : await getCsvSeparator();
    return new Response(toCsv(table.headers, table.rows, sep), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${exportFilename(table.name)}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof UserError) return new Response(err.message, { status: 400 });
    console.error("[exportar]", err);
    return new Response("No se pudo exportar.", { status: 500 });
  }
}
