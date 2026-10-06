import { NextResponse, type NextRequest } from "next/server";
import { checkApiKey } from "@/lib/api-auth";
import { ingestLead } from "@/lib/leads";
import { recomputeScores } from "@/lib/scoring";
import { applyAssignment } from "@/lib/assignment";
import { INTEGRATION_ACTOR } from "@/lib/events";
import { toUserMessage, UserError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Entrada de leads desde formularios, webinars, Zapier/Make o webhooks.
 * Acepta JSON o application/x-www-form-urlencoded. Ver /settings/api.
 */
export async function POST(req: NextRequest) {
  const auth = checkApiKey(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: Record<string, unknown>;
  try {
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json")) {
      body = await req.json();
    } else if (type.includes("form")) {
      body = Object.fromEntries(await req.formData());
    } else {
      return NextResponse.json({ error: "Usa Content-Type application/json o un formulario." }, { status: 415 });
    }
  } catch {
    return NextResponse.json({ error: "El cuerpo de la petición no es válido." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Se esperaba un objeto." }, { status: 400 });
  }

  // Tolerancia con formatos habituales de formularios.
  if (typeof body.tags === "string") body.tags = body.tags.split(",").map((t) => t.trim()).filter(Boolean);
  if (typeof body.consent === "string") body.consent = ["true", "on", "1", "yes", "si", "sí"].includes(body.consent.toLowerCase());
  if (typeof body.value === "string" && body.value.trim() === "") delete body.value;

  try {
    const result = await ingestLead(INTEGRATION_ACTOR, body);
    // Puntuación y reparto al momento (sin esperar a la revisión periódica).
    await recomputeScores(result.lead_id).then(() => applyAssignment()).catch((err) => console.error("[puntuación/reparto]", err));
    return NextResponse.json(result, { status: result.created.lead || result.created.deal ? 201 : 200 });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const status = err instanceof UserError ? 422 : code === "23505" ? 409 : 500;
    return NextResponse.json({ error: toUserMessage(err) }, { status });
  }
}
