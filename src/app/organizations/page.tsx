import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { BulkSelectAll } from "@/components/DealBulkBar";
import { RecordBulkBar } from "@/components/record/RecordBulkBar";
import { ListFiltersBar } from "@/components/record/ListFilters";
import { listOrganizations } from "@/lib/organizations";
import type { ListFilters } from "@/lib/persons";
import { listUsers } from "@/lib/users";
import { listTags } from "@/lib/contact-workspace";
import { activeActivityTypes } from "@/lib/activity-types";
import { requireUser } from "@/lib/auth";
import { dateTime, money } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Empresas" };

type SP = { q?: string; owner?: string; tag?: string; activity?: string; deals?: string; sort?: string };

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const [rows, users, tags, types] = await Promise.all([
    listOrganizations({ ...(sp as ListFilters), me: me.id }), listUsers(), listTags(), activeActivityTypes(),
  ]);
  const humans = users.filter((u) => u.kind === "human").map((u) => ({ value: u.id, label: u.name }));
  const filtered = Object.values(sp).some(Boolean);
  return (
    <main className="page">
      <div className="page-head">
        <h1>Empresas <span className="muted">{rows.length}{rows.length >= 300 ? "+" : ""}</span></h1>
        <span className="spacer" />
        <Link href="/duplicates" className="btn secondary">Duplicados</Link>
        <ExportLink dataset="organizations" params={{ q: sp.q ?? "" }} />
        <Link href="/organizations/new" className="btn"><Icon name="plus" />Nueva empresa</Link>
      </div>
      <ListFiltersBar base="/organizations" sp={sp} users={humans} tags={tags.map((t) => ({ value: t.id, label: t.name }))} placeholder="Buscar por nombre o dominio" />
      <RecordBulkBar kind="organization" users={humans} types={types.map((t) => ({ value: t.key, label: t.label }))} tags={tags.map((t) => t.name)} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th className="check-col"><BulkSelectAll /></th><th>Nombre</th><th>Sector</th><th className="num">Contactos</th>
                <th className="num">Deals abiertos</th><th className="num">Valor abierto</th><th className="num">Ganado</th><th>Próxima actividad</th><th>Responsable</th></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={9} className="empty-row">No hay empresas{filtered && " con esos filtros"}.</td></tr>}
            {rows.map((o) => (
              <tr key={o.id}>
                <td className="check-col"><input type="checkbox" className="bulk-check" value={o.id} aria-label={`Seleccionar ${o.name}`} /></td>
                <td>
                  <span className="cell-main"><Avatar name={o.name} kind="org" size="sm" /><Link href={`/organizations/${o.id}`}>{o.name}</Link></span>
                  <div className="meta">{[o.domain, o.city].filter(Boolean).join(" · ")}</div>
                  {o.tags.length > 0 && <div className="tags-inline">{o.tags.map((t) => <span key={t.name} className={`tag tag-${t.color}`}>{t.name}</span>)}</div>}
                </td>
                <td>{o.industry ?? "—"}</td>
                <td className="num">{o.contacts}</td>
                <td className="num">{o.open_deals}</td>
                <td className="num">{money(o.open_value)}</td>
                <td className="num">{Number(o.won_value) ? money(o.won_value) : "—"}</td>
                <td>{o.next_activity ? dateTime(o.next_activity) : <span className="muted">—</span>}</td>
                <td>{o.owner_name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
