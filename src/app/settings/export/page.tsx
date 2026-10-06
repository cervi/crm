import Link from "next/link";
import { DATASETS, getCsvSeparator } from "@/lib/export";
import { saveCsvSeparatorAction } from "@/app/actions/export";
import { ActionForm } from "@/components/ActionForm";
import { ExportLink } from "@/components/ExportLink";

export const dynamic = "force-dynamic";
export const metadata = { title: "Exportar datos" };

export default async function ExportSettingsPage() {
  const sep = await getCsvSeparator();
  const full = Object.entries(DATASETS).filter(([, d]) => d.full);
  return (
    <main className="page" style={{ maxWidth: 860 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Exportar datos</h1>
          <p className="muted" style={{ margin: 0 }}>
            Todo se puede exportar a CSV. Cada listado tiene su botón «Exportar CSV», que descarga lo que estás viendo con sus filtros;
            aquí tienes la exportación completa de cada tipo de dato. Los campos personalizados salen como columnas.
          </p>
        </div>
      </div>

      <section className="panel">
        <h2>Exportación completa</h2>
        <ul className="export-list">
          {full.map(([key, d]) => (
            <li key={key}>
              <strong>{d.label}</strong>
              <ExportLink dataset={key} label="Descargar CSV" small />
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Formato</h2>
        <ActionForm action={saveCsvSeparatorAction} submitLabel="Guardar" secondary className="form inline">
          <label className="field"><span className="label">Separador de columnas</span>
            <select name="separator" defaultValue={sep === "\t" ? "tab" : sep}>
              <option value=";">Punto y coma (Excel en español)</option>
              <option value=",">Coma (Excel en inglés, Google Sheets)</option>
              <option value="tab">Tabulador</option>
            </select>
          </label>
        </ActionForm>
        <p className="meta">
          Los archivos van en UTF-8 (las tildes se ven bien en Excel), con las fechas en hora local. Con punto y coma, los importes usan coma decimal.
        </p>
      </section>
    </main>
  );
}
