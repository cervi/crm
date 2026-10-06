import Link from "next/link";
import { notFound } from "next/navigation";
import { getOrganization, organizationContacts } from "@/lib/organizations";
import { listDeals } from "@/lib/deals";
import { listActivitiesFor } from "@/lib/activities";
import { listNotesFor } from "@/lib/notes";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { timeline } from "@/lib/events";
import { listUsers } from "@/lib/users";
import { sql } from "@/lib/db";
import { date, money, STATUS_LABELS } from "@/lib/format";
import { isId } from "@/lib/validation";
import { ActivityPanel } from "@/components/ActivityPanel";
import { NotePanel } from "@/components/NotePanel";
import { CustomFieldValues } from "@/components/CustomFieldValues";
import { Avatar } from "@/components/Avatar";
import { Timeline } from "@/components/Timeline";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = isId(id) ? await getOrganization(id) : null;
  return { title: org?.name ?? "Empresa" };
}

export default async function OrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const org = await getOrganization(id);
  if (!org) notFound();

  const [contacts, deals, activities, notes, defs, users, dealIds] = await Promise.all([
    organizationContacts(id), listDeals({ organizationId: id }), listActivitiesFor({ organizationId: id }),
    listNotesFor({ organizationId: id }), listFieldDefinitions("organization", true), listUsers(),
    sql<{ id: string }[]>`SELECT id FROM deals WHERE organization_id = ${id}`,
  ]);
  const events = await timeline(sql, [
    { type: "organization", id },
    ...dealIds.map((d) => ({ type: "deal" as const, id: d.id })),
  ], 40);
  const current = contacts.filter((c) => c.status === "current");
  const former = contacts.filter((c) => c.status === "former");
  const back = `/organizations/${id}`;

  return (
    <main className="page">
      <div className="crumbs"><Link href="/organizations">Empresas</Link></div>
      <div className="page-head">
        <div className="title-with-avatar">
          <Avatar name={org.name} kind="org" size="lg" />
          <div><h1>{org.name}</h1>{org.domain && <div className="meta">{org.domain}</div>}</div>
        </div>
        <span className="spacer" />
        <Link href={`/deals/new?organization=${id}`} className="btn secondary">Nuevo deal</Link>
        <Link href={`/organizations/${id}/edit`} className="btn secondary">Editar</Link>
      </div>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <h2>Datos</h2>
            <dl className="dl">
              <div className="dl-row"><dt>Web</dt><dd>{org.website ? <a href={org.website.startsWith("http") ? org.website : `https://${org.website}`} target="_blank" rel="noreferrer">{org.website}</a> : "—"}</dd></div>
              <div className="dl-row"><dt>Sector</dt><dd>{org.industry ?? "—"}</dd></div>
              <div className="dl-row"><dt>Empleados</dt><dd>{org.employee_count ?? "—"}</dd></div>
              <div className="dl-row"><dt>Ubicación</dt><dd>{[org.city, org.country].filter(Boolean).join(", ") || "—"}</dd></div>
              <div className="dl-row"><dt>Responsable</dt><dd>{org.owner_name ?? "—"}</dd></div>
              <div className="dl-row"><dt>Alta</dt><dd>{date(org.created_at)}</dd></div>
              <CustomFieldValues defs={defs} values={org.custom} users={users} />
            </dl>
          </section>

          <section className="panel">
            <div className="item-head" style={{ marginBottom: 8 }}>
              <h2 style={{ margin: 0 }}>Contactos</h2><span className="spacer" />
              <Link href={`/persons/new?organization=${id}`} className="meta">+ Añadir contacto</Link>
            </div>
            {current.length === 0 && <p className="muted">Sin contactos actuales.</p>}
            <ul className="items">
              {current.map((c) => (
                <li key={c.person_id} className="item">
                  <div className="cell-main">
                    <Avatar name={c.full_name} />
                    <div>
                      <Link href={`/persons/${c.person_id}`}><strong>{c.full_name}</strong></Link>
                      <div className="meta">{[c.job_title, c.email].filter(Boolean).join(" · ") || "—"}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {former.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary>Antiguos contactos ({former.length})</summary>
                <ul className="items">
                  {former.map((c) => (
                    <li key={c.person_id} className="item done">
                      <Link href={`/persons/${c.person_id}`}>{c.full_name}</Link>
                      <div className="meta">{c.job_title ?? "—"} · hasta {date(c.ended_at)}</div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="panel">
            <h2>Historial</h2>
            <Timeline events={events} />
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <h2>Deals</h2>
            {deals.length === 0 ? <p className="muted">Todavía no hay deals.</p> : (
              <div className="table-wrap" style={{ border: 0 }}>
                <table>
                  <thead><tr><th>Deal</th><th>Pipeline / fase</th><th>Estado</th><th className="num">Importe</th></tr></thead>
                  <tbody>
                    {deals.map((d) => (
                      <tr key={d.id}>
                        <td><Link href={`/deals/${d.id}`}>{d.title}</Link></td>
                        <td>{d.pipeline_name} · {d.stage_name}</td>
                        <td><span className={`badge ${d.status}`}>{STATUS_LABELS[d.status]}</span></td>
                        <td className="num">{money(d.value, d.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <ActivityPanel activities={activities} refs={{ organization_id: id }} back={back} users={users} />
          <NotePanel notes={notes} refs={{ organization_id: id }} back={back} />
        </div>
      </div>
    </main>
  );
}
