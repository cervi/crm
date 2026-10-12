import { isOn } from "@/lib/switches";
import { NextResponse, type NextRequest } from "next/server";
import { checkApiKey } from "@/lib/api-auth";
import { ingestMeetingNote, noteFromPayload } from "@/lib/meeting-notes";
import { toUserMessage, UserError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Notas de reuniones grabadas por una IA (Granola vía Zapier, Make, n8n…).
 * Acepta JSON o formulario con nombres de campo flexibles. Ver /reuniones.
 */
export async function POST(req: NextRequest) {
  const auth = await checkApiKey(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!(await isOn("meeting_notes"))) return NextResponse.json({ error: "La importación de notas de reuniones está desactivada en este CRM." }, { status: 503 });
  let body: Record<string, unknown>;
  try {
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json")) body = await req.json();
    else if (type.includes("form")) body = Object.fromEntries(await req.formData());
    else return NextResponse.json({ error: "Usa Content-Type application/json o un formulario." }, { status: 415 });
  } catch {
    return NextResponse.json({ error: "El cuerpo de la petición no es válido." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Se esperaba un objeto." }, { status: 400 });
  try {
    const note = noteFromPayload(body, req.nextUrl.searchParams.get("source") ?? "api");
    if (note.started_at && Number.isNaN(note.started_at.getTime())) note.started_at = null;
    const r = await ingestMeetingNote(note);
    return NextResponse.json({ id: r.id, status: r.status, reason: r.reason, duplicate: r.duplicate }, { status: r.duplicate ? 200 : 201 });
  } catch (err) {
    if (err instanceof UserError) return NextResponse.json({ error: err.message }, { status: 422 });
    console.error("[api meetings]", err);
    return NextResponse.json({ error: toUserMessage(err) }, { status: 500 });
  }
}
