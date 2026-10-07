"use client";

import { useEffect, useRef, useState } from "react";
import { sanitizeEmailHtml } from "@/lib/email-html";

/**
 * Campo con formato sencillo para firmas: negrita, cursiva, enlaces, logo
 * (imagen por URL) y, para quien ya tiene su firma hecha en Gmail u Outlook,
 * pegarla tal cual o editar su HTML. Guarda el HTML en un campo oculto.
 */
export function RichTextField({ name, initial, label, hint }: { name: string; initial: string; label: string; hint?: string }) {
  const [html, setHtml] = useState(initial);
  const [tool, setTool] = useState<null | "link" | "image" | "html">(null);
  const [url, setUrl] = useState("https://");
  const [source, setSource] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);

  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const onReset = () => { if (ref.current) ref.current.innerHTML = initial; setHtml(initial); };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [initial]);

  const save = () => {
    const sel = window.getSelection();
    if (sel?.rangeCount && ref.current?.contains(sel.anchorNode)) range.current = sel.getRangeAt(0).cloneRange();
  };
  const read = () => setHtml(ref.current?.innerHTML ?? "");
  const exec = (cmd: string, value?: string) => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      if (range.current && el.contains(range.current.startContainer)) sel.addRange(range.current);
      else { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.addRange(r); }
    }
    document.execCommand(cmd, false, value);
    save(); read();
  };
  const validUrl = /^https?:\/\/\S+\.\S+/.test(url);

  return (
    <div className="field">
      <span className="label">{label}</span>
      <input type="hidden" name={name} value={html} />
      <div className="ee-toolbar">
        <button type="button" aria-label="Negrita" onMouseDown={(e) => { e.preventDefault(); exec("bold"); }}><b>B</b></button>
        <button type="button" aria-label="Cursiva" onMouseDown={(e) => { e.preventDefault(); exec("italic"); }}><i>I</i></button>
        <button type="button" aria-pressed={tool === "link"} onMouseDown={(e) => e.preventDefault()} onClick={() => { save(); setTool(tool === "link" ? null : "link"); setUrl("https://"); }}>Enlace</button>
        <button type="button" aria-pressed={tool === "image"} onMouseDown={(e) => e.preventDefault()} onClick={() => { save(); setTool(tool === "image" ? null : "image"); setUrl("https://"); }}>Logo / imagen</button>
        <button type="button" aria-pressed={tool === "html"} onClick={() => { setSource(html); setTool(tool === "html" ? null : "html"); }}>HTML</button>
      </div>
      {(tool === "link" || tool === "image") && (
        <div className="ee-panel ee-row">
          <input aria-label={tool === "link" ? "Dirección del enlace" : "Dirección de la imagen"} value={url} onChange={(e) => setUrl(e.target.value)} style={{ minWidth: 280 }} />
          <button type="button" className="btn small" disabled={!validUrl} onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (tool === "link") exec("createLink", url);
                    else exec("insertHTML", `<img src="${url.replace(/"/g, "&quot;")}" alt="" style="max-width: 180px; height: auto">`);
                    setTool(null);
                  }}>
            {tool === "link" ? "Enlazar el texto seleccionado" : "Insertar imagen"}
          </button>
          {tool === "image" && <span className="meta">Usa una imagen publicada en internet (p. ej. el logo de vuestra web); los adjuntos no se ven en todos los correos.</span>}
        </div>
      )}
      {tool === "html" && (
        <div className="ee-panel">
          <textarea aria-label="HTML de la firma" rows={6} value={source} onChange={(e) => setSource(e.target.value)} style={{ fontFamily: "monospace", fontSize: 12 }} />
          <div className="ee-row">
            <button type="button" className="btn small" onClick={() => {
              const clean = sanitizeEmailHtml(source);
              if (ref.current) ref.current.innerHTML = clean;
              setHtml(clean); setTool(null);
            }}>Aplicar</button>
            <span className="meta">Se quita lo que no es seguro (scripts, estilos externos…).</span>
          </div>
        </div>
      )}
      <div ref={ref} className="ee-body rich" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={label}
           style={{ minHeight: 90 }} dangerouslySetInnerHTML={{ __html: initial }}
           onInput={read} onKeyUp={save} onMouseUp={save} onBlur={() => { save(); read(); }}
           onPaste={(e) => {
             const h = e.clipboardData.getData("text/html");
             if (!h) return;
             e.preventDefault();
             document.execCommand("insertHTML", false, sanitizeEmailHtml(h));
             read();
           }} />
      {hint && <p className="meta" style={{ margin: "4px 0 0" }}>{hint}</p>}
    </div>
  );
}
