// ===========================================================================
// HTML de los correos con formato, sin dependencias (servidor y navegador):
//
//   · sanitizeEmailHtml: solo etiquetas y estilos seguros (lo que sale del
//     editor o de una plantilla pegada de otro sitio).
//   · htmlToText / textToHtml: versión de texto (la que se guarda y la que
//     leen los clientes sin HTML) y paso de texto a HTML.
//   · trackHtmlLinks: enlaces por /t/c/… para contar clics, y el píxel.
// ===========================================================================

const ALLOWED: Record<string, string[]> = {
  p: ["style"], br: [], div: ["style"], span: ["style"], b: [], strong: [], i: [], em: [], u: [], s: [], strike: [],
  a: ["href", "style", "title"], ul: ["style"], ol: ["style"], li: ["style"], blockquote: ["style"],
  h1: ["style"], h2: ["style"], h3: ["style"], hr: [], img: ["src", "alt", "width", "height", "style"],
  table: ["style", "width", "cellpadding", "cellspacing", "border"], tbody: [], thead: [], tr: ["style"],
  td: ["style", "width", "colspan", "align", "valign"], th: ["style", "width", "colspan", "align"], font: ["color"],
};
const VOID = new Set(["br", "hr", "img"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "head", "title", "iframe", "object", "embed", "noscript", "svg", "math", "template"]);
const STYLE_PROPS = new Set([
  "color", "background-color", "font-weight", "font-style", "text-decoration", "text-align", "font-size", "font-family",
  "line-height", "margin", "margin-top", "margin-bottom", "margin-left", "padding", "padding-left", "border", "border-left",
  "width", "max-width", "height", "display", "list-style-type",
]);

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const decode = (s: string) =>
  s.replace(/&nbsp;|&#160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

function safeUrl(u: string, img = false): string | null {
  const v = decode(u).trim();
  if (/^\{\{[^{}]+\}\}$/.test(v)) return v;                              // una variable ({{enlace_reserva}})
  if (/^https?:\/\//i.test(v)) return v;
  if (!img && /^mailto:/i.test(v)) return v;
  if (!img && /^tel:/i.test(v)) return v;
  if (img && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(v)) return v;
  return null;
}

function safeStyle(style: string): string {
  return style.split(";").map((d) => {
    const i = d.indexOf(":");
    if (i < 0) return null;
    const prop = d.slice(0, i).trim().toLowerCase();
    const value = d.slice(i + 1).trim();
    if (!STYLE_PROPS.has(prop) || /url\s*\(|expression|javascript:|[<>]/i.test(value) || value.length > 200) return null;
    return `${prop}: ${value}`;
  }).filter(Boolean).join("; ");
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const TAG_AT = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^<>]*?)?)\s*(\/?)>/;

/** Deja solo el HTML seguro de un correo. */
export function sanitizeEmailHtml(input: string): string {
  const src = (input ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(/<!doctype[^>]*>/gi, "");
  let out = "";
  let i = 0;
  let dropping: string | null = null;
  let dropDepth = 0;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { if (!dropping) out += src.slice(i).replace(/>/g, "&gt;"); break; }
    if (!dropping) out += src.slice(i, lt).replace(/>/g, "&gt;");
    const m = TAG_AT.exec(src.slice(lt));
    if (!m) { if (!dropping) out += "&lt;"; i = lt + 1; continue; }
    i = lt + m[0].length;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (dropping) {
      if (tag === dropping) dropDepth += closing ? -1 : 1;
      if (dropDepth <= 0) dropping = null;
      continue;
    }
    if (DROP_WITH_CONTENT.has(tag)) {
      if (!closing && m[4] !== "/") { dropping = tag; dropDepth = 1; }
      continue;
    }
    const allowed = ALLOWED[tag];
    if (!allowed) continue;                                              // la etiqueta se va, el texto se queda
    if (closing) { if (!VOID.has(tag)) out += `</${tag}>`; continue; }
    const attrs: string[] = [];
    for (const a of (m[3] ?? "").matchAll(ATTR_RE)) {
      const name = a[1].toLowerCase();
      if (!allowed.includes(name)) continue;
      let value = a[2] ?? "";
      if (/^["']/.test(value)) value = value.slice(1, -1);
      if (name === "href" || name === "src") {
        const u = safeUrl(value, name === "src");
        if (!u) continue;
        value = u;
      } else if (name === "style") {
        value = safeStyle(decode(value));
        if (!value) continue;
      } else value = decode(value);
      attrs.push(`${name}="${escapeHtml(value)}"`);
    }
    if (tag === "a" && attrs.some((x) => x.startsWith("href="))) attrs.push('target="_blank"', 'rel="noopener"');
    out += `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  }
  return out.trim();
}

/** Texto plano a partir del HTML (versión alternativa y lo que se guarda en el historial). */
export function htmlToText(html: string): string {
  let s = (html ?? "").replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi, (_, __, h1: string, h2: string, inner: string) => {
    const href = decode(h1 ?? h2 ?? "");
    const label = decode(inner.replace(/<[^>]+>/g, "")).trim();
    if (!href || /^mailto:/i.test(href) || label === href || !label) return label || href;
    return `${label} (${href})`;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "\n• ").replace(/<hr[^>]*>/gi, "\n—\n")
    .replace(/<\/(p|div|h1|h2|h3|blockquote|tr|table|ul|ol)>/gi, "\n").replace(/<(p|div|h1|h2|h3|blockquote|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ");
  s = decode(s.replace(/<[^>]+>/g, ""));
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

/** Texto plano a HTML (escapado, con los enlaces clicables y los saltos de línea). */
export function textToHtml(text: string): string {
  const paragraphs = (text ?? "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  return paragraphs.map((p) => {
    let html = "";
    let last = 0;
    for (const m of p.matchAll(URL_RE)) {
      html += escapeHtml(p.slice(last, m.index));
      html += `<a href="${escapeHtml(m[0])}">${escapeHtml(m[0])}</a>`;
      last = (m.index ?? 0) + m[0].length;
    }
    html += escapeHtml(p.slice(last));
    return `<p>${html.replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

/** Enlaces (href) de un HTML, tal cual: para aceptar solo redirecciones a enlaces del correo. */
export function hrefsIn(html: string | null | undefined): string[] {
  if (!html) return [];
  return [...html.matchAll(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)')/gi)].map((m) => decode(m[2] ?? m[3] ?? ""));
}

export const EMAIL_WRAP = (inner: string) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${inner}</div>`;

/** HTML listo para enviar: con seguimiento (enlaces por el CRM y píxel) o sin él. */
export function trackHtmlLinks(html: string, token: string | null, base: string | null): string {
  if (!token || !base) return EMAIL_WRAP(html.replace(/\s*data-notrack(="[^"]*")?/gi, ""));
  const body = html.replace(/<a\b[^>]*>/gi, (tag) => {
    if (/\bdata-notrack\b/i.test(tag)) return tag.replace(/\s*data-notrack(="[^"]*")?/i, "");   // el enlace de baja no cuenta como clic
    return tag.replace(/(\bhref\s*=\s*)("([^"]*)"|'([^']*)')/i, (m, pre: string, _q: string, h1: string, h2: string) => {
      const href = decode(h1 ?? h2 ?? "");
      if (!/^https?:\/\//i.test(href)) return m;
      return `${pre}"${base}/t/c/${token}?u=${encodeURIComponent(href)}"`;
    });
  });
  return EMAIL_WRAP(body)
    + `<img src="${base}/t/o/${token}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
}
