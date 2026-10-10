"use client";

import { useEffect, useRef, useState } from "react";
import { docLinkAction } from "@/app/actions/library";
import { Icon } from "../Icon";

export type Attachable = { id: string; name: string; size: number | null; kind?: "file" | "link"; folder?: string };
type Picked = { type: "file" | "library"; id: string; name: string; size: number };
const MAX = 3 * 1024 * 1024;
const kb = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);

/**
 * «Adjuntar» del compositor: archivos del deal, de la biblioteca o uno nuevo.
 * Los de la biblioteca también se pueden mandar como enlace con seguimiento
 * (se inserta en el texto y se sabe si lo abren). Va en un campo oculto
 * «attachments» que lee el servidor.
 */
export function AttachmentPicker({ dealId, personId, files: initialFiles = [], library = [], onInsert }: {
  dealId?: string | null; personId?: string | null; files?: Attachable[]; library?: Attachable[]; onInsert: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"deal" | "library" | "upload">(initialFiles.length ? "deal" : "library");
  const [files, setFiles] = useState(initialFiles);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const hidden = useRef<HTMLInputElement>(null);
  // Al enviar, el formulario se vacía: también los adjuntos.
  useEffect(() => {
    const form = hidden.current?.form;
    if (!form) return;
    const clear = () => { setPicked([]); setOpen(false); setMsg(null); };
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);
  const total = picked.reduce((n, p) => n + p.size, 0);
  const has = (id: string) => picked.some((p) => p.id === id);
  const toggle = (p: Picked) => setPicked((l) => (l.some((x) => x.id === p.id) ? l.filter((x) => x.id !== p.id) : [...l, p]));

  const asLink = async (item: Attachable) => {
    setBusy(true); setMsg(null);
    const r = await docLinkAction({ libraryId: item.id, dealId: dealId || null, personId: personId || null });
    setBusy(false);
    if (r.error || !r.url) { setMsg(r.error ?? "No se pudo crear el enlace."); return; }
    onInsert(`${item.name}: ${r.url}`);
    setMsg(`Enlace a «${item.name}» añadido al texto. Te avisaremos cuando lo abra.`);
  };
  const upload = async (list: FileList | null) => {
    if (!list?.length || !dealId) return;
    setBusy(true); setMsg(null);
    const fd = new FormData();
    for (const f of Array.from(list)) fd.append("file", f);
    fd.set("deal_id", dealId);
    const r = await fetch("/api/files", { method: "POST", body: fd });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg(j.error ?? "No se pudo subir."); return; }
    const added = Array.from(list).map((f, i) => ({ id: j.ids[i] as string, name: f.name, size: f.size }));
    setFiles((l) => [...added, ...l]);
    setPicked((l) => [...l, ...added.map((a) => ({ type: "file" as const, ...a }))]);
    setTab("deal");
  };

  return (
    <div className="attach">
      <input ref={hidden} type="hidden" name="attachments" value={JSON.stringify(picked.map(({ type, id }) => ({ type, id })))} />
      <div className="attach-row">
        <button type="button" className="btn secondary small" onClick={() => setOpen((o) => !o)} aria-expanded={open}><Icon name="paperclip" />Adjuntar</button>
        {picked.map((p) => (
          <span key={p.id} className="attach-chip"><Icon name="paperclip" />{p.name} <span className="meta">{kb(p.size)}</span>
            <button type="button" aria-label={`Quitar ${p.name}`} onClick={() => toggle(p)}>✕</button></span>
        ))}
        {total > MAX && <span className="meta tone-bad">Pasan de 3 MB: quita alguno o mándalo como enlace.</span>}
      </div>
      {open && (
        <div className="attach-panel">
          <div className="chips" role="tablist">
            {dealId && <button type="button" role="tab" aria-selected={tab === "deal"} onClick={() => setTab("deal")}>Archivos del deal<span className="chip-count">{files.length}</span></button>}
            <button type="button" role="tab" aria-selected={tab === "library"} onClick={() => setTab("library")}>Biblioteca<span className="chip-count">{library.length}</span></button>
            {dealId && <button type="button" role="tab" aria-selected={tab === "upload"} onClick={() => setTab("upload")}>Subir</button>}
          </div>
          {tab === "deal" && (
            files.length ? (
              <ul className="attach-list">
                {files.map((f) => (
                  <li key={f.id}><label className="checkbox"><input type="checkbox" checked={has(f.id)} onChange={() => toggle({ type: "file", id: f.id, name: f.name, size: f.size ?? 0 })} />
                    {f.name} <span className="meta">{f.size ? kb(f.size) : ""}</span></label></li>
                ))}
              </ul>
            ) : <p className="meta">Este deal no tiene archivos. Súbelos en «Subir».</p>
          )}
          {tab === "library" && (
            library.length ? (
              <ul className="attach-list">
                {library.map((f) => (
                  <li key={f.id}>
                    <span className="attach-name">{f.name} <span className="meta">{f.folder}{f.size ? ` · ${kb(f.size)}` : ""}</span></span>
                    <span className="attach-acts">
                      <button type="button" className="btn secondary small" disabled={busy} onClick={() => asLink(f)} title="Se inserta un enlace personal en el texto: sabrás si lo abre y cuánto tiempo">Enviar como enlace</button>
                      {f.kind !== "link" && (
                        <button type="button" className={has(f.id) ? "btn small" : "btn secondary small"} onClick={() => toggle({ type: "library", id: f.id, name: f.name, size: f.size ?? 0 })}>
                          {has(f.id) ? "Adjuntado" : "Adjuntar"}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : <p className="meta">La biblioteca está vacía. <a href="/biblioteca">Sube tus presentaciones y documentos</a>.</p>
          )}
          {tab === "upload" && (
            <label className="field"><span className="label">Elige uno o varios archivos (se guardan también en el deal)</span>
              <input type="file" multiple onChange={(e) => upload(e.target.files)} disabled={busy} /></label>
          )}
          <p className="meta" style={{ margin: "6px 0 0" }}>Consejo: un enlace con seguimiento te dice si lo abren y cuánto lo miran; un adjunto, no.</p>
          {msg && <p className="meta" role="status">{msg}</p>}
        </div>
      )}
    </div>
  );
}
