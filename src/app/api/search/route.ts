import { NextResponse, type NextRequest } from "next/server";
import { globalSearch } from "@/lib/search";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";
  return NextResponse.json(await globalSearch(q, 5));
}
