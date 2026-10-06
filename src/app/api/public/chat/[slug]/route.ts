import { NextResponse } from "next/server";
import { chat } from "@/lib/webforms";
import { toUserMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Chat con IA de un formulario web (público). */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const body = await req.json().catch(() => null);
  const who = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "anon";
  try {
    return NextResponse.json(await chat(slug, body?.messages, who));
  } catch (err) {
    return NextResponse.json({ error: toUserMessage(err) }, { status: 400 });
  }
}
