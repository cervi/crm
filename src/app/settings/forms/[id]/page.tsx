import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteFormAction, saveFormAction } from "@/app/actions/webforms";
import { ActionForm } from "@/components/ActionForm";
import { aiReady, getAiSettings } from "@/lib/ai";
import { requireAdminPage } from "@/lib/auth";
import { publicBase } from "@/lib/email-track";
import { isId } from "@/lib/validation";
import { formUrl, getForm } from "@/lib/webforms";
import { FormEditorFields } from "../FormFields";

export const dynamic = "force-dynamic";
export const metadata = { title: "Formulario web" };

export default async function FormPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  if (!isId(id)) notFound();
  const [f, ai] = await Promise.all([getForm(id), getAiSettings()]);
  if (!f) notFound();
  const url = formUrl(f);
  const embed = `<iframe src="${url}?embed=1" style="width:100%;max-width:560px;height:620px;border:0" title="${f.title.replace(/"/g, "&quot;")}"></iframe>`;
  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link> → <Link href="/settings/forms">Formularios web</Link></div>
      <div className="page-head"><h1>{f.name}</h1><span className="muted">{f.submissions} recibidos</span></div>

      <section className="panel">
        <h2>Publicarlo</h2>
        {!publicBase() && <p className="callout">Falta <code>APP_URL</code> (la dirección pública del CRM) para compartirlo.</p>}
        <p>Página: <a href={url} target="_blank" rel="noreferrer">{url}</a></p>
        <label className="field"><span className="label">Para incrustarlo en vuestra web</span>
          <textarea readOnly rows={3} value={embed} /></label>
      </section>

      <section className="panel">
        <h2>Editar</h2>
        <ActionForm action={saveFormAction.bind(null, id)} submitLabel="Guardar">
          <FormEditorFields f={f} aiOn={aiReady(ai)} />
        </ActionForm>
      </section>

      <section className="panel">
        <h2>Borrar el formulario</h2>
        <p className="meta">Los leads que ya llegaron se quedan.</p>
        <ActionForm action={deleteFormAction.bind(null, id)} submitLabel="Borrar formulario" danger className="form inline" />
      </section>
    </main>
  );
}
