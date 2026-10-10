import { NextResponse } from "next/server";

/** IP y navegador de quien firma, para el registro de auditoría. */
export function clientInfo(h: Headers): { ip: string | null; ua: string | null } {
  const fwd = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = (fwd || h.get("x-real-ip") || "").slice(0, 64) || null;
  return { ip, ua: h.get("user-agent")?.slice(0, 300) ?? null };
}

/** Respuesta con un PDF (para ver o descargar). */
export function pdfResponse(f: { name: string; data: Buffer }, download: boolean) {
  return new NextResponse(new Uint8Array(f.data), {
    headers: {
      "content-type": "application/pdf",
      "content-length": String(f.data.length),
      "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=0",
    },
  });
}
