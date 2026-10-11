/** Correos sencillos (texto, un botón y un pie), legibles en cualquier cliente de correo. */
export const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function mailHtml(text: string, cta?: { label: string; url: string }, foot?: string) {
  const paras = text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#16202e;max-width:560px">${paras}`
    + (cta ? `<p style="margin:22px 0"><a href="${escHtml(cta.url)}" style="background:#1f5fd6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${escHtml(cta.label)}</a></p>` : "")
    + (foot ? `<p style="margin:22px 0 0;color:#687587;font-size:12.5px">${escHtml(foot)}</p>` : "") + "</div>";
}
