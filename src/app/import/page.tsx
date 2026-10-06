import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { IMPORT_FIELDS } from "@/lib/csv-import";
import { CsvImporter } from "./CsvImporter";

export const dynamic = "force-dynamic";
export const metadata = { title: "Importar CSV" };

export default async function ImportPage() {
  await requireUser();
  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Importar desde un CSV</h1>
          <p className="muted" style={{ margin: 0 }}>
            Contactos o leads desde Excel, Google Sheets u otra herramienta (guárdalo como CSV). Se reconocen las columnas por su título y se
            puede corregir antes de importar. Los contactos se unen por email: si ya existen, no se duplican. Para traer todo Pipedrive, usa
            {" "}<Link href="/settings/import">la importación de Pipedrive</Link>.
          </p>
        </div>
      </div>
      <CsvImporter fields={Object.entries(IMPORT_FIELDS).map(([value, label]) => ({ value, label }))} />
    </main>
  );
}
