import { randomBytes } from "node:crypto";
import { sql } from "./db";
import { UserError } from "./errors";
import { INTEGRATION_ACTOR, recordEvent, type Actor } from "./events";
import { publicBase } from "./email-track";
import { notify } from "./notifications";
import { isId } from "./validation";

// ===========================================================================
// Biblioteca de documentos del equipo (presentaciones, casos de éxito,
// tarifas…) y enlaces con seguimiento: cada vez que se comparte un documento
// con alguien se crea un enlace personal (/d/<token>) y se sabe cuántas veces
// lo abre, cuándo y cuánto tiempo lo mira. Vale también para los archivos de
// un deal.
// ===========================================================================

export const MAX_LIBRARY_BYTES = 25 * 1024 * 1024;
export const FOLDERS = ["Presentaciones", "Casos de éxito", "Tarifas y propuestas", "Contratos y legal", "Producto", "General"] as const;
const BLOCKED = /\.(exe|bat|cmd|com|msi|scr|ps1|sh|js|vbs|jar|app|dmg|apk|html?|svg)$/i;

export type LibraryItem = {
  id: string; name: string; description: string | null; folder: string; kind: "file" | "link"; file_name: string | null; mime: string | null;
  size: number | null; url: string | null; created_by: string | null; creator: string | null; created_at: Date; updated_at: Date; archived_at: Date | null;
  shared: number; opened: number; views: number; seconds: number; last_viewed_at: Date | null;
};

export async function listLibrary(opts: { folder?: string | null; q?: string | null; archived?: boolean } = {}): Promise<LibraryItem[]> {
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  return sql<LibraryItem[]>`
    SELECT i.id, i.name, i.description, i.folder, i.kind, i.file_name, i.mime, i.size, i.url, i.created_by, u.name AS creator,
           i.created_at, i.updated_at, i.archived_at,
           count(l.id)::int AS shared, count(l.id) FILTER (WHERE l.view_count > 0)::int AS opened,
           coalesce(sum(l.view_count), 0)::int AS views, coalesce(sum(l.seconds), 0)::int AS seconds, max(l.last_viewed_at) AS last_viewed_at
    FROM library_items i LEFT JOIN users u ON u.id = i.created_by LEFT JOIN doc_links l ON l.library_id = i.id
    WHERE (${opts.archived ?? false} OR i.archived_at IS NULL)
      AND (${opts.folder ?? null}::text IS NULL OR i.folder = ${opts.folder ?? null})
      AND (${q}::text IS NULL OR i.name ILIKE ${q} OR i.description ILIKE ${q})
    GROUP BY i.id, u.name
    ORDER BY i.archived_at NULLS FIRST, i.folder, i.name`;
}

export async function libraryFolders(): Promise<string[]> {
  const rows = await sql<{ folder: string }[]>`SELECT DISTINCT folder FROM library_items WHERE archived_at IS NULL ORDER BY folder`;
  return [...new Set([...rows.map((r) => r.folder), ...FOLDERS])];
}

const cleanFolder = (v: unknown) => String(v ?? "").trim().slice(0, 60) || "General";

export async function addLibraryFile(actor: Actor, v: { name?: string | null; folder?: string | null; description?: string | null; fileName: string; mime: string; bytes: Uint8Array }) {
  if (!v.bytes.length) throw new UserError("El archivo está vacío.");
  if (v.bytes.length > MAX_LIBRARY_BYTES) throw new UserError("El archivo es demasiado grande (máximo 25 MB). Para vídeos o archivos enormes, añade un enlace.");
  if (BLOCKED.test(v.fileName)) throw new UserError("Ese tipo de archivo no se puede subir.");
  const fileName = v.fileName.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 255);
  const name = (v.name?.trim() || fileName.replace(/\.[a-z0-9]{2,5}$/i, "")).slice(0, 200);
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(v.mime) ? v.mime : "application/octet-stream";
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO library_items (name, description, folder, kind, file_name, mime, size, data, created_by)
    VALUES (${name}, ${v.description?.trim().slice(0, 1000) || null}, ${cleanFolder(v.folder)}, 'file', ${fileName}, ${mime}, ${v.bytes.length},
            ${Buffer.from(v.bytes)}, ${actor.id}) RETURNING id`;
  return r.id;
}

export async function addLibraryLink(actor: Actor, data: Record<string, unknown>) {
  const url = String(data.url ?? "").trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new UserError("Pon un enlace que empiece por https://");
  const name = String(data.name ?? "").trim().slice(0, 200);
  if (!name) throw new UserError("Ponle un nombre.");
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO library_items (name, description, folder, kind, url, created_by)
    VALUES (${name}, ${String(data.description ?? "").trim().slice(0, 1000) || null}, ${cleanFolder(data.folder)}, 'link', ${url.slice(0, 2000)}, ${actor.id})
    RETURNING id`;
  return r.id;
}

