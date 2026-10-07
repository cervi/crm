import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { personVCard } from "@/lib/contact-workspace";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Tarjeta de contacto (.vcf) para guardarlo en el móvil o en Outlook. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  const { id } = await params;
  const card = isId(id) ? await personVCard(id) : null;
  if (!card) return NextResponse.json({ error: "No existe." }, { status: 404 });
  return new NextResponse(card.text, {
    headers: { "content-type": "text/vcard; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(card.name)}.vcf` },
  });
}
