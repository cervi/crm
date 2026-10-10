"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Subir un documento a la biblioteca (o sustituir el de uno existente con `replace`). */
export function LibraryUpload({ folders, replace }: { folders?: string[]; replace?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  return (
    <form className="form" onSubmit={async (e) => {
      e.preventDefault();
      const form = e.currentTarget, data = new FormData(form);
      if (replace) data.set("replace", replace);
      setBusy(true); setMsg({});
      const r = await fetch("/api/biblioteca", { method: "POST", body: data });
      const j = await r.json().catch(() => ({}));
      setBusy(false);
      if (!r.ok) { setMsg({ error: j.error ?? "No se ha podido subir." }); return; }
      form.reset(); setMsg({ ok: replace ? "Archivo sustituido. Los enlaces ya enviados enseñan la versión nueva." : "Subido a la biblioteca." });
      router.refresh();
    }}>
      <label className="field"><span className="label">Archivo *</span><input type="file" name="file" required />
        <span className="meta">PDF, presentación, Word, Excel, imagen… hasta 25 MB. Los PDF se ven en el navegador, y se sabe hasta qué página llegan.</span></label>
      {!replace && (
        <>
          <label className="field"><span className="label">Nombre</span><input name="name" maxLength={200} placeholder="Se usa el del archivo" /></label>
          <label className="field"><span className="label">Carpeta</span>
            <input name="folder" list="lib-folders" defaultValue="Presentaciones" maxLength={60} />
            <datalist id="lib-folders">{folders?.map((f) => <option key={f} value={f} />)}</datalist></label>
          <label className="field"><span className="label">Descripción (opcional)</span><textarea name="description" rows={2} maxLength={1000} placeholder="Para qué sirve y cuándo mandarlo" /></label>
        </>
      )}
      {msg.error && <p className="form-error" role="alert">{msg.error}</p>}
      {msg.ok && <p className="form-ok" role="status">{msg.ok}</p>}
      <div className="form-actions"><button className="btn" disabled={busy}>{busy ? "Subiendo…" : replace ? "Sustituir archivo" : "Subir"}</button></div>
    </form>
  );
}
