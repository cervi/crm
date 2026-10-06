import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { listPersons } from "@/lib/persons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contactos" };

export default async function PersonsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const rows = await listPersons({ q });
  return (
    <main className="page">
      <div className="page-head">
        <h1>Contactos</h1>
        <span className="spacer" />
        <Link href="/persons/new" className="btn"><Icon name="plus" />Nuevo contacto</Link>
      </div>
      <form className="toolbar">
        <input name="q" defaultValue={q} placeholder="Buscar por nombre o email" aria-label="Buscar" />
        <button className="btn secondary">Buscar</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Nombre</th><th>Empresa</th><th>Cargo</th><th>Email</th><th>Teléfono</th><th>Responsable</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="empty-row">No hay contactos{q && " que coincidan"}.</td></tr>}
            {rows.map((p) => (
              <tr key={p.id}>
                <td><span className="cell-main"><Avatar name={p.full_name} size="sm" /><Link href={`/persons/${p.id}`}>{p.full_name}</Link></span></td>
                <td>{p.organization_id ? <Link href={`/organizations/${p.organization_id}`}>{p.organization_name}</Link> : "—"}</td>
                <td>{p.job_title ?? "—"}</td>
                <td>{p.email ?? "—"}</td>
                <td>{p.phone ?? "—"}</td>
                <td>{p.owner_name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
