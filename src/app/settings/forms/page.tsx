import Link from "next/link";
import { saveFormAction } from "@/app/actions/webforms";
import { ActionForm } from "@/components/ActionForm";
import { aiReady, getAiSettings } from "@/lib/ai";
import { requireAdminPage } from "@/lib/auth";
import { listForms } from "@/lib/webforms";
import { FormEditorFields } from "./FormFields";

export const dynamic = "force-dynamic";
export const metadata = { title: "Formularios web" };

export default async function FormsPage() {
  await requireAdminPage();
  const [forms, ai] = await Promise.all([listForms(), getAiSettings()]);
  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Formularios web</h1>
          <p className="muted" style={{ margin: 0 }}>
            Formularios alojados en el CRM: tienen su propia página y se pueden incrustar en vuestra web. Lo que llega entra como lead (o deal),
            se puntúa y se reparte solo. Opcionalmente, con un chat con IA que atiende al visitante.
          </p>
        </div>
      </div>
      {forms.length > 0 && (
        <div className="table-wrap" style={{ marginBottom: 18 }}>
          <table>
            <thead><tr><th>Formulario</th><th>Dirección</th><th>Crea</th><th className="num">Recibidos</th><th>Estado</th></tr></thead>
            <tbody>
              {forms.map((f) => (
                <tr key={f.id}>
                  <td><Link href={`/settings/forms/${f.id}`}><strong>{f.name}</strong></Link>{f.chat_enabled && <span className="badge" style={{ marginLeft: 6 }}>Chat IA</span>}</td>
                  <td><code>/f/{f.slug}</code></td>
                  <td>{f.intent === "demo_request" ? "Deal" : "Lead"}</td>
                  <td className="num">{f.submissions}</td>
                  <td><span className={`badge ${f.is_active ? "won" : ""}`}>{f.is_active ? "Activo" : "Inactivo"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="panel">
        <h2>Nuevo formulario</h2>
        <ActionForm action={saveFormAction.bind(null, null)} submitLabel="Crear formulario">
          <FormEditorFields aiOn={aiReady(ai)} />
        </ActionForm>
      </section>
    </main>
  );
}
