import { z } from "zod";
import { sql, transaction } from "./db";
import { recordEvent, type Actor } from "./events";
import { UserError } from "./errors";
import { optText, optional, parse, text } from "./validation";

// Documentos enlazados a un deal: presentaciones, propuestas, contratos…
// Se guardan como enlace (el archivo sigue en Google Drive, OneDrive o donde esté).

export type DealDocument = {
  id: string; title: string; url: string; source: "link" | "google" | "microsoft"; mime_type: string | null;
  added_by: string | null; created_at: Date;
};

export async function listDocuments(dealId: string) {
  return sql<DealDocument[]>`
    SELECT d.id, d.title, d.url, d.source, d.mime_type, u.name AS added_by, d.created_at
    FROM deal_documents d LEFT JOIN users u ON u.id = d.added_by_id
    WHERE d.deal_id = ${dealId}
    ORDER BY d.created_at DESC`;
}

const schema = z.object({
  title: optText(300),
  url: z.string().trim().url("El enlace no es válido").refine((u) => /^https?:\/\//i.test(u), "El enlace debe empezar por http:// o https://"),
  source: optional(z.enum(["link", "google", "microsoft"])),
  external_id: optText(500),
  mime_type: optText(200),
});

/** Título a partir del enlace si no se indica (último trozo de la ruta o el dominio). */
function titleFromUrl(url: string) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    return last && !/^(edit|view|preview)$/i.test(last) && last.length < 120 ? last : u.hostname;
  } catch {
    return url;
  }
}

export async function addDocument(actor: Actor, dealId: string, data: unknown) {
  const v = parse(schema, data);
  const title = v.title ?? titleFromUrl(v.url);
  await transaction(async (tx) => {
    const [d] = await tx<{ id: string }[]>`SELECT id FROM deals WHERE id = ${dealId} AND deleted_at IS NULL`;
    if (!d) throw new UserError("El deal no existe.");
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO deal_documents (deal_id, title, url, source, external_id, mime_type, added_by_id)
      VALUES (${dealId}, ${title}, ${v.url}, ${v.source ?? "link"}, ${v.external_id ?? null}, ${v.mime_type ?? null}, ${actor.id})
      RETURNING id`;
    await recordEvent(tx, actor, "deal", dealId, "deal.document_added", { document_id: row.id, title, url: v.url });
  });
}

export async function removeDocument(actor: Actor, documentId: string) {
  await transaction(async (tx) => {
    const [d] = await tx<{ deal_id: string; title: string }[]>`
      DELETE FROM deal_documents WHERE id = ${documentId} RETURNING deal_id, title`;
    if (d) await recordEvent(tx, actor, "deal", d.deal_id, "deal.document_removed", { title: d.title });
  });
}

/** Tipo de documento para mostrar (por el tipo MIME o la extensión). */
export function documentKind(doc: { mime_type: string | null; url: string; title: string }) {
  const m = (doc.mime_type ?? "").toLowerCase();
  const name = `${doc.title} ${doc.url}`.toLowerCase();
  if (m.includes("presentation") || /\.(pptx?|key)\b/.test(name) || name.includes("/presentation/")) return "Presentación";
  if (m.includes("spreadsheet") || m.includes("excel") || /\.(xlsx?|csv)\b/.test(name) || name.includes("/spreadsheets/")) return "Hoja de cálculo";
  if (m.includes("pdf") || /\.pdf\b/.test(name)) return "PDF";
  if (m.includes("document") || m.includes("word") || /\.(docx?)\b/.test(name) || name.includes("/document/")) return "Documento";
  return "Enlace";
}
