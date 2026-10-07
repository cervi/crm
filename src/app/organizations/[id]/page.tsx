import Link from "next/link";
import { notFound } from "next/navigation";
import { trashAction } from "@/app/actions/trash";
import { changeOwnerAction, mergeWithAction, sendContactEmailAction } from "@/app/actions/contact";
import { getOrganization, organizationContacts } from "@/lib/organizations";
import { listDeals } from "@/lib/deals";
import { listActivitiesFor } from "@/lib/activities";
import { listNotesFor } from "@/lib/notes";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { timeline } from "@/lib/events";
import { listUsers } from "@/lib/users";
import { listEmails } from "@/lib/emails";
import { listFiles } from "@/lib/files";
import { listFollowers } from "@/lib/followers";
import { listTags, overviewFor, tagsOf } from "@/lib/contact-workspace";
import { buildHistory } from "@/lib/history";
import { connectionOf, senderFor } from "@/lib/mailbox";
import { signatureFor, signaturePreview } from "@/lib/signatures";
import { publicBase } from "@/lib/email-track";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { date, dateTime, money, STATUS_LABELS } from "@/lib/format";
import { isId } from "@/lib/validation";
import { ActionForm } from "@/components/ActionForm";
import { ExportLink } from "@/components/ExportLink";
import { CustomFieldValues } from "@/components/CustomFieldValues";
import { EntityPicker } from "@/components/EntityPicker";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { AccountPanel } from "@/components/AccountPanel";
import { EmailComposerFields } from "@/components/deal/DealClient";
import { ComposerTabsBox } from "@/components/record/Tabs";
import { HistoryFeed } from "@/components/record/HistoryFeed";
import {
  ActivityForm, CallForm, FilesPanel, FocusBlock, FollowersBlock, NoteForm, OverviewBlock, TagsBlock,
} from "@/components/record/Blocks";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const org = isId(id) ? await getOrganization(id) : null;
  return { title: org?.name ?? "Empresa" };
}

