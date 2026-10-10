import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { toUserMessage } from "@/lib/errors";
import { addLibraryFile, replaceLibraryFile } from "@/lib/library";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Subir a la biblioteca (multipart: file, name, folder, description) o sustituir el archivo (replace=<id>). */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  if (me.role === "viewer") return NextResponse.json({ error: "Tu usuario es de solo lectura." }, { status: 403 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !file || typeof file !== "object" || !("arrayBuffer" in file) || !file.size) return NextResponse.json({ error: "Elige un archivo." }, { status: 400 });
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const replace = form.get("replace");
    if (isId(replace)) { await replaceLibraryFile(replace, { fileName: file.name, mime: file.type, bytes }); return NextResponse.json({ id: replace }); }
    const id = await addLibraryFile({ type: "user", id: me.id }, {
      name: form.get("name") as string, folder: form.get("folder") as string, description: form.get("description") as string,
      fileName: file.name, mime: file.type, bytes,
    });
    return NextResponse.json({ id });
  } catch (err) {
    return NextResponse.json({ error: toUserMessage(err) }, { status: 400 });
  }
}
