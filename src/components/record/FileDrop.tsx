"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/** Subir archivos (elegirlos o arrastrarlos) a un deal, contacto, empresa o lead. */
export function FileDrop({ refs }: { refs: Record<string, string> }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ busy?: boolean; error?: string; ok?: string }>({});
  const [over, setOver] = useState(false);

  async function upload(files: FileList | File[]) {
    const list = [...files];
    if (!list.length) return;
    setState({ busy: true });
    const form = new FormData();
    for (const f of list) form.append("file", f);
    for (const [k, v] of Object.entries(refs)) form.append(k, v);
    try {
      const res = await fetch("/api/files", { method: "POST", body: form });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "No se pudo subir.");
      setState({ ok: list.length === 1 ? `Subido: ${list[0].name}` : `Subidos ${list.length} archivos` });
      if (input.current) input.current.value = "";
      router.refresh();
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : "No se pudo subir." });
    }
  }

  return (
    <div className={`file-drop${over ? " over" : ""}`}
         onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
         onDrop={(e) => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files); }}>
      <p style={{ margin: 0 }}>Arrastra aquí los archivos o{" "}
        <label className="link-btn">elígelos<input ref={input} type="file" multiple hidden aria-label="Elegir archivos" onChange={(e) => e.target.files && upload(e.target.files)} /></label>
        <span className="meta"> · hasta 8 MB cada uno</span>
      </p>
      {state.busy && <p className="meta" role="status">Subiendo…</p>}
      {state.ok && <p className="form-ok" role="status">{state.ok}</p>}
      {state.error && <p className="form-error" role="alert">{state.error}</p>}
    </div>
  );
}
