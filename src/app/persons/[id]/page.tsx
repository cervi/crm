import Link from "next/link";
import { notFound } from "next/navigation";
import { getPerson, personContactInfo } from "@/lib/persons";
import { listDeals } from "@/lib/deals";
import { leadsOfPerson } from "@/lib/leads";
import { listActivitiesFor } from "@/lib/activities";
import { listNotesFor } from "@/lib/notes";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { timeline } from "@/lib/events";
import { listUsers } from "@/lib/users";
import { sql } from "@/lib/db";
import { date, money, STATUS_LABELS } from "@/lib/format";
import { isId } from "@/lib/validation";
import { changeCompanyAction } from "@/app/actions/records";
import { ActionForm } from "@/components/ActionForm";
import { ActivityPanel } from "@/components/ActivityPanel";
import { NotePanel } from "@/components/NotePanel";
import { CustomFieldValues } from "@/components/CustomFieldValues";
import { EntityPicker } from "@/components/EntityPicker";
import { Avatar } from "@/components/Avatar";
import { Timeline } from "@/components/Timeline";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = isId(id) ? await getPerson(id) : null;
  return { title: p?.full_name ?? "Contacto" };
}

export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const person = await getPerson(id);
  if (!person) notFound();

  const [info, deals, leads, activities, notes, defs, users] = await Promise.all([
    personContactInfo(id), listDeals({ personId: id }), leadsOfPerson(id), listActivitiesFor({ personId: id }),
    listNotesFor({ personId: id }), listFieldDefinitions("person", true), listUsers(),
  ]);
  const events = await timeline(sql, [
    { type: "person", id },
    ...leads.map((l) => ({ type: "lead" as const, id: l.id })),
  ], 40);
  const current = info.companies.filter((c) => c.status === "current");
  const back = `/persons/${id}`;

  return (
    <main className="page">
      <div className="crumbs"><Link href="/persons">Contactos</Link></div>
      <div className="page-head">
        <div className="title-with-avatar">
        <Avatar name={person.full_name} size="lg" />
        <div>
        <h1>{person.full_name}</h1>
        {current[0] && (
          <div className="meta">
            {current[0].job_title ? `${current[0].job_title} · ` : ""}
            <Link href={`/organizations/${current[0].organization_id}`}>{current[0].organization_name}</Link>
          </div>
        )}
        </div>
        </div>
        <span className="spacer" />
        <Link href={`/deals/new?person=${id}${current[0] ? `&organization=${current[0].organization_id}` : ""}`} className="btn secondary">Nuevo deal</Link>
        <Link href={`/persons/${id}/edit`} className="btn secondary">Editar</Link>
      </div>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <h2>Datos de contacto</h2>
            <dl className="dl">
              <div className="dl-row"><dt>Email</dt><dd>{info.emails.length ? info.emails.map((e) => (
                <div key={e.id}><a href={`mailto:${e.email}`}>{e.email}</a>{e.is_primary && info.emails.length > 1 && <span className="meta"> · principal</span>}</div>
              )) : "—"}</dd></div>
              <div className="dl-row"><dt>Teléfono</dt><dd>{info.phones.length ? info.phones.map((p) => <div key={p.id}><a href={`tel:${p.phone}`}>{p.phone}</a></div>) : "—"}</dd></div>
              <div className="dl-row"><dt>LinkedIn</dt><dd>{person.linkedin_url ? <a href={person.linkedin_url} target="_blank" rel="noreferrer">Perfil</a> : "—"}</dd></div>
              <div className="dl-row"><dt>Responsable</dt><dd>{person.owner_name ?? "—"}</dd></div>
              <div className="dl-row"><dt>RGPD</dt><dd>{person.unsubscribed_at ? <span className="badge lost">Dado de baja</span>
                : person.marketing_consent ? <span className="badge won">Acepta comunicaciones</span> : <span className="badge">Sin consentimiento</span>}</dd></div>
              <CustomFieldValues defs={defs} values={person.custom} users={users} />
            </dl>
          </section>

          <section className="panel stack">
            <h2>Empresas</h2>
            <ul className="items">
              {info.companies.length === 0 && <li className="muted">Sin empresa.</li>}
              {info.companies.map((c) => (
                <li key={c.id} className={c.status === "current" ? "item" : "item done"}>
                  <Link href={`/organizations/${c.organization_id}`}><strong>{c.organization_name}</strong></Link>
                  {c.status === "former" && <span className="badge" style={{ marginLeft: 8 }}>Antigua</span>}
                  <div className="meta">{c.job_title ?? "—"} · {c.started_at ? `desde ${date(c.started_at)}` : ""}{c.ended_at ? ` hasta ${date(c.ended_at)}` : ""}</div>
                </li>
              ))}
            </ul>
            <details>
              <summary>Cambio de empresa</summary>
              <p className="meta">La relación actual pasa a «antigua» y se conserva todo su historial.</p>
              <ActionForm action={changeCompanyAction.bind(null, id)} submitLabel="Guardar" resetOnSuccess>
                <EntityPicker name="organization_id" type="organizations" label="Nueva empresa" />
                <label className="field"><span className="label">Cargo</span><input name="job_title" /></label>
                <label className="checkbox"><input type="checkbox" name="left_previous" defaultChecked /> Ha dejado su empresa actual</label>
              </ActionForm>
            </details>
          </section>

          {leads.length > 0 && (
            <section className="panel">
              <h2>Recorrido como lead</h2>
              <ul className="items">
                {leads.map((l) => (
                  <li key={l.id} className="item">
                    <Link href={`/leads/${l.id}`}>{l.source_detail ?? l.source ?? l.title}</Link>
                    <div className="meta">
                      <span className={`badge ${l.status}`}>{STATUS_LABELS[l.status]}</span>
                      {l.funnel_stage && <> <span className={`badge ${l.funnel_stage}`}>{l.funnel_stage.toUpperCase()}</span></>}
                      {" "}{date(l.created_at)}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel"><h2>Historial</h2><Timeline events={events} /></section>
        </div>

        <div className="stack">
          <section className="panel">
            <h2>Deals</h2>
            {deals.length === 0 ? <p className="muted">No participa en ningún deal.</p> : (
              <ul className="items">
                {deals.map((d) => (
                  <li key={d.id} className="item">
                    <div className="item-head">
                      <Link href={`/deals/${d.id}`}><strong>{d.title}</strong></Link>
                      <span className={`badge ${d.status}`}>{STATUS_LABELS[d.status]}</span>
                      <span className="spacer" /><span>{money(d.value, d.currency)}</span>
                    </div>
                    <div className="meta">{d.pipeline_name} · {d.stage_name}{d.organization_name && ` · ${d.organization_name}`}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <ActivityPanel activities={activities} refs={{ person_id: id }} back={back} users={users} />
          <NotePanel notes={notes} refs={{ person_id: id }} back={back} />
        </div>
      </div>
    </main>
  );
}
