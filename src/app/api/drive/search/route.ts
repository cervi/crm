import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { searchDriveFiles } from "@/lib/mailbox";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Busca archivos por nombre en el Drive / OneDrive del responsable del deal (o de la primera cuenta conectada). */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const dealId = q.get("deal");
  const [deal] = isId(dealId) ? await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM deals WHERE id = ${dealId}` : [];
  try {
    return NextResponse.json(await searchDriveFiles(deal?.owner_id ?? null, q.get("q") ?? ""));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo buscar." }, { status: 409 });
  }
}
