import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-static";

/** El «worker» de pdf.js (lo que pinta los PDF en el navegador), servido desde el propio CRM. */
export async function GET() {
  const file = path.join(process.cwd(), "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
  const body = await readFile(file);
  return new Response(new Uint8Array(body), {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}
