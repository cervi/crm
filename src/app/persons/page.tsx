import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { RecordBulkBar } from "@/components/record/RecordBulkBar";
import { ListFiltersBar } from "@/components/record/ListFilters";
import { listPersons, type ListFilters } from "@/lib/persons";
import { listUsers } from "@/lib/users";
import { listTags } from "@/lib/contact-workspace";
import { listSequences } from "@/lib/sequences";
import { activeActivityTypes } from "@/lib/activity-types";
import { requireUser } from "@/lib/auth";
import { date, dateTime } from "@/lib/format";
import { DataTable } from "@/components/DataTable";
import { formatCustomValue, listFieldDefinitions } from "@/lib/custom-fields";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contactos" };

type SP = { q?: string; owner?: string; tag?: string; activity?: string; deals?: string; sort?: string };

export default async function PersonsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const me = await requireUser();
  const [rows, users, tags, sequences, types, defs] = await Promise.all([
    listPersons({ ...(sp as ListFilters), me: me.id }), listUsers(), listTags(), listSequences(), activeActivityTypes(), listFieldDefinitions("person"),
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
      <DataTable id="persons" selectable empty={<>No hay contactos{filtered && " con esos filtros"}.</>}
        columns={[
          { key: "name", label: "Nombre", required: true, pinned: true },
          { key: "org", label: "Empresa" },
          { key: "job", label: "Cargo", hidden: true },
          { key: "email", label: "Email" },
          { key: "phone", label: "Teléfono" },
          { key: "deals", label: "Deals", className: "num" },
          { key: "next", label: "Próxima actividad" },
          { key: "last", label: "Última actividad", hidden: true },
          { key: "tags", label: "Etiquetas", hidden: true },
          { key: "owner", label: "Responsable" },
          { key: "created", label: "Creado", hidden: true },
          ...defs.filter((d) => !d.is_archived).map((d) => ({ key: `cf:${d.key}`, label: d.label, hidden: true })),
        ]}
        rows={rows.map((p) => ({
          id: p.id, label: p.full_name,
          cells: {
            name: <>
              <span className="cell-main"><Avatar name={p.full_name} size="sm" /><Link href={`/persons/${p.id}`}>{p.full_name}</Link></span>
              {p.tags.length > 0 && <div className="tags-inline">{p.tags.map((t) => <span key={t.name} className={`tag tag-${t.color}`}>{t.name}</span>)}</div>}
            </>,
            org: p.organization_id ? <><Link href={`/organizations/${p.organization_id}`}>{p.organization_name}</Link>{p.job_title && <div className="meta">{p.job_title}</div>}</> : null,
            job: p.job_title,
            email: p.email ? <a href={`mailto:${p.email}`}>{p.email}</a> : null,
            phone: p.phone ? <a href={`tel:${p.phone.replace(/[^\d+]/g, "")}`}>{p.phone}</a> : null,
            deals: p.open_deals || null,
            next: p.next_activity ? <span className={new Date(p.next_activity) < new Date() ? "tone-bad" : undefined}>{dateTime(p.next_activity)}</span> : null,
            last: p.last_activity ? dateTime(p.last_activity) : null,
            tags: p.tags.length ? <div className="tags-inline">{p.tags.map((t) => <span key={t.name} className={`tag tag-${t.color}`}>{t.name}</span>)}</div> : null,
            owner: p.owner_name, created: date(p.created_at),
            ...Object.fromEntries(defs.map((d) => [`cf:${d.key}`, formatCustomValue(d, p.custom?.[d.key], users) || null])),
          },
        }))} />
    </main>
  );
}
