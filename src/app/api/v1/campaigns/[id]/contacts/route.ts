import { NextResponse, type NextRequest } from "next/server";
import { checkApiKey } from "@/lib/api-auth";
import { addContacts, getCampaign, type ContactInput } from "@/lib/campaigns";
import { INTEGRATION_ACTOR } from "@/lib/events";
import { toUserMessage, UserError } from "@/lib/errors";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";

/**
 * Añadir contactos a una campaña de outbound (desde un proveedor de datos o
 * una IA que prepara las listas). Cuerpo: {"contacts": [{"email", "full_name",
 * "company", "job_title", "domain", "phone"}]}. Se verifican y personalizan
 * solos; nadie se repite en la misma campaña.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = checkApiKey(req.headers);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  if (!isId(id) || !(await getCampaign(id))) return NextResponse.json({ error: "La campaña no existe." }, { status: 404 });
  let body: { contacts?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Se esperaba JSON." }, { status: 400 }); }
  if (!Array.isArray(body?.contacts)) return NextResponse.json({ error: "Falta «contacts» (una lista)." }, { status: 400 });
  const contacts = (body.contacts as Record<string, unknown>[]).map((c) => Object.fromEntries(
    ["email", "full_name", "first_name", "last_name", "company", "domain", "job_title", "phone"]
      .map((k) => [k, typeof c?.[k] === "string" ? String(c[k]).slice(0, 300) : undefined]),
  ) as ContactInput);
  try {
    const result = await addContacts(INTEGRATION_ACTOR, id, contacts, "api");
    return NextResponse.json(result, { status: result.added ? 201 : 200 });
  } catch (err) {
    return NextResponse.json({ error: toUserMessage(err) }, { status: err instanceof UserError ? 422 : 500 });
  }
}
