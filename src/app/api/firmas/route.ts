import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { createRequest } from "@/lib/esign";
import { toUserMessage } from "@/lib/errors";
import { getFile } from "@/lib/files";

export const dynamic = "force-dynamic";

/** Nuevo documento para firmar: un PDF subido (file) o uno de los archivos del deal (file_id). */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  if (me.role === "viewer") return NextResponse.json({ error: "Tu usuario es de solo lectura." }, { status: 403 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Elige un PDF." }, { status: 400 });
  const dealId = (form.get("deal_id") as string) || null;
  try {
    let name = "", bytes: Uint8Array | null = null;
    const up = form.get("file");
    if (up && typeof up === "object" && "arrayBuffer" in up && up.size > 0) {
      name = up.name; bytes = new Uint8Array(await up.arrayBuffer());
    } else if (form.get("file_id")) {
      const f = await getFile(String(form.get("file_id")));
      if (f) { name = f.name; bytes = new Uint8Array(f.data); }
    }
    if (!bytes) return NextResponse.json({ error: "Elige un PDF." }, { status: 400 });
    const id = await createRequest({ type: "user", id: me.id }, { dealId, title: (form.get("title") as string) || null, fileName: name, bytes });
    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json({ error: toUserMessage(err) }, { status: 400 });
  }
}
