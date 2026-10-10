import { createHash } from "node:crypto";
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { UserError } from "./errors";
import { auditTexts, signDate } from "./esign-i18n";

// ===========================================================================
// PDF de la firma electrónica: comprobar el original, añadir una página de
// firmas si hace falta y, al final, «estampar» los campos rellenados y el
// registro de auditoría. Los campos se guardan en fracciones de la página tal
// como se ve (con su rotación), así que aquí se pasan a coordenadas del PDF.
// ===========================================================================

export const MAX_PDF_BYTES = 15 * 1024 * 1024;
export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export type PageInfo = { w: number; h: number };
export type StampField = { type: string; page: number; x: number; y: number; w: number; h: number; value: string | null };

/** Comprueba que el PDF se puede firmar y devuelve el tamaño de cada página (tal como se ve). */
export async function inspectPdf(bytes: Uint8Array): Promise<PageInfo[]> {
  if (bytes.length > MAX_PDF_BYTES) throw new UserError("El PDF es demasiado grande (máximo 15 MB).");
  if (!/^%PDF-/.test(Buffer.from(bytes.subarray(0, 5)).toString("latin1"))) throw new UserError("El archivo no es un PDF.");
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (/encrypt/i.test(msg)) throw new UserError("El PDF está protegido con contraseña: quítasela y vuelve a subirlo.");
    throw new UserError("No se ha podido leer el PDF. Prueba a guardarlo de nuevo como PDF.");
  }
  const pages = doc.getPages();
  if (pages.length === 0) throw new UserError("El PDF no tiene páginas.");
  if (pages.length > 200) throw new UserError("El PDF tiene demasiadas páginas (máximo 200).");
  return pages.map(displaySize);
}

function displaySize(p: PDFPage): PageInfo {
  const box = p.getCropBox();
  const r = norm(p.getRotation().angle);
  return r === 90 || r === 270 ? { w: box.height, h: box.width } : { w: box.width, h: box.height };
}
const norm = (a: number) => ((Math.round(a / 90) * 90) % 360 + 360) % 360;

/** Añade al final una página «Firmas» con un bloque por firmante. Devuelve el nuevo PDF y la página añadida (1…n). */
export async function appendSignaturePage(bytes: Uint8Array, lang: string, signers: { id: string; name: string }[]) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const W = 595.28, H = 841.89;
  const page = doc.addPage([W, H]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(safe(lang === "es" || lang === "ca" ? "Firmas" : lang === "pt" ? "Assinaturas" : lang === "fr" ? "Signatures" : lang === "de" ? "Unterschriften" : lang === "it" ? "Firme" : "Signatures"),
    { x: 56, y: H - 80, size: 18, font: bold, color: rgb(0.1, 0.12, 0.16) });
  const fields: { signerId: string; type: "signature" | "name" | "date"; x: number; y: number; w: number; h: number }[] = [];
  const blockH = 120, top = 120;
  signers.forEach((s, i) => {
    const y0 = top + i * blockH;                       // desde arriba, en puntos
    if (y0 + blockH > H - 40) return;                  // (máximo ~5 firmantes en una página)
    page.drawText(safe(s.name), { x: 56, y: H - y0 - 14, size: 11, font, color: rgb(0.25, 0.28, 0.33) });
    page.drawLine({ start: { x: 56, y: H - y0 - 84 }, end: { x: 300, y: H - y0 - 84 }, thickness: 0.7, color: rgb(0.6, 0.62, 0.66) });
    fields.push({ signerId: s.id, type: "signature", x: 56 / W, y: (y0 + 24) / H, w: 244 / W, h: 58 / H });
    fields.push({ signerId: s.id, type: "name", x: 330 / W, y: (y0 + 40) / H, w: 200 / W, h: 20 / H });
    fields.push({ signerId: s.id, type: "date", x: 330 / W, y: (y0 + 64) / H, w: 200 / W, h: 20 / H });
  });
  const out = await doc.save();
  return { bytes: out, page: doc.getPageCount(), fields, pages: doc.getPages().map(displaySize) };
}

// Solo caracteres que la fuente estándar (WinAnsi) sabe pintar.
const EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
function safe(s: string) {
  return [...s.normalize("NFC")].map((c) => {
    const n = c.charCodeAt(0);
    return (n >= 0x20 && n <= 0x7e) || (n >= 0xa0 && n <= 0xff) || EXTRA.has(c) ? c : c === "\n" || c === "\t" ? " " : "?";
  }).join("");
}

/** Convierte un punto de la página tal como se ve (en puntos, desde arriba a la izquierda) a coordenadas del PDF. */
function mapper(page: PDFPage) {
  const b = page.getCropBox();
  const r = norm(page.getRotation().angle);
  const { w: W, h: H } = displaySize(page);
  const toPdf = (dx: number, dy: number): { x: number; y: number } => {
    const u = dx / W, v = dy / H;
    if (r === 90) return { x: b.x + v * b.width, y: b.y + u * b.height };
    if (r === 180) return { x: b.x + (1 - u) * b.width, y: b.y + v * b.height };
    if (r === 270) return { x: b.x + (1 - v) * b.width, y: b.y + (1 - u) * b.height };
    return { x: b.x + u * b.width, y: b.y + (1 - v) * b.height };
  };
  return { W, H, toPdf, rot: degrees(r === 270 ? -90 : r) };
}

