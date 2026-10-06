import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { guessMapping, importCsv, IMPORT_FIELDS, parseCsv, type ImportField } from "@/lib/csv-import";
import { toUserMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Importación de CSV. { text, step: "preview" } devuelve columnas, campos
 * propuestos y unas filas de muestra; { text, mapping, mode, source } importa.
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  if (me.role === "viewer") return NextResponse.json({ error: "Tu usuario es de solo lectura." }, { status: 403 });
  const body = await req.json().catch(() => null);
  const text = typeof body?.text === "string" ? body.text : "";
  if (!text || text.length > 15_000_000) return NextResponse.json({ error: "Archivo vacío o demasiado grande (máximo 15 MB)." }, { status: 400 });
  try {
    if (body.step === "preview") {
      const rows = parseCsv(text);
      if (rows.length === 0) return NextResponse.json({ error: "No se han encontrado filas." }, { status: 400 });
      return NextResponse.json({ headers: rows[0], mapping: guessMapping(rows[0]), sample: rows.slice(1, 6), total: rows.length - 1 });
    }
    const mapping = Array.isArray(body.mapping) ? body.mapping.map((m: unknown) => (typeof m === "string" && m in IMPORT_FIELDS ? (m as ImportField) : "")) : [];
    const mode = body.mode === "contacts" ? "contacts" : "leads";
    const source = typeof body.source === "string" && body.source.trim() ? body.source.trim().slice(0, 100) : "importación CSV";
    return NextResponse.json(await importCsv({ type: "user", id: me.id }, text, mapping, mode, source));
  } catch (err) {
    return NextResponse.json({ error: toUserMessage(err) }, { status: 400 });
  }
}
