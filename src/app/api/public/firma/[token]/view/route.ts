import { NextResponse } from "next/server";
import { recordView } from "@/lib/esign";
import { clientInfo } from "@/lib/esign-request";

export const dynamic = "force-dynamic";

/** La página de firma avisa de que se ha abierto (desde el navegador: los antivirus del correo no cuentan). */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { ip, ua } = clientInfo(req.headers);
  await recordView((await params).token, ip, ua).catch(() => null);
  return NextResponse.json({ ok: true });
}
