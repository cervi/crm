import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor, type EntityType } from "./events";
import { isId } from "./validation";

// ===========================================================================
// Archivos de un deal, contacto, empresa o lead (pestaña «Archivos» de
// Pipedrive). Se guardan en la base de datos: sin almacenamiento aparte.
// ===========================================================================

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export type FileRef = { deal_id?: string | null; person_id?: string | null; organization_id?: string | null; lead_id?: string | null };
export type StoredFile = { id: string; name: string; mime: string; size: number; created_at: Date; uploader: string | null;
                           deal_id: string | null; deal_title: string | null };

/** Tipos que nunca se aceptan (ejecutables y scripts). */
const BLOCKED = /\.(exe|bat|cmd|com|msi|scr|ps1|sh|js|vbs|jar|app|dmg|apk|html?|svg)$/i;

export async function listFiles(ref: FileRef): Promise<StoredFile[]> {
  return sql<StoredFile[]>`
    SELECT f.id, f.name, f.mime, f.size, f.created_at, u.name AS uploader, f.deal_id, d.title AS deal_title
    FROM files f LEFT JOIN users u ON u.id = f.uploaded_by LEFT JOIN deals d ON d.id = f.deal_id
    WHERE (${ref.deal_id ?? null}::uuid IS NOT NULL AND f.deal_id = ${ref.deal_id ?? null}::uuid)
       OR (${ref.person_id ?? null}::uuid IS NOT NULL AND f.person_id = ${ref.person_id ?? null}::uuid)
       OR (${ref.organization_id ?? null}::uuid IS NOT NULL AND (f.organization_id = ${ref.organization_id ?? null}::uuid
           OR f.deal_id IN (SELECT id FROM deals WHERE organization_id = ${ref.organization_id ?? null}::uuid)))
       OR (${ref.lead_id ?? null}::uuid IS NOT NULL AND f.lead_id = ${ref.lead_id ?? null}::uuid)
    ORDER BY f.created_at DESC LIMIT 200`;
}

function target(ref: FileRef): [EntityType, string] {
  for (const [k, t] of [["deal_id", "deal"], ["person_id", "person"], ["organization_id", "organization"], ["lead_id", "lead"]] as const) {
    const v = ref[k];
    if (v) { if (!isId(v)) throw new UserError("Referencia no válida."); return [t, v]; }
  }
  throw new UserError("El archivo debe ir asociado a algo.");
}

export async function addFile(actor: Actor, ref: FileRef, file: { name: string; type: string; bytes: Uint8Array }): Promise<string> {
  const [type, id] = target(ref);
  const name = file.name.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 255) || "archivo";
  if (!file.bytes.length) throw new UserError("El archivo está vacío.");
  if (file.bytes.length > MAX_FILE_BYTES) throw new UserError("El archivo es demasiado grande (máximo 8 MB). Para más, enlaza el documento de OneDrive o Drive.");
  if (BLOCKED.test(name)) throw new UserError("Ese tipo de archivo no se puede subir.");
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "application/octet-stream";
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO files (name, mime, size, data, deal_id, person_id, organization_id, lead_id, uploaded_by)
    VALUES (${name}, ${mime}, ${file.bytes.length}, ${Buffer.from(file.bytes)}, ${ref.deal_id ?? null}, ${ref.person_id ?? null},
            ${ref.organization_id ?? null}, ${ref.lead_id ?? null}, ${actor.id}) RETURNING id`;
  await recordEvent(sql, actor, type, id, "file.added", { file_id: row.id, name, size: file.bytes.length });
  return row.id;
}

export async function getFile(id: string) {
  if (!isId(id)) return null;
  const [f] = await sql<{ name: string; mime: string; size: number; data: Buffer }[]>`SELECT name, mime, size, data FROM files WHERE id = ${id}`;
  return f ?? null;
}

export async function deleteFile(actor: Actor, id: string) {
  const [f] = await sql<{ name: string; deal_id: string | null; person_id: string | null; organization_id: string | null; lead_id: string | null }[]>`
    DELETE FROM files WHERE id = ${id} RETURNING name, deal_id, person_id, organization_id, lead_id`;
  if (!f) return;
  const [type, eid] = target(f);
  await recordEvent(sql, actor, type, eid, "file.removed", { name: f.name });
}

export const fileSize = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
