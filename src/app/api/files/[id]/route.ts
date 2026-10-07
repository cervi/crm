import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { getFile } from "@/lib/files";

export const dynamic = "force-dynamic";

/** Descarga (o vista, si es imagen o PDF y se pide ?ver=1). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  const f = await getFile((await params).id);
  if (!f) return NextResponse.json({ error: "No existe." }, { status: 404 });
  const inline = new URL(req.url).searchParams.get("ver") === "1" && /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/.test(f.mime);
  return new NextResponse(new Uint8Array(f.data), {
    headers: {
      "content-type": inline ? f.mime : "application/octet-stream",
      "content-length": String(f.size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "cache-control": "private, max-age=0",
    },
  });
}
