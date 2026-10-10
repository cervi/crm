import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { libraryFile } from "@/lib/library";

export const dynamic = "force-dynamic";

/** Ver o descargar un documento de la biblioteca (desde dentro del CRM: no cuenta como apertura). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  const f = await libraryFile((await params).id);
  if (!f) return NextResponse.json({ error: "No existe." }, { status: 404 });
  if (f.kind === "link" && f.url) return NextResponse.redirect(f.url);
  const mime = f.mime ?? "application/octet-stream";
  const inline = new URL(req.url).searchParams.get("ver") === "1" && /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/.test(mime);
  return new NextResponse(new Uint8Array(f.data!), {
    headers: {
      "content-type": inline ? mime : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.file_name ?? f.name)}`,
      "x-content-type-options": "nosniff", "cache-control": "private, max-age=0",
    },
  });
}
