import Link from "next/link";
import { notFound } from "next/navigation";
import { trashAction } from "@/app/actions/trash";
import { changeCompanyAction } from "@/app/actions/records";
import { changeOwnerAction, enrollPersonAction, mergeWithAction, sendContactEmailAction } from "@/app/actions/contact";
import { stopEnrollmentAction } from "@/app/actions/sequences";
import { getPerson, personContactInfo } from "@/lib/persons";
import { listDeals } from "@/lib/deals";
import { leadsOfPerson } from "@/lib/leads";
import { listActivitiesFor } from "@/lib/activities";
import { listNotesFor } from "@/lib/notes";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { timeline } from "@/lib/events";
import { listUsers } from "@/lib/users";
import { listEmails, listTemplates } from "@/lib/emails";
import { listFiles } from "@/lib/files";
import { listFollowers } from "@/lib/followers";
import { listTags, overviewFor, tagsOf } from "@/lib/contact-workspace";
import { buildHistory } from "@/lib/history";
import { listPersonEnrollments, listSequences } from "@/lib/sequences";
import { connectionOf, senderFor } from "@/lib/mailbox";
import { signatureFor, signaturePreview } from "@/lib/signatures";
import { mergeContext } from "@/lib/merge-context";
import { mergeTemplate } from "@/lib/merge";
import { htmlToText } from "@/lib/email-html";
import { publicBase } from "@/lib/email-track";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { date, dateTime, money, STATUS_LABELS } from "@/lib/format";
import { isId } from "@/lib/validation";
import { ActionForm } from "@/components/ActionForm";
import { CustomFieldValues } from "@/components/CustomFieldValues";
import { EntityPicker } from "@/components/EntityPicker";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { EmailComposerFields } from "@/components/deal/DealClient";
import { ComposerTabsBox } from "@/components/record/Tabs";
import { HistoryFeed } from "@/components/record/HistoryFeed";
import {
  ActivityForm, CallForm, FilesPanel, FocusBlock, FollowersBlock, NoteForm, OverviewBlock, TagsBlock,
} from "@/components/record/Blocks";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = isId(id) ? await getPerson(id) : null;
  return { title: p?.full_name ?? "Contacto" };
}

const ENROLL_STATUS: Record<string, string> = { active: "En marcha", paused: "En pausa", completed: "Terminada", stopped: "Parada", failed: "Con error" };
const digits = (phone: string) => phone.replace(/[^\d+]/g, "");

