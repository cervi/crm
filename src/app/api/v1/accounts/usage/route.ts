import { NextResponse, type NextRequest } from "next/server";
import { checkApiKey } from "@/lib/api-auth";
import { recordUsage } from "@/lib/accounts";
import { toUserMessage, UserError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/**
 * Datos de uso del producto para Customer Success (desde vuestra plataforma,
 * un script o un agente). Uno o varios: {"domain" | "organization_id",
 * "metric": "usuarios_activos", "value": 42, "at"?: ISO}. Métricas con
 * significado: licencias_en_uso (contra las licencias del contrato),
 * usuarios_activos y tickets_abiertos.
 */
export async function POST(req: NextRequest) {
  const auth = checkApiKey(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Se esperaba JSON." }, { status: 400 }); }
  const items = Array.isArray(body) ? body : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: unknown[] }).data : [body];
  if (items.length === 0 || items.length > 1000) return NextResponse.json({ error: "Entre 1 y 1000 datos por llamada." }, { status: 400 });
  const results: unknown[] = [];
  for (const raw of items) {
    const it = (raw ?? {}) as Record<string, unknown>;
    try {
      results.push({ ok: true, ...(await recordUsage({
        organization_id: typeof it.organization_id === "string" ? it.organization_id : undefined, domain: typeof it.domain === "string" ? it.domain : undefined,
        metric: String(it.metric ?? ""), value: Number(it.value), at: typeof it.at === "string" ? it.at : null, source: "api",
      })) });
    } catch (err) {
      results.push({ ok: false, error: toUserMessage(err) });
      if (!(err instanceof UserError)) console.error("[uso]", err);
    }
  }
  const okCount = results.filter((r) => (r as { ok: boolean }).ok).length;
  return NextResponse.json({ saved: okCount, results }, { status: okCount ? 201 : 422 });
}
