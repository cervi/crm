import { sql } from "./db";
import { UserError } from "./errors";
import type { MailAttachment } from "./integrations/types";
import { isId } from "./validation";

// ===========================================================================
// Adjuntos de los correos del CRM: archivos del deal (o del contacto) y
// documentos de la biblioteca. Se mandan dentro del correo; para lo grande,
// mejor un enlace con seguimiento (y así además se sabe si lo abren).
// ===========================================================================

export const MAX_ATTACH_BYTES = 3 * 1024 * 1024;   // lo que admiten Microsoft 365 y Gmail en un envío normal
export type AttachRef = { type: "file" | "library"; id: string };
export type ResolvedAttachment = MailAttachment & { file_id: string | null; library_id: string | null; size: number };

export function parseAttachRefs(raw: unknown): AttachRef[] {
  if (!raw) return [];
  let list: unknown;
  try { list = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new UserError("Adjuntos no válidos."); }
  if (!Array.isArray(list)) return [];
  const out = list.filter((x): x is AttachRef => x && (x.type === "file" || x.type === "library") && isId(x.id)).slice(0, 10);
  return out.filter((x, i) => out.findIndex((y) => y.id === x.id) === i);
}

export async function resolveAttachments(refs: AttachRef[]): Promise<ResolvedAttachment[]> {
  if (!refs.length) return [];
  const fileIds = refs.filter((r) => r.type === "file").map((r) => r.id), libIds = refs.filter((r) => r.type === "library").map((r) => r.id);
  const [files, libs] = await Promise.all([
    fileIds.length ? sql<{ id: string; name: string; mime: string; data: Buffer }[]>`SELECT id, name, mime, data FROM files WHERE id = ANY(${fileIds}::uuid[])` : [],
    libIds.length ? sql<{ id: string; name: string; file_name: string | null; mime: string | null; data: Buffer | null }[]>`
      SELECT id, name, file_name, mime, data FROM library_items WHERE id = ANY(${libIds}::uuid[]) AND kind = 'file' AND archived_at IS NULL` : [],
  ]);
  const out: ResolvedAttachment[] = [
    ...files.map((f) => ({ name: f.name, mime: f.mime, data: new Uint8Array(f.data), file_id: f.id, library_id: null, size: f.data.length })),
    ...libs.filter((l) => l.data).map((l) => ({ name: l.file_name ?? l.name, mime: l.mime ?? "application/octet-stream", data: new Uint8Array(l.data!),
                                                 file_id: null, library_id: l.id, size: l.data!.length })),
  ];
  if (out.length !== refs.length) throw new UserError("Algún adjunto ya no existe. Quítalo y vuelve a intentarlo.");
  const total = out.reduce((n, a) => n + a.size, 0);
  if (total > MAX_ATTACH_BYTES) throw new UserError(`Los adjuntos ocupan ${(total / 1048576).toFixed(1)} MB y el máximo por correo son 3 MB. Mándalos como enlace con seguimiento.`);
  return out;
}

export async function saveAttachmentRefs(emailId: string, list: ResolvedAttachment[]) {
  for (const a of list) {
    await sql`INSERT INTO email_attachments (email_id, file_id, library_id, name, size) VALUES (${emailId}, ${a.file_id}, ${a.library_id}, ${a.name}, ${a.size})`;
  }
}

/** Adjuntos guardados de un correo programado, listos para enviar. */
export async function storedAttachments(emailId: string): Promise<ResolvedAttachment[]> {
  const rows = await sql<{ file_id: string | null; library_id: string | null }[]>`SELECT file_id, library_id FROM email_attachments WHERE email_id = ${emailId}`;
  return resolveAttachments(rows.map((r) => (r.file_id ? { type: "file" as const, id: r.file_id } : { type: "library" as const, id: r.library_id! })).filter((r) => r.id));
}

export async function attachmentsFor(emailIds: string[]) {
  if (!emailIds.length) return new Map<string, { name: string; size: number }[]>();
  const rows = await sql<{ email_id: string; name: string; size: number }[]>`SELECT email_id, name, size FROM email_attachments WHERE email_id = ANY(${emailIds}::uuid[])`;
  const m = new Map<string, { name: string; size: number }[]>();
  for (const r of rows) m.set(r.email_id, [...(m.get(r.email_id) ?? []), { name: r.name, size: r.size }]);
  return m;
}
