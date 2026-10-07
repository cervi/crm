"use client";

import { useRef, useState } from "react";
import { sanitizeEmailHtml } from "@/lib/email-html";

/** Campo de texto con formato sencillo (negrita, cursiva, enlace) que guarda el HTML en un campo oculto. */
export function RichTextField({ name, initial, label }: { name: string; initial: string; label: string }) {
  const [html, setHtml] = useState(initial);
  const [url, setUrl] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const exec = (cmd: string, value?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, value);
    setHtml(ref.current?.innerHTML ?? "");
  };
  return (
    <div className="field">
      <span className="label">{label}</span>
      <input type="hidden" name={name} value={html} />
      <div className="ee-toolbar">
        <button type="button" aria-label="Negrita" onMouseDown={(e) => { e.preventDefault(); exec("bold"); }}><b>B</b></button>
        <button type="button" aria-label="Cursiva" onMouseDown={(e) => { e.preventDefault(); exec("italic"); }}><i>I</i></button>
        <input aria-label="Enlace" placeholder="https://… (selecciona texto)" value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 220, height: 28 }} />
        <button type="button" disabled={!/^https?:\/\/\S+\.\S+/.test(url)} onMouseDown={(e) => { e.preventDefault(); exec("createLink", url); setUrl(""); }}>Enlazar</button>
      </div>
      <div ref={ref} className="ee-body rich" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={label}
           style={{ minHeight: 90 }} dangerouslySetInnerHTML={{ __html: initial }}
           onInput={() => setHtml(ref.current?.innerHTML ?? "")}
           onPaste={(e) => {
             const h = e.clipboardData.getData("text/html");
             if (!h) return;
             e.preventDefault();
             document.execCommand("insertHTML", false, sanitizeEmailHtml(h));
             setHtml(ref.current?.innerHTML ?? "");
           }} />
    </div>
  );
}