export async function updateLibraryItem(id: string, data: Record<string, unknown>) {
  const name = String(data.name ?? "").trim().slice(0, 200);
  if (!name) throw new UserError("Ponle un nombre.");
  const url = data.url !== undefined ? String(data.url).trim() : null;
  if (url !== null && url !== "" && !/^https?:\/\/[^\s]+$/i.test(url)) throw new UserError("Pon un enlace que empiece por https://");
  await sql`UPDATE library_items SET name = ${name}, description = ${String(data.description ?? "").trim().slice(0, 1000) || null},
              folder = ${cleanFolder(data.folder)}, url = CASE WHEN kind = 'link' AND ${url ?? ""} <> '' THEN ${url ?? ""} ELSE url END, updated_at = now()
            WHERE id = ${id}`;
}

export async function setArchived(id: string, archived: boolean) {
  await sql`UPDATE library_items SET archived_at = ${archived ? new Date() : null} WHERE id = ${id}`;
}

/** Sustituir el archivo por una versión nueva: los enlaces ya enviados enseñan la nueva. */
export async function replaceLibraryFile(id: string, v: { fileName: string; mime: string; bytes: Uint8Array }) {
  if (!v.bytes.length || v.bytes.length > MAX_LIBRARY_BYTES) throw new UserError("Archivo vacío o demasiado grande (máximo 25 MB).");
  if (BLOCKED.test(v.fileName)) throw new UserError("Ese tipo de archivo no se puede subir.");
  await sql`UPDATE library_items SET file_name = ${v.fileName.slice(0, 255)}, mime = ${v.mime || "application/octet-stream"}, size = ${v.bytes.length},
              data = ${Buffer.from(v.bytes)}, updated_at = now() WHERE id = ${id} AND kind = 'file'`;
}

export async function libraryFile(id: string) {
  if (!isId(id)) return null;
  const [f] = await sql<{ name: string; file_name: string | null; mime: string | null; data: Buffer | null; kind: string; url: string | null }[]>`
    SELECT name, file_name, mime, data, kind, url FROM library_items WHERE id = ${id}`;
  return f ?? null;
}

export type LinkRow = {
  id: string; token: string; person_id: string | null; person: string | null; deal_id: string | null; deal: string | null; created_at: Date;
  creator: string | null; view_count: number; seconds: number; first_viewed_at: Date | null; last_viewed_at: Date | null; disabled_at: Date | null;
  item: string; library_id: string | null; file_id: string | null;
};

export async function listLinks(where: { libraryId?: string; dealId?: string; personId?: string }): Promise<LinkRow[]> {
  return sql<LinkRow[]>`
    SELECT l.id, l.token, l.person_id, p.full_name AS person, l.deal_id, d.title AS deal, l.created_at, u.name AS creator,
           l.view_count, l.seconds, l.first_viewed_at, l.last_viewed_at, l.disabled_at, coalesce(i.name, f.name) AS item, l.library_id, l.file_id
    FROM doc_links l LEFT JOIN persons p ON p.id = l.person_id LEFT JOIN deals d ON d.id = l.deal_id LEFT JOIN users u ON u.id = l.created_by
    LEFT JOIN library_items i ON i.id = l.library_id LEFT JOIN files f ON f.id = l.file_id
    WHERE (${where.libraryId ?? null}::uuid IS NULL OR l.library_id = ${where.libraryId ?? null}::uuid)
      AND (${where.dealId ?? null}::uuid IS NULL OR l.deal_id = ${where.dealId ?? null}::uuid)
      AND (${where.personId ?? null}::uuid IS NULL OR l.person_id = ${where.personId ?? null}::uuid)
    ORDER BY coalesce(l.last_viewed_at, l.created_at) DESC LIMIT 300`;
}

