import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { createLeadAction } from "@/app/actions/deals";
import { FUNNEL_STAGES } from "@/lib/format";

export const metadata = { title: "Nuevo lead" };

export default function NewLeadPage() {
  return (
    <main className="page" style={{ maxWidth: 760 }}>
      <div className="crumbs"><Link href="/leads">Leads</Link></div>
      <div className="page-head"><h1>Nuevo lead</h1></div>
      <p className="muted">Si el email ya existe se reutiliza el contacto, y la empresa se busca por dominio, igual que con los formularios.</p>
      <section className="panel">
        <ActionForm action={createLeadAction} submitLabel="Crear lead">
          <div className="grid-2">
            <label className="field"><span className="label">Email *</span><input type="email" name="email" required /></label>
            <label className="field"><span className="label">Teléfono</span><input type="tel" name="phone" /></label>
            <label className="field"><span className="label">Nombre</span><input name="first_name" /></label>
            <label className="field"><span className="label">Apellidos</span><input name="last_name" /></label>
            <label className="field"><span className="label">Empresa</span><input name="company" /></label>
            <label className="field"><span className="label">Cargo</span><input name="job_title" /></label>
            <label className="field"><span className="label">Origen *</span>
              <input name="source" required placeholder="webinar, ebook, evento, referido…" /></label>
            <label className="field"><span className="label">Detalle del origen</span>
              <input name="source_detail" placeholder="Nombre del webinar o contenido" /></label>
            <label className="field"><span className="label">Etapa</span>
              <select name="funnel_stage" defaultValue="">
                <option value="">—</option>
                {FUNNEL_STAGES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </select>
            </label>
            <label className="field"><span className="label">Etiquetas</span>
              <input name="tags" placeholder="separadas por comas" /></label>
            <label className="field span-2"><span className="label">Mensaje o comentario</span><textarea name="message" rows={3} /></label>
            <label className="field checkbox span-2"><input type="checkbox" name="consent" /> Acepta comunicaciones comerciales (RGPD)</label>
          </div>
        </ActionForm>
      </section>
    </main>
  );
}
