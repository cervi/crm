import Link from "next/link";
import { saveCompanyAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { requireAdminPage } from "@/lib/auth";
import { getCompany } from "@/lib/company";

export const dynamic = "force-dynamic";
export const metadata = { title: "Ajustes de empresa" };

const ZONES: [string, string][] = [["Europe/Madrid", "España peninsular y Baleares (Madrid)"], ["Atlantic/Canary", "Canarias"], ["Europe/Lisbon", "Portugal (Lisboa)"],
  ["Europe/London", "Reino Unido (Londres)"], ["Europe/Paris", "Francia (París)"], ["America/Mexico_City", "México (Ciudad de México)"], ["America/Bogota", "Colombia (Bogotá)"],
  ["America/Lima", "Perú (Lima)"], ["America/Santiago", "Chile (Santiago)"], ["America/Argentina/Buenos_Aires", "Argentina (Buenos Aires)"],
  ["America/New_York", "EE. UU. costa este (Nueva York)"], ["America/Sao_Paulo", "Brasil (São Paulo)"], ["UTC", "Hora universal (UTC)"]];
const CURRENCIES: [string, string][] = [["EUR", "Euro (€)"], ["USD", "Dólar estadounidense ($)"], ["GBP", "Libra esterlina (£)"], ["MXN", "Peso mexicano"],
  ["COP", "Peso colombiano"], ["CLP", "Peso chileno"], ["ARS", "Peso argentino"], ["PEN", "Sol peruano"], ["BRL", "Real brasileño"], ["CHF", "Franco suizo"]];

export default async function CompanyPage() {
  await requireAdminPage();
  const c = await getCompany();
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><div><h1>Ajustes de empresa</h1>
        <p className="muted" style={{ margin: 0 }}>Lo que ven tus compañeros al entrar y tus contactos en los correos del sistema.</p></div></div>
      <section className="panel">
        <ActionForm action={saveCompanyAction} submitLabel="Guardar ajustes de empresa">
          <div className="grid-2">
            <label className="field"><span className="label">Nombre de la empresa</span><input name="company_name" maxLength={80} defaultValue={c.name ?? ""} placeholder="p. ej. Aikit" />
              <span className="meta">Sale en la pantalla de entrada y en las invitaciones («Jesús te invita a Aikit»).</span></label>
            <div className="field"><span className="label">Logo</span>
              {c.logo && <img src={c.logo} alt="Logo actual" className="company-logo" />}
              <input name="logo" type="file" accept="image/png,image/jpeg,image/webp" />
              <span className="meta">PNG, JPG o WebP de hasta 300 KB. Mejor horizontal y con fondo transparente.</span>
              {c.logo && <label className="checkbox"><input type="checkbox" name="remove_logo" />Quitar el logo</label>}</div>
            <label className="field"><span className="label">Moneda por defecto</span>
              <select name="default_currency" defaultValue={c.currency}>{CURRENCIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <span className="meta">La de los deals y productos nuevos.</span></label>
            <label className="field"><span className="label">Zona horaria de la empresa</span>
              <select name="company_timezone" defaultValue={c.timezone}>{ZONES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <span className="meta">La de los resúmenes y los horarios nuevos.</span></label>
          </div>
        </ActionForm>
      </section>
    </main>
  );
}
