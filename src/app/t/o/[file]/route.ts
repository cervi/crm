import { recordOpen } from "@/lib/emails";

export const dynamic = "force-dynamic";

// GIF transparente de 1×1.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** Píxel de apertura de un correo: /t/o/<token>.gif */
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const token = file.replace(/\.gif$/, "");
  if (/^[A-Za-z0-9_-]{20,40}$/.test(token)) await recordOpen(token, req.headers).catch((err) => console.error("[apertura]", err));
  return new Response(PIXEL, {
    headers: { "content-type": "image/gif", "cache-control": "no-store, no-cache, must-revalidate, private", "content-length": String(PIXEL.length) },
  });
}