export const docUrl = (token: string) => `${publicBase() ?? ""}/d/${token}`;

/** Enlace personal para compartir un documento (se reutiliza si ya existe para el mismo contacto y deal). */
export async function createDocLink(actor: Actor, v: { libraryId?: string | null; fileId?: string | null; dealId?: string | null; personId?: string | null; emailId?: string | null; reuse?: boolean }) {
  if (!v.libraryId && !v.fileId) throw new UserError("Elige un documento.");
  if (v.libraryId && !isId(v.libraryId)) throw new UserError("Documento no válido.");
  if (v.fileId && !isId(v.fileId)) throw new UserError("Documento no válido.");
  if (v.reuse !== false) {
    const [ex] = await sql<{ token: string; id: string }[]>`
      SELECT token, id FROM doc_links
      WHERE disabled_at IS NULL AND email_id IS NULL
        AND library_id IS NOT DISTINCT FROM ${v.libraryId ?? null}::uuid AND file_id IS NOT DISTINCT FROM ${v.fileId ?? null}::uuid
        AND deal_id IS NOT DISTINCT FROM ${v.dealId ?? null}::uuid AND person_id IS NOT DISTINCT FROM ${v.personId ?? null}::uuid
      ORDER BY created_at DESC LIMIT 1`;
    if (ex) return { id: ex.id, token: ex.token, url: docUrl(ex.token) };
  }
  const token = randomBytes(15).toString("base64url");
  const [r] = await sql<{ id: string }[]>`
    INSERT INTO doc_links (token, library_id, file_id, deal_id, person_id, email_id, created_by)
    VALUES (${token}, ${v.libraryId ?? null}, ${v.fileId ?? null}, ${v.dealId ?? null}, ${v.personId ?? null}, ${v.emailId ?? null}, ${actor.id})
    RETURNING id`;
  return { id: r.id, token, url: docUrl(token) };
}

