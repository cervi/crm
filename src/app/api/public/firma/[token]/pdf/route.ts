import { NextResponse } from "next/server";
import { signerPdf } from "@/lib/esign";
import { pdfResponse } from "@/lib/esign-request";

export const dynamic = "force-dynamic";

/** PDF para quien firma (con su enlace personal). ?v=signed cuando ya han firmado todos. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const q = new URL(req.url).searchParams;
  const f = await signerPdf((await params).token, q.get("v") === "signed" ? "signed" : "original");
  if (!f) return NextResponse.json({ error: "No disponible." }, { status: 404 });
  return pdfResponse(f, q.get("dl") === "1");
}