export default async function PersonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  if (!isId(id)) notFound();
  const me = await requireUser();
  const person = await getPerson(id);
  if (!person) notFound();
  const back = `/persons/${id}`;

  const [info, deals, leads, activities, notes, defs, users, emails, files, followers, tags, allTags, overview, enrollments, sequences, templates] = await Promise.all([
    personContactInfo(id), listDeals({ personId: id }), leadsOfPerson(id), listActivitiesFor({ personId: id }),
    listNotesFor({ personId: id }), listFieldDefinitions("person", true), listUsers(), listEmails({ personId: id }),
    listFiles({ person_id: id }), listFollowers("person", id), tagsOf("person", id), listTags(), overviewFor({ personId: id }),
    listPersonEnrollments(id), listSequences(), listTemplates(me.id),
  ]);
  const events = await timeline(sql, [{ type: "person", id }, ...leads.map((l) => ({ type: "lead" as const, id: l.id }))], 60);
  const current = info.companies.filter((c) => c.status === "current");
  const humans = users.filter((u) => u.kind === "human");
  const openDeals = deals.filter((d) => d.status === "open");
  const email = info.emails[0]?.email ?? null;
  const phone = info.phones[0]?.phone ?? null;

  // Correo desde la ficha: sale de tu buzón (o del de su responsable), con tu firma.
  const myConn = await connectionOf(me.id);
  const sendingConn = myConn?.status === "active" ? myConn : await senderFor(person.owner_id);
  const signatureHtml = sendingConn ? signaturePreview(await signatureFor(sendingConn), sendingConn) : "";
  const vars = await mergeContext({ personId: id, dealId: openDeals[0]?.id ?? null, senderId: sendingConn?.user_id ?? me.id });
  const composerTemplates = templates.map((t) => ({
    id: t.id, name: t.name, subject: mergeTemplate(t.subject, { ...vars, huecos: "{huecos}" }).text,
    body: mergeTemplate(t.format === "html" ? htmlToText(t.body) : t.body, { ...vars, huecos: "{huecos}" }).text,
  }));
  const [settings] = await sql<{ email_tracking: boolean }[]>`SELECT email_tracking FROM app_settings LIMIT 1`;

  const history = buildHistory({ notes, activities, emails, files, events, showDeal: true });
  const pinned = notes.filter((n) => n.is_pinned);
  const scheduled = emails.filter((m) => m.status === "scheduled");
  const refs = { person_id: id, ...(current[0] ? { organization_id: current[0].organization_id } : {}) };
  const activeSequences = sequences.filter((s) => s.is_active && s.steps > 0);

  return (
    <main className="page record-page">
      <div className="crumbs"><Link href="/persons">Contactos</Link></div>
      <header className="record-head">
        <div className="title-with-avatar">
          <Avatar name={person.full_name} size="lg" />
          <div>
            <h1>{person.full_name}</h1>
            <div className="meta">
              {current[0] ? <>{current[0].job_title ? `${current[0].job_title} · ` : ""}<Link href={`/organizations/${current[0].organization_id}`}>{current[0].organization_name}</Link></> : "Sin empresa"}
              {person.unsubscribed_at && <> · <span className="badge lost">Dado de baja</span></>}
            </div>
            <TagsBlock entity="person" id={id} tags={tags} all={allTags} back={back} />
          </div>
        </div>
        <span className="spacer" />
        <nav className="quick-actions" aria-label="Acciones rápidas">
          {email && <Link className="btn secondary" href={`${back}?tab=email#compositor`}><Icon name="mail" />Correo</Link>}
          {phone && <a className="btn secondary" href={`tel:${digits(phone)}`}><Icon name="send" />Llamar</a>}
          <Link className="btn secondary" href={`${back}?tab=call#compositor`}>Registrar llamada</Link>
          {phone && <a className="btn secondary" href={`https://wa.me/${digits(phone).replace(/^\+/, "")}`} target="_blank" rel="noreferrer">WhatsApp</a>}
          {person.linkedin_url && <a className="btn secondary" href={person.linkedin_url} target="_blank" rel="noreferrer">LinkedIn</a>}
          <Link href={`/deals/new?person=${id}${current[0] ? `&organization=${current[0].organization_id}` : ""}`} className="btn"><Icon name="plus" />Nuevo deal</Link>
          <details className="menu-wrap more-menu">
            <summary className="btn secondary" aria-label="Más acciones">···</summary>
            <div className="dropdown">
              <Link href={`/persons/${id}/edit`}>Editar</Link>
              <a href={`/api/persons/${id}/vcard`}>Descargar vCard</a>
              <a href={`/api/export/persons?q=${encodeURIComponent(email ?? person.full_name)}`}>Exportar (CSV)</a>
              <a href="#fusionar">Fusionar con otro contacto</a>
              <div className="dropdown-sep" />
              <ActionForm action={trashAction.bind(null, "person", id)} submitLabel="Borrar contacto" pendingLabel="…" secondary className="form inline" />
            </div>
          </details>
        </nav>
      </header>

      <div className="record-layout">
        <aside className="record-side">
          <section className="side-section" aria-label="Datos de contacto">
            <h3>Datos</h3>
            <dl className="dl">
              <div className="dl-row"><dt>Email</dt><dd>{info.emails.length ? info.emails.map((e) => (
                <div key={e.id}><a href={`mailto:${e.email}`}>{e.email}</a>{e.is_primary && info.emails.length > 1 && <span className="meta"> · principal</span>}</div>
              )) : "—"}</dd></div>
              <div className="dl-row"><dt>Teléfono</dt><dd>{info.phones.length ? info.phones.map((p) => <div key={p.id}><a href={`tel:${digits(p.phone)}`}>{p.phone}</a></div>) : "—"}</dd></div>
              <div className="dl-row"><dt>LinkedIn</dt><dd>{person.linkedin_url ? <a href={person.linkedin_url} target="_blank" rel="noreferrer">Perfil</a> : "—"}</dd></div>
              <div className="dl-row"><dt>RGPD</dt><dd>{person.unsubscribed_at ? <span className="badge lost">Dado de baja</span>
                : person.marketing_consent ? <span className="badge won">Acepta comunicaciones</span> : <span className="badge">Sin consentimiento</span>}</dd></div>
              <div className="dl-row"><dt>Responsable</dt><dd>
                <ActionForm action={changeOwnerAction.bind(null, "person", id, back)} submitLabel="Cambiar" secondary className="form inline owner-form">
                  <select name="owner_id" defaultValue={person.owner_id ?? ""} aria-label="Responsable">
                    <option value="">Sin responsable</option>
                    {humans.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </ActionForm>
              </dd></div>
              <CustomFieldValues defs={defs} values={person.custom} users={users} />
            </dl>
            <Link href={`/persons/${id}/edit`} className="meta">Editar datos</Link>
          </section>

          <section className="side-section" aria-label="Empresas">
            <h3>Empresas</h3>
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
              <summary className="meta">Cambio de empresa</summary>
              <p className="meta">La relación actual pasa a «antigua» y se conserva todo su historial.</p>
              <ActionForm action={changeCompanyAction.bind(null, id)} submitLabel="Guardar" resetOnSuccess>
                <EntityPicker name="organization_id" type="organizations" label="Nueva empresa" />
                <label className="field"><span className="label">Cargo</span><input name="job_title" /></label>
                <label className="checkbox"><input type="checkbox" name="left_previous" defaultChecked /> Ha dejado su empresa actual</label>
              </ActionForm>
            </details>
          </section>

          <section className="side-section" aria-label="Deals">
            <div className="side-head"><h3>Deals <span className="muted">{deals.length}</span></h3>
              <Link className="meta" href={`/deals/new?person=${id}${current[0] ? `&organization=${current[0].organization_id}` : ""}`}>+ Deal</Link></div>
            {deals.length === 0 ? <p className="muted">No participa en ningún deal.</p> : (
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

          {leads.length > 0 && (
            <section className="side-section" aria-label="Recorrido como lead">
              <h3>Recorrido como lead</h3>
              <ul className="items">
                {leads.map((l) => (
                  <li key={l.id} className="item">
                    <Link href={`/leads/${l.id}`}>{l.source_detail ?? l.source ?? l.title}</Link>
                    <div className="meta"><span className={`badge ${l.status}`}>{STATUS_LABELS[l.status]}</span> {date(l.created_at)}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="side-section" aria-label="Secuencias">
            <h3>Secuencias</h3>
            {enrollments.length === 0 && <p className="muted" style={{ margin: 0 }}>No está en ninguna.</p>}
            <ul className="items">
              {enrollments.map((e) => (
                <li key={e.id} className="item">
                  <Link href={`/sequences/${e.sequence_id}`}>{e.sequence_name}</Link>
                  <div className="meta">{ENROLL_STATUS[e.status]} · paso {Math.min(e.next_step + 1, e.steps)} de {e.steps}{e.stopped_reason ? ` · ${e.stopped_reason}` : ""}</div>
                  {(e.status === "active" || e.status === "paused") && (
                    <form action={stopEnrollmentAction.bind(null, e.id, back)}><button type="submit" className="link-btn meta">Parar</button></form>
                  )}
                </li>
              ))}
            </ul>
            {activeSequences.length > 0 && email && !person.unsubscribed_at && (
              <details>
                <summary className="meta">+ Añadir a una secuencia</summary>
                <ActionForm action={enrollPersonAction.bind(null, id, back)} submitLabel="Añadir" secondary className="form inline">
                  <select name="sequence_id" aria-label="Secuencia">{activeSequences.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.steps} pasos)</option>)}</select>
                </ActionForm>
              </details>
            )}
          </section>

          <OverviewBlock o={overview} />
          <FollowersBlock type="person" id={id} followers={followers} me={me.id} users={humans} back={back} />
        </aside>

        <div className="record-main">
          <ComposerTabsBox key={tab ?? "note"} initial={tab} tabs={[
            { key: "note", label: "Nota", content: <NoteForm refs={refs} back={back} /> },
            { key: "activity", label: "Actividad", content: <ActivityForm refs={refs} back={back} users={humans} me={me.id} /> },
            { key: "call", label: "Llamada", content: <CallForm refs={refs} back={back} phone={phone} /> },
            {
              key: "email", label: "Correo", content: !email ? <p className="muted">Este contacto no tiene email.</p>
                : !sendingConn ? <p className="muted">Conecta tu correo en <Link href="/settings/mailbox">Ajustes → Correo</Link> para escribirle desde aquí.</p> : (
                  <ActionForm action={sendContactEmailAction.bind(null, id, back)} submitLabel={`Enviar a ${email}`} pendingLabel="Enviando…" resetOnSuccess>
                    {openDeals.length > 0 && (
                      <label className="field"><span className="label">Asociar al deal</span>
                        <select name="deal_id" defaultValue={openDeals[0].id}>
                          <option value="">Ninguno</option>
                          {openDeals.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                        </select>
                      </label>
                    )}
                    <EmailComposerFields dealId={openDeals[0]?.id ?? ""} templates={composerTemplates}
                                         trackDefault={settings?.email_tracking ?? true} trackAvailable={publicBase() !== null} signatureHtml={signatureHtml} />
                  </ActionForm>
                ),
            },
            { key: "files", label: `Archivos${files.length ? ` (${files.length})` : ""}`, content: <FilesPanel refs={{ person_id: id }} files={files} back={back} /> },
          ]} />

          <FocusBlock activities={activities} scheduled={scheduled} pinned={pinned} back={back} />

          <section aria-label="Historia">
            <h2 className="section-title">Historia</h2>
            <HistoryFeed items={history} back={back} />
          </section>

          <section className="panel" id="fusionar" aria-label="Fusionar">
            <h2>Fusionar con otro contacto</h2>
            <p className="meta">Si es la misma persona: se juntan deals, actividades, notas, correos, archivos, emails y teléfonos. El que no se queda va a la papelera.</p>
            <ActionForm action={mergeWithAction.bind(null, "person", id)} submitLabel="Fusionar" secondary>
              <EntityPicker name="other_id" type="persons" label="Otro contacto" required />
              <label className="radio-row"><input type="radio" name="keep" value="this" defaultChecked /> Quedarse con este ({person.full_name})</label>
              <label className="radio-row"><input type="radio" name="keep" value="other" /> Quedarse con el otro</label>
            </ActionForm>
          </section>
          <p className="meta">Alta: {dateTime(person.created_at)}</p>
        </div>
      </div>
    </main>
  );
}
