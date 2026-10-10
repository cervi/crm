import Link from "next/link";
import { sql } from "@/lib/db";
import { createPipelineAction } from "@/app/actions/settings";
import { ActionForm } from "@/components/ActionForm";
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pipelines" };

export default async function PipelinesSettingsPage() {
  await requireAdminPage();
  const rows = await sql<{ id: string; name: string; is_active: boolean; stages: number; open_deals: number }[]>`
    SELECT p.id, p.name, p.is_active,
           (SELECT count(*)::int FROM stages s WHERE s.pipeline_id = p.id AND s.is_active) AS stages,
           (SELECT count(*)::int FROM deals d WHERE d.pipeline_id = p.id AND d.status = 'open' AND d.deleted_at IS NULL) AS open_deals
    FROM pipelines p ORDER BY p.position, p.name`;
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><h1>Pipelines</h1></div>
      <div className="stack">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Pipeline</th><th className="num">Fases</th><th className="num">Deals abiertos</th><th>Estado</th></tr></thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/settings/pipelines/${p.id}`}>{p.name}</Link></td>
                  <td className="num">{p.stages}</td>
                  <td className="num">{p.open_deals}</td>
                  <td>{p.is_active ? <span className="badge won">Activo</span> : <span className="badge">Inactivo</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <section className="panel">
          <h2>Nuevo pipeline</h2>
          <ActionForm action={createPipelineAction} submitLabel="Crear pipeline">
            <label className="field"><span className="label">Nombre *</span><input name="name" required /></label>
            <label className="field"><span className="label">Descripción</span><input name="description" /></label>
            <label className="field"><span className="label">Fases (una por línea)</span>
              <textarea name="stages" rows={5} placeholder={"Primer contacto\nReunión agendada\nPropuesta enviada\nNegociación"} /></label>
          </ActionForm>
        </section>
      </div>
    </main>
  );
}
