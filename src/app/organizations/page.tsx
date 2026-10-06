import Link from "next/link";
import { listOrganizations } from "@/lib/organizations";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Empresas" };

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const rows = await listOrganizations({ q });
  return (
    <main className="page">
      <div className="page-head">
        <h1>Empresas</h1>
        <span className="spacer" />
        <Link href="/organizations/new" className="btn"><Icon name="plus" />Nueva empresa</Link>
      </div>
      <form className="toolbar">
        <input name="q" defaultValue={q} placeholder="Buscar por nombre o dominio" aria-label="Buscar" />
        <button className="btn secondary">Buscar</button>
      </form>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Nombre</th><th>Dominio</th><th>Sector</th><th className="num">Contactos</th>
                <th className="num">Deals abiertos</th><th className="num">Valor abierto</th><th>Responsable</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="empty-row">No hay empresas{q && " que coincidan"}.</td></tr>}
            {rows.map((o) => (
              <tr key={o.id}>
                <td><span className="cell-main"><Avatar name={o.name} kind="org" size="sm" /><Link href={`/organizations/${o.id}`}>{o.name}</Link></span></td>
                <td>{o.domain ?? "—"}</td>
                <td>{o.industry ?? "—"}</td>
                <td className="num">{o.contacts}</td>
                <td className="num">{o.open_deals}</td>
                <td className="num">{money(o.open_value)}</td>
                <td>{o.owner_name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
