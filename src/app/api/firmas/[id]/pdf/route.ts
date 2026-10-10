import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { requestPdf } from "@/lib/esign";
import { isId } from "@/lib/validation";
import { pdfResponse } from "@/lib/esign-request";

export const dynamic = "force-dynamic";

/** El PDF original (para colocar campos o descargarlo) o el firmado. ?v=signed · ?dl=1 para descargar. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const f = isId(id) ? await requestPdf(id, q.get("v") === "signed" ? "signed" : "original") : null;
  if (!f) return NextResponse.json({ error: "No existe." }, { status: 404 });
  return pdfResponse(f, q.get("dl") === "1");
}
