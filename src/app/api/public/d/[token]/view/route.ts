import { NextResponse } from "next/server";
import { clientInfo } from "@/lib/esign-request";
import { pingDocView, recordDocView } from "@/lib/library";

export const dynamic = "force-dynamic";

/** El visor avisa al abrirse ({}) y luego manda el tiempo que lleva ({ view, seconds, page }). */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const body = await req.json().catch(() => ({})) as { view?: string; seconds?: number; page?: number };
  if (body.view) {
    await pingDocView(token, body.view, Number(body.seconds) || 0, Number(body.page) || null).catch(() => null);
    return NextResponse.json({ ok: true });
  }
  const { ip, ua } = clientInfo(req.headers);
  const view = await recordDocView(token, ip, ua).catch(() => null);
  return NextResponse.json({ view });
}
