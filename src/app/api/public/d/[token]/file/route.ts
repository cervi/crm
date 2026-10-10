import { NextResponse } from "next/server";
import { docBytes } from "@/lib/library";

export const dynamic = "force-dynamic";

/** El archivo de un enlace compartido (para el visor o para descargarlo con ?dl=1). */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const f = await docBytes((await params).token);
  if (!f) return NextResponse.json({ error: "No disponible." }, { status: 404 });
  const dl = new URL(req.url).searchParams.get("dl") === "1";
  const inline = !dl && /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/.test(f.mime);
  return new NextResponse(new Uint8Array(f.data!), {
    headers: {
      "content-type": inline ? f.mime : "application/octet-stream",
      "content-length": String(f.data!.length),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=0",
    },
  });
}
