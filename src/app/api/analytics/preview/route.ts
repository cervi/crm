import { NextResponse, type NextRequest } from "next/server";
import { normalizeConfig, runWidget } from "@/lib/analytics";
import { toUserMessage, UserError } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Calcula un widget sin guardarlo (vista previa del editor). */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const config = await normalizeConfig(body?.config);
    const result = await runWidget(config);
    return NextResponse.json({ config, result });
  } catch (err) {
    return NextResponse.json({ error: toUserMessage(err) }, { status: err instanceof UserError ? 422 : 500 });
  }
}