export default async function OrganizationPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  if (!isId(id)) notFound();
  const me = await requireUser();
  const org = await getOrganization(id);
  if (!org) notFound();
  const back = `/organizations/${id}`;

  const [contacts, deals, activities, notes, defs, users, dealIds, emails, files, followers, tags, allTags, overview] = await Promise.all([
    organizationContacts(id), listDeals({ organizationId: id }), listActivitiesFor({ organizationId: id }),
    listNotesFor({ organizationId: id }), listFieldDefinitions("organization", true), listUsers(),
    sql<{ id: string }[]>`SELECT id FROM deals WHERE organization_id = ${id}`, listEmails({ organizationId: id }),
    listFiles({ organization_id: id }), listFollowers("organization", id), tagsOf("organization", id), listTags(), overviewFor({ organizationId: id }),
  ]);
  const events = await timeline(sql, [{ type: "organization", id }, ...dealIds.map((d) => ({ type: "deal" as const, id: d.id }))], 60);
  const current = contacts.filter((c) => c.status === "current");
  const former = contacts.filter((c) => c.status === "former");
  const reachable = current.filter((c) => c.email);
  const humans = users.filter((u) => u.kind === "human");
  const openDeals = deals.filter((d) => d.status === "open");

  const myConn = await connectionOf(me.id);
  const sendingConn = myConn?.status === "active" ? myConn : await senderFor(org.owner_id);
  const signatureHtml = sendingConn ? signaturePreview(await signatureFor(sendingConn), sendingConn) : "";
  const [settings] = await sql<{ email_tracking: boolean }[]>`SELECT email_tracking FROM app_settings LIMIT 1`;

  const history = buildHistory({ notes, activities, emails, files, events, showDeal: true });
  const refs = { organization_id: id };
  const web = org.website ? (org.website.startsWith("http") ? org.website : `https://${org.website}`) : null;

  return (
    <main className="page record-page">
      <div className="crumbs"><Link href="/organizations">Empresas</Link></div>
      <header className="record-head">
        <div className="title-with-avatar">
          <Avatar name={org.name} kind="org" size="lg" />
          <div>
            <h1>{org.name}</h1>
            <div className="meta">{[org.industry, [org.city, org.country].filter(Boolean).join(", "), org.domain].filter(Boolean).join(" · ") || "—"}</div>
            <TagsBlock entity="organization" id={id} tags={tags} all={allTags} back={back} />
          </div>
        </div>
        <span className="spacer" />
        <nav className="quick-actions" aria-label="Acciones rápidas">
          {reachable.length > 0 && <Link className="btn secondary" href={`${back}?tab=email#compositor`}><Icon name="mail" />Correo</Link>}
          <Link className="btn secondary" href={`${back}?tab=call#compositor`}>Registrar llamada</Link>
          {web && <a className="btn secondary" href={web} target="_blank" rel="noreferrer">Web</a>}
          <Link href={`/persons/new?organization=${id}`} className="btn secondary"><Icon name="plus" />Contacto</Link>
          <Link href={`/deals/new?organization=${id}`} className="btn"><Icon name="plus" />Nuevo deal</Link>
          <details className="menu-wrap more-menu">
            <summary className="btn secondary" aria-label="Más acciones">···</summary>
            <div className="dropdown">
              <Link href={`/organizations/${id}/edit`}>Editar</Link>
              <ExportLink dataset="deals" params={{ organization: id }} label="Exportar deals" />
              <ExportLink dataset="persons" params={{ organization: id }} label="Exportar contactos" />
              <a href="#fusionar">Fusionar con otra empresa</a>
              <div className="dropdown-sep" />
              <ActionForm action={trashAction.bind(null, "organization", id)} submitLabel="Borrar empresa" pendingLabel="…" secondary className="form inline" />
            </div>
          </details>
        </nav>
      </header>

      <div className="record-layout">
        <aside className="record-side">
          <section className="side-section" aria-label="Datos de la empresa">
            <h3>Datos</h3>
            <dl className="dl">
              <div className="dl-row"><dt>Web</dt><dd>{web ? <a href={web} target="_blank" rel="noreferrer">{org.website}</a> : "—"}</dd></div>
              {org.description && <div className="dl-row"><dt>A qué se dedica</dt><dd>{org.description}</dd></div>}
              <div className="dl-row"><dt>Sector</dt><dd>{org.industry ?? "—"}</dd></div>
              <div className="dl-row"><dt>Empleados</dt><dd>{org.employee_count ?? "—"}</dd></div>
              <div className="dl-row"><dt>Ubicación</dt><dd>{[org.address, org.city, org.country].filter(Boolean).join(", ") || "—"}</dd></div>
              <div className="dl-row"><dt>Responsable</dt><dd>
                <ActionForm action={changeOwnerAction.bind(null, "organization", id, back)} submitLabel="Cambiar" secondary className="form inline owner-form">
                  <select name="owner_id" defaultValue={org.owner_id ?? ""} aria-label="Responsable">
                    <option value="">Sin responsable</option>
                    {humans.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </ActionForm>
              </dd></div>
              <div className="dl-row"><dt>Customer Success</dt><dd>{org.cs_manager_email
                ? <>{org.cs_manager_name ?? org.cs_manager_email}{org.cs_manager_name && <span className="meta"> · {org.cs_manager_email}</span>}</>
                : <span className="muted">Dirección de CS por defecto</span>}</dd></div>
              <CustomFieldValues defs={defs} values={org.custom} users={users} />
            </dl>
            <Link href={`/organizations/${id}/edit`} className="meta">Editar datos</Link>
          </section>

          <section className="side-section" aria-label="Contactos">
            <div className="side-head"><h3>Contactos <span className="muted">{current.length}</span></h3>
              <Link href={`/persons/new?organization=${id}`} className="meta">+ Contacto</Link></div>
            {current.length === 0 && <p className="muted">Sin contactos actuales.</p>}
            <ul className="items">
              {current.map((c) => (
                <li key={c.person_id} className="item">
                  <div className="cell-main">
                    <Avatar name={c.full_name} size="sm" />
                    <div>
                      <Link href={`/persons/${c.person_id}`}><strong>{c.full_name}</strong></Link>
                      <div className="meta">{[c.job_title, c.email].filter(Boolean).join(" · ") || "—"}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {former.length > 0 && (
              <details style={{ marginTop: 8 }}>
                <summary className="meta">Antiguos contactos ({former.length})</summary>
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

          <section className="side-section" aria-label="Deals">
            <div className="side-head"><h3>Deals <span className="muted">{deals.length}</span></h3><Link className="meta" href={`/deals/new?organization=${id}`}>+ Deal</Link></div>
            {deals.length === 0 ? <p className="muted">Todavía no hay deals.</p> : (
              <ul className="items">
                {deals.map((d) => (
                  <li key={d.id} className="item">
                    <div className="item-head">
                      <Link href={`/deals/${d.id}`}><strong>{d.title}</strong></Link>
                      <span className={`badge ${d.status}`}>{STATUS_LABELS[d.status]}</span>
                      <span className="spacer" /><span>{money(d.value, d.currency)}</span>
                    </div>
                    <div className="meta">{d.pipeline_name} · {d.stage_name}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <AccountPanel orgId={id} csOwnerId={org.cs_owner_id} users={users} />
          <OverviewBlock o={overview} />
          <FollowersBlock type="organization" id={id} followers={followers} me={me.id} users={humans} back={back} />
        </aside>

        <div className="record-main">
          <ComposerTabsBox key={tab ?? "note"} initial={tab} tabs={[
            { key: "note", label: "Nota", content: <NoteForm refs={refs} back={back} /> },
            { key: "activity", label: "Actividad", content: <ActivityForm refs={refs} back={back} users={humans} me={me.id} /> },
            {
              key: "call", label: "Llamada", content: (
                <>
                  {current.length > 0 && <p className="meta" style={{ margin: "0 0 6px" }}>Se registra en la empresa; si fue con alguien concreto, hazlo desde su ficha.</p>}
                  <CallForm refs={refs} back={back} />
                </>
              ),
            },
            {
              key: "email", label: "Correo", content: reachable.length === 0 ? <p className="muted">Ningún contacto actual tiene email.</p>
                : !sendingConn ? <p className="muted">Conecta tu correo en <Link href="/settings/mailbox">Ajustes → Correo</Link> para escribir desde aquí.</p> : (
                  <ActionForm action={sendContactEmailAction.bind(null, null, back)} submitLabel="Enviar" pendingLabel="Enviando…" resetOnSuccess>
                    <div className="grid-2">
                      <label className="field"><span className="label">Para</span>
                        <select name="person_id">{reachable.map((c) => <option key={c.person_id} value={c.person_id}>{c.full_name} · {c.email}</option>)}</select>
                      </label>
                      {openDeals.length > 0 && (
                        <label className="field"><span className="label">Asociar al deal</span>
                          <select name="deal_id" defaultValue="">
                            <option value="">Ninguno</option>
                            {openDeals.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                          </select>
                        </label>
                      )}
                    </div>
                    <EmailComposerFields dealId={openDeals[0]?.id ?? ""} templates={[]} trackDefault={settings?.email_tracking ?? true}
                                         trackAvailable={publicBase() !== null} signatureHtml={signatureHtml} />
                  </ActionForm>
                ),
            },
            { key: "files", label: `Archivos${files.length ? ` (${files.length})` : ""}`, content: <FilesPanel refs={refs} files={files} back={back} /> },
          ]} />

          <FocusBlock activities={activities} scheduled={emails.filter((m) => m.status === "scheduled")} pinned={notes.filter((n) => n.is_pinned)} back={back} />

          <section aria-label="Historia">
            <h2 className="section-title">Historia</h2>
            <HistoryFeed items={history} back={back} />
          </section>

          <section className="panel" id="fusionar" aria-label="Fusionar">
            <h2>Fusionar con otra empresa</h2>
            <p className="meta">Si es la misma empresa: se juntan contactos, deals, actividades, notas, correos y archivos. La que no se queda va a la papelera.</p>
            <ActionForm action={mergeWithAction.bind(null, "organization", id)} submitLabel="Fusionar" secondary>
              <EntityPicker name="other_id" type="organizations" label="Otra empresa" required />
              <label className="radio-row"><input type="radio" name="keep" value="this" defaultChecked /> Quedarse con esta ({org.name})</label>
              <label className="radio-row"><input type="radio" name="keep" value="other" /> Quedarse con la otra</label>
            </ActionForm>
          </section>
          <p className="meta">Alta: {dateTime(org.created_at)}</p>
        </div>
      </div>
    </main>
  );
}
