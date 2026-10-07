import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { addFile } from "@/lib/files";
import { toUserMessage } from "@/lib/errors";

export const dynamic = "force-dynamic";

/** Subida de archivos (multipart): file + deal_id | person_id | organization_id | lead_id. */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  if (me.role === "viewer") return NextResponse.json({ error: "Tu usuario es de solo lectura." }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const files = form ? form.getAll("file").filter((f): f is File => typeof f === "object" && "arrayBuffer" in f) : [];
  if (!files.length) return NextResponse.json({ error: "Elige un archivo." }, { status: 400 });
  const ref = Object.fromEntries(["deal_id", "person_id", "organization_id", "lead_id"].map((k) => [k, (form!.get(k) as string) || null]));
  try {
    const ids: string[] = [];
    for (const f of files.slice(0, 10)) ids.push(await addFile({ type: "user", id: me.id }, ref, { name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) }));
    return NextResponse.json({ ids });
  } catch (err) {
    return NextResponse.json({ error: toUserMessage(err) }, { status: 400 });
  }
}
