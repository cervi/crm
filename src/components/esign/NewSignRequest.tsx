"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Drawer } from "../Drawer";
import { Icon } from "../Icon";

/** «Enviar a firmar»: subir un PDF (o elegir uno de los archivos del deal) y pasar a prepararlo. */
export function NewSignRequest({ dealId, pdfs = [], templates = [], label = "Enviar un contrato a firmar", buttonClass = "btn secondary small", open = false }: {
  dealId?: string | null; pdfs?: { id: string; name: string }[]; templates?: { id: string; name: string }[]; label?: string; buttonClass?: string; open?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    if (dealId) form.set("deal_id", dealId);
    const file = form.get("file");
    if (!form.get("template_id")) form.delete("template_id");
    if (!(file instanceof File && file.size > 0) && !form.get("file_id") && !form.get("template_id")) { setError("Elige un PDF o una plantilla."); return; }
    setBusy(true); setError(null);
    const res = await fetch("/api/firmas", { method: "POST", body: form });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.id) { setBusy(false); setError(j.error ?? "No se ha podido subir el PDF."); return; }
    router.push(`/firmas/${j.id}${j.missing?.length ? `?faltan=${encodeURIComponent(j.missing.join(", "))}` : ""}`);
  };
  return (
    <Drawer defaultOpen={open} label={<><Icon name="pencil" />{label}</>} buttonClass={buttonClass} title="Enviar un contrato a firmar"
            subtitle="Sube el PDF. Después eliges quién firma, colocas las firmas y los demás campos, y lo envías.">
      <form className="form" onSubmit={submit}>
        {templates.length > 0 && (
          <label className="field"><span className="label">Usar una plantilla (con los campos ya colocados)</span>
            <select name="template_id" defaultValue="">
              <option value="">— Sin plantilla: subo un PDF —</option>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <span className="meta">«Tu empresa» serás tú y «Cliente», los contactos del deal por orden.</span></label>
        )}
        <label className="field"><span className="label">{templates.length ? "…o sube el PDF del contrato" : "PDF del contrato"}</span>
          <input type="file" name="file" accept="application/pdf,.pdf" />
          <span className="meta">Hasta 15 MB. Sin contraseña.</span></label>
        {pdfs.length > 0 && (
          <label className="field"><span className="label">…o uno de los archivos del deal</span>
            <select name="file_id" defaultValue="">
              <option value="">—</option>
              {pdfs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        )}
        <label className="field"><span className="label">Nombre del documento (opcional)</span><input name="title" maxLength={200} placeholder="Se usa el nombre del archivo" /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button className="btn" disabled={busy}>{busy ? "Subiendo…" : "Continuar"}</button></div>
      </form>
    </Drawer>
  );
}
