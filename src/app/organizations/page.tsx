import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { RecordBulkBar } from "@/components/record/RecordBulkBar";
import { ListFiltersBar } from "@/components/record/ListFilters";
import { listOrganizations } from "@/lib/organizations";
import type { ListFilters } from "@/lib/persons";
import { listUsers } from "@/lib/users";
import { listTags } from "@/lib/contact-workspace";
import { activeActivityTypes } from "@/lib/activity-types";
import { requireUser } from "@/lib/auth";
import { date, dateTime, money } from "@/lib/format";
import { DataTable } from "@/components/DataTable";
import { formatCustomValue, listFieldDefinitions } from "@/lib/custom-fields";

export const dynamic = "force-dynamic";
export const metadata = { title: "Empresas" };

type SP = { q?: string; owner?: string; tag?: string; activity?: string; deals?: string; sort?: string };

export default async function OrganizationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const [rows, users, tags, types, defs] = await Promise.all([
    listOrganizations({ ...(sp as ListFilters), me: me.id }), listUsers(), listTags(), activeActivityTypes(), listFieldDefinitions("organization"),
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
      <DataTable id="organizations" selectable empty={<>No hay empresas{filtered && " con esos filtros"}.</>}
        columns={[
          { key: "name", label: "Nombre", required: true, pinned: true },
          { key: "industry", label: "Sector" },
          { key: "domain", label: "Dominio", hidden: true },
          { key: "city", label: "Ciudad", hidden: true },
          { key: "contacts", label: "Contactos", className: "num" },
          { key: "open_deals", label: "Deals abiertos", className: "num" },
          { key: "open_value", label: "Valor abierto", className: "num" },
          { key: "won", label: "Ganado", className: "num" },
          { key: "next", label: "Próxima actividad" },
          { key: "last", label: "Última actividad", hidden: true },
          { key: "tags", label: "Etiquetas", hidden: true },
          { key: "owner", label: "Responsable" },
          { key: "created", label: "Creada", hidden: true },
          ...defs.filter((d) => !d.is_archived).map((d) => ({ key: `cf:${d.key}`, label: d.label, hidden: true })),
        ]}
        rows={rows.map((o) => ({
          id: o.id, label: o.name,
          cells: {
            name: <>
              <span className="cell-main"><Avatar name={o.name} kind="org" size="sm" /><Link href={`/organizations/${o.id}`}>{o.name}</Link></span>
              {o.tags.length > 0 && <div className="tags-inline">{o.tags.map((t) => <span key={t.name} className={`tag tag-${t.color}`}>{t.name}</span>)}</div>}
            </>,
            industry: o.industry, domain: o.domain, city: o.city,
            contacts: o.contacts, open_deals: o.open_deals || null,
            open_value: Number(o.open_value) ? money(o.open_value) : null,
            won: Number(o.won_value) ? money(o.won_value) : null,
            next: o.next_activity ? <span className={new Date(o.next_activity) < new Date() ? "tone-bad" : undefined}>{dateTime(o.next_activity)}</span> : null,
            last: o.last_activity ? dateTime(o.last_activity) : null,
            tags: o.tags.length ? <div className="tags-inline">{o.tags.map((t) => <span key={t.name} className={`tag tag-${t.color}`}>{t.name}</span>)}</div> : null,
            owner: o.owner_name, created: date(o.created_at),
            ...Object.fromEntries(defs.map((d) => [`cf:${d.key}`, formatCustomValue(d, o.custom?.[d.key], users) || null])),
          },
        }))} />
    </main>
  );
}