export async function disableLink(id: string, disabled: boolean) {
  await sql`UPDATE doc_links SET disabled_at = ${disabled ? new Date() : null} WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Lado público (/d/<token>)

export type PublicDoc = { linkId: string; name: string; kind: "file" | "link"; mime: string | null; size: number | null; url: string | null; fileName: string | null;
  sender: string | null; senderEmail: string | null; disabled: boolean };

export async function docByToken(token: string): Promise<PublicDoc | null> {
  if (typeof token !== "string" || token.length < 12 || token.length > 64) return null;
  const [r] = await sql<PublicDoc[]>`
    SELECT l.id AS "linkId", coalesce(i.name, f.name) AS name, coalesce(i.kind, 'file') AS kind, coalesce(i.mime, f.mime) AS mime,
           coalesce(i.size, f.size) AS size, i.url, coalesce(i.file_name, f.name) AS "fileName", u.name AS sender, u.email AS "senderEmail",
           (l.disabled_at IS NOT NULL OR i.archived_at IS NOT NULL) AS disabled
    FROM doc_links l LEFT JOIN library_items i ON i.id = l.library_id LEFT JOIN files f ON f.id = l.file_id LEFT JOIN users u ON u.id = l.created_by
    WHERE l.token = ${token}`;
  return r ?? null;
}

export async function docBytes(token: string) {
  const [r] = await sql<{ name: string; mime: string; data: Buffer | null }[]>`
    SELECT coalesce(i.file_name, f.name) AS name, coalesce(i.mime, f.mime, 'application/octet-stream') AS mime, coalesce(i.data, f.data) AS data
    FROM doc_links l LEFT JOIN library_items i ON i.id = l.library_id LEFT JOIN files f ON f.id = l.file_id
    WHERE l.token = ${token} AND l.disabled_at IS NULL AND (i.id IS NULL OR i.archived_at IS NULL)`;
  return r?.data ? r : null;
}

const BOT = /bot|crawl|spider|preview|slurp|facebookexternalhit|linkedin|whatsapp|skype|teams|outlook|safelinks|proofpoint|mimecast|barracuda|headless/i;

/** Alguien ha abierto el documento: queda registrado y se avisa a quien lo compartió. Devuelve el id de la visita. */
export async function recordDocView(token: string, ip: string | null, ua: string | null): Promise<string | null> {
  if (ua && BOT.test(ua)) return null;   // vistas previas de antivirus, chats y robots: no cuentan
  const [l] = await sql<{ id: string; created_by: string | null; deal_id: string | null; person: string | null; name: string; view_count: number; last_viewed_at: Date | null }[]>`
    SELECT l.id, l.created_by, l.deal_id, p.full_name AS person, coalesce(i.name, f.name) AS name, l.view_count, l.last_viewed_at
    FROM doc_links l LEFT JOIN persons p ON p.id = l.person_id LEFT JOIN library_items i ON i.id = l.library_id LEFT JOIN files f ON f.id = l.file_id
    WHERE l.token = ${token} AND l.disabled_at IS NULL`;
  if (!l) return null;
  const [v] = await sql<{ id: string }[]>`INSERT INTO doc_views (link_id, ip, user_agent) VALUES (${l.id}, ${ip}, ${ua?.slice(0, 300) ?? null}) RETURNING id`;
  await sql`UPDATE doc_links SET view_count = view_count + 1, first_viewed_at = coalesce(first_viewed_at, now()), last_viewed_at = now() WHERE id = ${l.id}`;
  // Aviso: la primera vez y luego como mucho cada media hora.
  const quiet = l.last_viewed_at && Date.now() - new Date(l.last_viewed_at).getTime() < 30 * 60000;
  if (!quiet) {
    const n = l.view_count + 1;
    const who = l.person ?? "Alguien";
    if (l.created_by) {
      await notify(sql, { userId: l.created_by, kind: "doc.viewed", title: `${who} ha abierto «${l.name}»${n > 1 ? ` (${n}.ª vez)` : ""}`,
                          body: n > 1 ? "Lo está volviendo a mirar: buen momento para llamar." : null, link: l.deal_id ? `/deals/${l.deal_id}#documentos-enviados` : "/biblioteca" });
    }
    if (l.deal_id) await recordEvent(sql, INTEGRATION_ACTOR, "deal", l.deal_id, "doc.viewed", { name: l.name, person: l.person, count: n });
  }
  return v.id;
}

/** El visor manda cada pocos segundos cuánto tiempo lleva abierto y hasta qué página ha llegado. */
export async function pingDocView(token: string, viewId: string, seconds: number, page: number | null) {
  if (!isId(viewId)) return;
  const s = Math.max(0, Math.min(4 * 3600, Math.round(seconds)));
  const [v] = await sql<{ link_id: string; seconds: number }[]>`
    SELECT v.link_id, v.seconds FROM doc_views v JOIN doc_links l ON l.id = v.link_id WHERE v.id = ${viewId} AND l.token = ${token}`;
  if (!v || s <= v.seconds) return;
  await sql`UPDATE doc_views SET seconds = ${s}, max_page = GREATEST(coalesce(max_page, 0), ${page ?? 0}) WHERE id = ${viewId}`;
  await sql`UPDATE doc_links SET seconds = seconds + ${s - v.seconds} WHERE id = ${v.link_id}`;
}

export async function linkViews(linkId: string) {
  return sql<{ at: Date; seconds: number; max_page: number | null; ip: string | null; user_agent: string | null }[]>`
    SELECT at, seconds, max_page, ip, user_agent FROM doc_views WHERE link_id = ${linkId} ORDER BY at DESC LIMIT 50`;
}

export const duration = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** Lo que se puede adjuntar al escribir un correo: archivos del deal y la biblioteca. */
export async function attachablesFor(dealId: string | null) {
  const [files, library] = await Promise.all([
    dealId ? sql<{ id: string; name: string; size: number }[]>`SELECT id, name, size FROM files WHERE deal_id = ${dealId} ORDER BY created_at DESC LIMIT 50` : Promise.resolve([]),
    sql<{ id: string; name: string; size: number | null; kind: "file" | "link"; folder: string }[]>`
      SELECT id, name, size, kind, folder FROM library_items WHERE archived_at IS NULL ORDER BY folder, name LIMIT 200`,
  ]);
  return { files: [...files], library: [...library] };
}
