// HTML de los correos con seguimiento: el texto tal cual (escapado), los
// enlaces pasando por /t/c/… para contar clics y un píxel /t/o/….gif para las
// aperturas. Sin dependencias: se puede probar aislado.

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Dirección pública del CRM (APP_URL) o null si no hay una válida: sin ella no se puede seguir nada. */
export function publicBase(): string | null {
  const u = (process.env.APP_URL ?? "").trim().replace(/\/+$/, "");
  return /^https?:\/\/[^/\s]+/.test(u) ? u : null;
}

export function trackedHtml(body: string, token: string, base: string): string {
  let html = "";
  let last = 0;
  for (const m of body.matchAll(URL_RE)) {
    const url = m[0];
    html += escapeHtml(body.slice(last, m.index));
    html += `<a href="${base}/t/c/${token}?u=${encodeURIComponent(url)}">${escapeHtml(url)}</a>`;
    last = (m.index ?? 0) + url.length;
  }
  html += escapeHtml(body.slice(last));
  html = html.replace(/\r?\n/g, "<br>\n");
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">${html}</div>`
    + `<img src="${base}/t/o/${token}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px">`;
}

/** Enlaces del texto (para aceptar solo redirecciones a enlaces que de verdad estaban en el correo). */
export function linksIn(body: string): string[] {
  return [...body.matchAll(URL_RE)].map((m) => m[0]);
}
