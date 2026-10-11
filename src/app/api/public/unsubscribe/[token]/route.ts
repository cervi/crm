import { NextResponse, type NextRequest } from "next/server";
import { personFromToken, unsubscribe } from "@/lib/campaigns";

export const dynamic = "force-dynamic";

/**
 * Baja con un clic (RFC 8058): Gmail y Yahoo hacen un POST a la dirección de
 * la cabecera List-Unsubscribe cuando el destinatario pulsa «Cancelar
 * suscripción». Con GET (alguien abre el enlace) se va a la página de baja.
 */
export async function POST(_: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const personId = personFromToken((await params).token);
  if (!personId) return NextResponse.json({ error: "Enlace no válido" }, { status: 400 });
  await unsubscribe(personId, "un clic (cabecera del correo)");
  return new NextResponse(null, { status: 200 });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return NextResponse.redirect(new URL(`/u/${encodeURIComponent((await params).token)}`, req.url));
}
