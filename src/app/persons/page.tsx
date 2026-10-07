import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { BulkSelectAll } from "@/components/DealBulkBar";
import { RecordBulkBar } from "@/components/record/RecordBulkBar";
import { ListFiltersBar } from "@/components/record/ListFilters";
import { listPersons, type ListFilters } from "@/lib/persons";
import { listUsers } from "@/lib/users";
import { listTags } from "@/lib/contact-workspace";
import { listSequences } from "@/lib/sequences";
import { activeActivityTypes } from "@/lib/activity-types";
import { requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contactos" };

type SP = { q?: string; owner?: string; tag?: string; activity?: string; deals?: string; sort?: string };

export default async function PersonsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const [rows, users, tags, sequences, types] = await Promise.all([
    listPersons({ ...(sp as ListFilters), me: me.id }), listUsers(), listTags(), listSequences(), activeActivityTypes(),
  ]);
  const humans = users.filter((u) => u.kind === "human").map((u) => ({ value: u.id, label: u.name }));
  const filtered = Object.values(sp).some(Boolean);
  return (
    <main className="page">
      <div className="page-head">
        <h1>Contactos <span className="muted">{rows.length}{rows.length >= 300 ? "+" : ""}</span></h1>
        <span className="spacer" />
        <Link href="/duplicates" className="btn secondary">Duplicados</Link>
        <ExportLink dataset="persons" params={{ q: sp.q ?? "" }} />
        <Link href="/persons/new" className="btn"><Icon name="plus" />Nuevo contacto</Link>
      </div>
      <ListFiltersBar base="/persons" sp={sp} users={humans} tags={tags.map((t) => ({ value: t.id, label: t.name }))} placeholder="Buscar por nombre, email o empresa" />
      <RecordBulkBar kind="person" users={humans} types={types.map((t) => ({ value: t.key, label: t.label }))}
                     sequences={sequences.filter((s) => s.is_active && s.steps > 0).map((s) => ({ value: s.id, label: s.name }))} tags={tags.map((t) => t.name)} />
      <div className="table-wrap">
        <table>
          <thead><tr><th className="check-col"><BulkSelectAll /></th><th>Nombre</th><th>Empresa</th><th>Email</th><th>Teléfono</th><th className="num">Deals</th><th>Próxima actividad</th><th>Responsable</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="empty-row">No hay contactos{filtered && " con esos filtros"}.</td></tr>}
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="check-col"><input type="checkbox" className="bulk-check" value={p.id} aria-label={`Seleccionar ${p.full_name}`} /></td>
                <td>
                  <span className="cell-main"><Avatar name={p.full_name} size="sm" /><Link href={`/persons/${p.id}`}>{p.full_name}</Link></span>
                  {p.tags.length > 0 && <div className="tags-inline">{p.tags.map((t) => <span key={t.name} className={`tag tag-${t.color}`}>{t.name}</span>)}</div>}
                </td>
                <td>{p.organization_id ? <Link href={`/organizations/${p.organization_id}`}>{p.organization_name}</Link> : "—"}{p.job_title && <div className="meta">{p.job_title}</div>}</td>
                <td>{p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : "—"}</td>
                <td>{p.phone ? <a href={`tel:${p.phone.replace(/[^\d+]/g, "")}`}>{p.phone}</a> : "—"}</td>
                <td className="num">{p.open_deals || "—"}</td>
                <td>{p.next_activity ? <span className={new Date(p.next_activity) < new Date() ? "tone-bad" : undefined}>{dateTime(p.next_activity)}</span> : <span className="muted">—</span>}</td>
                <td>{p.owner_name ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
