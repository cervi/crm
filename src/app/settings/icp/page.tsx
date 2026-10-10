import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { getIcp, icpEmpty } from "@/lib/icp";
import { sql } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { saveIcpAction } from "@/app/actions/outbound";

export const dynamic = "force-dynamic";
export const metadata = { title: "Perfil de cliente ideal" };

export default async function IcpPage() {
  await requireAdminPage();
  const icp = await getIcp();
  const [stats] = await sql<{ fit: number; no_fit: number; unknown: number }[]>`
    SELECT count(*) FILTER (WHERE fit = 'fit')::int AS fit, count(*) FILTER (WHERE fit = 'no_fit')::int AS no_fit,
           count(*) FILTER (WHERE fit = 'unknown')::int AS unknown FROM leads WHERE status = 'open' AND deleted_at IS NULL`;
  const join = (xs: string[]) => xs.join(", ");
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><div>
        <h1>Perfil de cliente ideal</h1>
        <p className="muted" style={{ margin: 0 }}>
          A quién queréis vender. Con esto, el agente de captación dice de cada lead si encaja, si no encaja o qué falta saber, y la
          puntuación lo tiene en cuenta. Las campañas de outbound también lo usan como punto de partida.
        </p>
      </div></div>
      {icpEmpty(icp) && <p className="callout">Todavía está vacío: mientras tanto, el agente no descarta a nadie. Rellena solo lo que tengáis claro; se puede cambiar cuando queráis.</p>}
      {!icpEmpty(icp) && (
        <p className="meta">Leads abiertos: <Link href="/leads?fit=fit">{stats.fit} encajan</Link> · <Link href="/leads?fit=unknown">{stats.unknown} falta saber</Link> · <Link href="/leads?fit=no_fit">{stats.no_fit} no encajan</Link>. Al guardar, se vuelven a cualificar.</p>
      )}
      <section className="panel">
        <ActionForm action={saveIcpAction} submitLabel="Guardar perfil">
          <div className="grid-2">
            <label className="field span-2"><span className="label">Sectores</span><input name="sectors" defaultValue={join(icp.sectors)} placeholder="Software, logística, retail…" />
              <span className="meta">Separados por comas. Vacío: cualquiera.</span></label>
            <label className="field"><span className="label">Empleados, desde</span><input name="min_employees" type="number" min={0} defaultValue={icp.min_employees ?? ""} /></label>
            <label className="field"><span className="label">Empleados, hasta</span><input name="max_employees" type="number" min={0} defaultValue={icp.max_employees ?? ""} /></label>
            <label className="field"><span className="label">Países</span><input name="countries" defaultValue={join(icp.countries)} placeholder="España, Portugal…" /></label>
            <label className="field"><span className="label">Cargos que compran</span><input name="roles" defaultValue={join(icp.roles)} placeholder="CEO, director comercial, CMO…" /></label>
            <label className="field span-2"><span className="label">Exclusiones</span><input name="exclusions" defaultValue={join(icp.exclusions)} placeholder="competidores, consultoras, gmail.com…" />
              <span className="meta">Si aparecen en el dominio, el sector o la descripción de la empresa, no encaja.</span></label>
            <label className="field span-2"><span className="label">Otros criterios (en texto libre, para la IA)</span>
              <textarea name="must_have" rows={3} defaultValue={icp.must_have ?? ""} placeholder="Tienen equipo comercial propio, venden B2B, usan un CRM…" /></label>
            <label className="field span-2"><span className="label">Cómo cualificáis (BANT, MEDDIC…)</span>
              <textarea name="framework" rows={3} defaultValue={icp.framework ?? ""} placeholder="Presupuesto, quién decide, necesidad y plazo…" /></label>
          </div>
        </ActionForm>
      </section>
    </main>
  );
}