/** Pinta los campos rellenados y añade el registro de auditoría. */
export async function stampPdf(original: Uint8Array, fields: StampField[], audit: AuditData): Promise<Uint8Array> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const ink = rgb(0.08, 0.1, 0.18);

  for (const f of fields) {
    if (!f.value) continue;
    const page = pages[f.page - 1];
    if (!page) continue;
    const m = mapper(page);
    const bx = f.x * m.W, by = f.y * m.H, bw = f.w * m.W, bh = f.h * m.H;
    // Ancla: esquina inferior izquierda de la caja (tal como se ve).
    const at = (lx: number, ly: number) => m.toPdf(bx + lx, by + bh - ly);
    if (f.type === "signature" || f.type === "initials") {
      const m64 = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(f.value);
      if (!m64) continue;
      const img = await doc.embedPng(Buffer.from(m64[1], "base64"));
      const scale = Math.min(bw / img.width, bh / img.height);
      const iw = img.width * scale, ih = img.height * scale;
      page.drawImage(img, { ...at((bw - iw) / 2, (bh - ih) / 2), width: iw, height: ih, rotate: m.rot });
    } else if (f.type === "checkbox") {
      if (f.value !== "true") continue;
      const s = Math.min(bw, bh);
      const p1 = at(s * 0.18, s * 0.5), p2 = at(s * 0.42, s * 0.22), p3 = at(s * 0.85, s * 0.82);
      page.drawLine({ start: p1, end: p2, thickness: Math.max(1, s * 0.12), color: ink });
      page.drawLine({ start: p2, end: p3, thickness: Math.max(1, s * 0.12), color: ink });
    } else {
      const text = safe(f.value);
      let size = Math.max(6, Math.min(14, bh * 0.62));
      while (size > 6 && font.widthOfTextAtSize(text, size) > bw - 4) size -= 0.5;
      page.drawText(text, { ...at(2, (bh - size) / 2 + size * 0.2), size, font, color: ink, rotate: m.rot });
    }
  }

  drawAudit(doc, font, bold, audit);
  return doc.save();
}

export type AuditData = {
  lang: string; title: string; id: string; originalSha: string; sentBy: string; sentAt: Date | null; completedAt: Date;
  signers: { name: string; email: string; viewedAt: Date | null; signedAt: Date | null; ip: string | null; ua: string | null; code: boolean }[];
  events: { at: Date; text: string }[];
};

function drawAudit(doc: PDFDocument, font: PDFFont, bold: PDFFont, a: AuditData) {
  const t = auditTexts(a.lang);
  const W = 595.28, H = 841.89, M = 50;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const muted = rgb(0.38, 0.42, 0.48), ink = rgb(0.1, 0.12, 0.16);
  const need = (h: number) => { if (y - h < M) { page = doc.addPage([W, H]); y = H - M; } };
  const line = (text: string, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; indent?: number } = {}) => {
    const size = o.size ?? 9.5, f = o.f ?? font, x = M + (o.indent ?? 0);
    for (const chunk of wrap(safe(text), f, size, W - M - x)) {
      need(size + 4);
      page.drawText(chunk, { x, y: y - size, size, font: f, color: o.color ?? ink });
      y -= size + 4;
    }
  };
  const fmt = (d: Date | null) => (d ? signDate(a.lang, d, true) + " (" + new Date(d).toISOString().replace("T", " ").slice(0, 19) + " UTC)" : "—");

  line(t.title, { size: 18, f: bold });
  y -= 6;
  line(`${t.doc}: ${a.title}`, { f: bold, size: 11 });
  line(`${t.id}: ${a.id}`, { color: muted });
  line(`${t.hashO}: ${a.originalSha}`, { color: muted, size: 8.5 });
  line(`${t.sentBy}: ${a.sentBy}`);
  line(`${t.sent}: ${fmt(a.sentAt)}`);
  line(`${t.completed}: ${fmt(a.completedAt)}`);
  y -= 10;
  for (const s of a.signers) {
    need(90);
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: rgb(0.85, 0.87, 0.9) });
    y -= 10;
    line(`${t.signer}: ${s.name}`, { f: bold, size: 11 });
    line(`${t.email}: ${s.email}`, { indent: 10 });
    line(`${t.viewed}: ${fmt(s.viewedAt)}`, { indent: 10 });
    line(`${t.signedAt}: ${fmt(s.signedAt)}`, { indent: 10 });
    line(`${t.ip}: ${s.ip ?? "—"}`, { indent: 10 });
    if (s.ua) line(`${t.device}: ${s.ua.slice(0, 160)}`, { indent: 10, color: muted, size: 8.5 });
    if (s.code) line(t.code, { indent: 10, color: muted });
    y -= 6;
  }
  y -= 6;
  line(t.events, { f: bold, size: 11 });
  for (const e of a.events) line(`${new Date(e.at).toISOString().replace("T", " ").slice(0, 19)} UTC · ${e.text}`, { size: 8.5, color: muted });
  y -= 10;
  line(t.note, { size: 8.5, color: muted });
}

function wrap(text: string, f: PDFFont, size: number, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    const next = cur ? `${cur} ${word}` : word;
    if (f.widthOfTextAtSize(next, size) <= max) { cur = next; continue; }
    if (cur) out.push(cur);
    cur = word;
    while (f.widthOfTextAtSize(cur, size) > max && cur.length > 1) {
      let i = cur.length - 1;
      while (i > 1 && f.widthOfTextAtSize(cur.slice(0, i), size) > max) i--;
      out.push(cur.slice(0, i)); cur = cur.slice(i);
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

