import Link from "next/link";
import { ConfirmButton } from "@/components/ConfirmButton";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  CAMPAIGN_STATUS, CONTACT_STATUS, REPLY_LABEL, campaignAnalytics, campaignEmails, campaignStats, getCampaign, listContacts,
  type ContactStatus, type ReplyClass,
} from "@/lib/campaigns";
import { listSequences } from "@/lib/sequences";
import { listOutboundMailboxes, warmupLimit } from "@/lib/mailbox";
import { listPipelines } from "@/lib/pipelines";
import { listUsers } from "@/lib/users";
import { ActionForm } from "@/components/ActionForm";
import { CampaignFields } from "@/components/CampaignFields";
import { ChartCard } from "@/components/charts/ChartCard";
import { Funnel } from "@/components/charts/Funnel";
import { HBars, Lines } from "@/components/charts/SalesCharts";
import {
  addCrmContactsAction, addCsvContactsAction, approveContactsAction, removeContactAction, saveCampaignAction, setCampaignStatusAction,
} from "@/app/actions/outbound";
import { date, dateTime, money } from "@/lib/format";
import { isId } from "@/lib/validation";
import { removeExampleAction } from "@/app/actions/sequences";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaña" };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");
const TABS = [["resumen", "Resumen"], ["contactos", "Contactos"], ["correos", "Correos"], ["ajustes", "Ajustes"]] as const;
type Tab = (typeof TABS)[number][0];
const dayShort = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });
const dayLong = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" });

export default async function CampaignPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; status?: string; ver?: string; filtro?: string }>;
}) {
  const me = await requireUser();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!isId(id)) notFound();
  const c = await getCampaign(id);
  if (!c) notFound();
  const tab: Tab = (TABS.find(([k]) => k === sp.tab)?.[0] ?? (sp.status ? "contactos" : "resumen")) as Tab;
  const status = sp.status && sp.status in CONTACT_STATUS ? sp.status : null;
  const canEdit = me.role !== "viewer";
  const stats = (await campaignStats([id])).get(id)!;
  const base = `/campaigns/${id}`;

  // Tarjetas de arriba: cada una lleva a donde se ve el detalle.
  const kpis = [
    { label: "Contactos", value: stats.contacts, sub: `${stats.invalid} no válidos`, href: `${base}?tab=contactos` },
    { label: "Enviados", value: stats.sent, sub: `${stats.enrolled} en la secuencia`, href: `${base}?tab=correos` },
    { label: "Abiertos", value: pct(stats.opened, stats.sent), sub: `${stats.clicked} con clics`, href: `${base}?tab=correos&filtro=abiertos` },
    { label: "Respuestas", value: stats.replied, sub: `${stats.unsubscribed} bajas · ${stats.bounced} rebotes`, href: `${base}?tab=correos&ver=respuestas` },
    { label: "Interesados", value: stats.interested, sub: `${stats.meetings} con reunión`, href: `${base}?tab=contactos&status=interested` },
    { label: "Deals", value: stats.deals, sub: stats.won ? `${stats.won} ganados · ${money(stats.won_value)}` : "ninguno ganado aún", href: `${base}?tab=contactos&status=interested` },
  ];

  return (
    <main className="page">
      <div className="crumbs"><Link href="/campaigns">Campañas</Link></div>
      <div className="page-head">
        <div>
          <h1>{c.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {c.example ? <span className="badge">Ejemplo · no envía</span> : <span className={`badge ${c.status === "active" ? "won" : ""}`}>{CAMPAIGN_STATUS[c.status]}</span>}{" "}
            {c.sequence_name ? <>Secuencia <Link href={`/sequences/${c.sequence_id}`}>«{c.sequence_name}»</Link></> : "Sin secuencia"} · de {c.send_from}:00 a {c.send_to}:00
          </p>
        </div>
        {!c.example && canEdit && <div className="head-actions">
          {c.status !== "active" && c.status !== "finished" && <ActionForm action={setCampaignStatusAction.bind(null, id, "active")} submitLabel="Poner en marcha" pendingLabel="…" good className="form inline" />}
          {c.status === "active" && <ActionForm action={setCampaignStatusAction.bind(null, id, "paused")} submitLabel="Pausar" pendingLabel="…" secondary className="form inline" />}
          {c.status !== "finished" && <ActionForm action={setCampaignStatusAction.bind(null, id, "finished")} submitLabel="Terminar" pendingLabel="…" secondary className="form inline"
                                                  confirm="Se para la secuencia para todos los contactos de la campaña." />}
        </div>}
      </div>

      {c.example && (
        <div className="callout example-offer">
          <div><strong>Esto es una campaña de ejemplo con contactos ficticios: no envía nada.</strong>
            <span className="meta"> Así trabaja una campaña: cargas una lista, se verifica cada correo, la IA escribe una primera línea para cada uno y tú la apruebas;
              los aprobados entran en la secuencia, y cada respuesta se clasifica sola (interesado → deal y tarea para ti; «más adelante» → tarea para retomar; baja → no se le escribe más).
              Para usarla con tus contactos, crea una campaña nueva en <Link href="/campaigns">Campañas</Link>.</span></div>
          {canEdit && c.sequence_id && (
            <ActionForm action={removeExampleAction.bind(null, c.sequence_id, "campaigns")} submitLabel="Borrar el ejemplo" pendingLabel="Borrando…" secondary className="form inline"
                        confirm="Se borran la campaña, su secuencia y sus contactos, empresas, deal, correos y tareas de muestra." />
          )}
        </div>
      )}

      <nav className="tabs" aria-label="Secciones de la campaña">
        {TABS.map(([k, l]) => (
          <Link key={k} href={`${base}?tab=${k}`} aria-current={tab === k ? "page" : undefined}>
            {l}
            {k === "contactos" && <span className={`count${stats.ready ? "" : " neutral"}`} title={stats.ready ? `${stats.ready} para aprobar` : undefined}>{stats.ready ? `${stats.ready} para aprobar` : stats.contacts}</span>}
            {k === "correos" && stats.sent > 0 && <span className="count neutral">{stats.sent}</span>}
          </Link>
        ))}
      </nav>

      {tab === "resumen" && <Summary id={id} kpis={kpis} ready={stats.ready} />}
      {tab === "contactos" && <Contacts id={id} status={status} example={c.example} canEdit={canEdit} target={c.target} isAdmin={me.role === "admin"} />}
      {tab === "correos" && <Emails id={id} view={sp.ver === "respuestas" ? "replies" : "sent"} filter={sp.filtro ?? null} />}
      {tab === "ajustes" && <Settings c={c} canEdit={canEdit} />}
    </main>
  );
}

async function Summary({ id, kpis, ready }: { id: string; kpis: { label: string; value: string | number; sub: string; href: string }[]; ready: number }) {
  const a = await campaignAnalytics(id);
  const base = `/campaigns/${id}`;
  const f = Object.fromEntries(a.funnel.map((s) => [s.key, s.value]));
  // Lectura en claro del embudo: la mayor caída y lo que espera.
  const insights: string[] = [];
  let worst: { from: string; to: string; rate: number } | null = null;
  a.funnel.forEach((s, i) => {
    const prev = a.funnel[i - 1];
    if (!prev || prev.value === 0) return;
    const rate = s.value / prev.value;
    if (!worst || rate < worst.rate) worst = { from: prev.label.toLowerCase(), to: s.label.toLowerCase(), rate };
  });
  const w = worst as { from: string; to: string; rate: number } | null;
  if (w && w.rate < 1) insights.push(`La mayor caída está de «${w.from}» a «${w.to}»: solo pasa el ${Math.round(w.rate * 100)} %.`);
  if (f.contacted) insights.push(`De cada 10 contactados, ${Math.round((f.replied / f.contacted) * 10)} responden y ${Math.round((f.interested / f.contacted) * 10)} muestran interés.`);
  if (ready) insights.push(`${ready} contacto${ready === 1 ? " espera" : "s esperan"} tu aprobación para entrar en la secuencia.`);
  const periods = a.daily.map((d) => {
    const dt = new Date(`${d.day}T12:00:00`);
    return { key: d.day, label: dayLong.format(dt), short: dayShort.format(dt) };
  });
  const replyRows = a.replies.map((r) => ({ label: REPLY_LABEL[r.cls as ReplyClass] ?? r.cls, value: r.n }));
  return (
    <>
      <section className="kpi-row" aria-label="Resultados">
        {kpis.map((k) => (
          <Link key={k.label} href={k.href} className="kpi kpi-link"><span className="meta">{k.label}</span><strong>{k.value}</strong><span className="meta">{k.sub}</span></Link>
        ))}
      </section>
      {ready > 0 && (
        <p className="callout">{ready} contacto{ready === 1 ? "" : "s"} con su primera línea personalizada esperan tu aprobación.{" "}
          <Link href={`${base}?tab=contactos&status=ready`}>Revisar y aprobar</Link></p>
      )}
      <div className="charts-grid">
        <ChartCard wide label="Embudo de la campaña" title="Embudo de la campaña" insights={insights}
                   info="Cuántos contactos llegan a cada fase, desde la lista hasta el deal ganado. Junto a cada flecha, qué parte de la fase anterior pasa a la siguiente. Pincha una fase para ver quiénes son.">
          <Funnel stages={a.funnel} onStage={{
            total: `${base}?tab=contactos`, verified: `${base}?tab=contactos`, contacted: `${base}?tab=correos`, opened: `${base}?tab=correos&filtro=abiertos`,
            replied: `${base}?tab=correos&ver=respuestas`, interested: `${base}?tab=contactos&status=interested`, deals: `${base}?tab=contactos&status=interested`,
          }} />
        </ChartCard>
        <ChartCard label="Actividad día a día" title="Actividad día a día"
                   info="Correos enviados, primeras aperturas y respuestas de cada día (sin contar los «fuera de la oficina»).">
          <Lines periods={periods} f="number" series={[
            { key: "sent", label: "Enviados", values: a.daily.map((d) => d.sent) },
            { key: "opened", label: "Abiertos", values: a.daily.map((d) => d.opened) },
            { key: "replied", label: "Respuestas", values: a.daily.map((d) => d.replied) },
          ]} />
          <details className="chart-data">
            <summary className="meta">Ver los datos</summary>
            <div className="table-wrap flat"><table>
              <thead><tr><th>Día</th><th className="num">Enviados</th><th className="num">Abiertos</th><th className="num">Respuestas</th></tr></thead>
              <tbody>{a.daily.filter((d) => d.sent || d.opened || d.replied).map((d, i) => (
                <tr key={d.day}><td>{periods[a.daily.indexOf(d)]?.label ?? d.day}</td><td className="num">{d.sent}</td><td className="num">{d.opened}</td><td className="num">{d.replied}</td></tr>
              ))}</tbody>
            </table></div>
          </details>
        </ChartCard>
        <ChartCard label="Respuestas por tipo" title="Respuestas por tipo"
                   info="Cómo se han clasificado las respuestas: interesado, más adelante, no interesado, baja o fuera de la oficina.">
          {replyRows.length ? <HBars rows={replyRows} f="number" /> : <p className="meta">Aún no ha respondido nadie.</p>}
          <p className="meta" style={{ margin: 0 }}><Link href={`${base}?tab=correos&ver=respuestas`}>Leer las respuestas</Link></p>
        </ChartCard>
      </div>
    </>
  );
}

async function Contacts({ id, status, example, canEdit, target, isAdmin }: {
  id: string; status: string | null; example: boolean; canEdit: boolean; target: { sector?: string; country?: string }; isAdmin: boolean;
}) {
  const [contacts, ready] = await Promise.all([listContacts(id, status), listContacts(id, "ready", 200)]);
  const base = `/campaigns/${id}`;
  return (
    <>
      {ready.length > 0 && canEdit && (!status || status === "ready") && (
        <section className="panel" aria-label="Para aprobar">
          <h2>Para aprobar <span className="muted">{ready.length}</span></h2>
          <p className="muted">La primera línea de cada correo ({"{gancho}"}). Corrige lo que quieras y aprueba: los aprobados entran en la secuencia en la próxima revisión.</p>
          <ActionForm action={approveContactsAction.bind(null, id)} submitLabel="Aprobar los marcados" pendingLabel="Aprobando…" good>
            <ul className="approve-list">
              {ready.map((r) => (
                <li key={r.id}>
                  <label className="checkbox"><input type="checkbox" name="contact" value={r.id} defaultChecked />
                    <strong>{r.full_name}</strong> <span className="meta">{[r.job_title, r.organization, r.email].filter(Boolean).join(" · ")}{r.verify_note ? ` · ${r.verify_note}` : ""}</span></label>
                  <textarea name={`line_${r.id}`} rows={2} defaultValue={r.personal_line ?? ""} placeholder="Sin línea personalizada (la IA no está configurada o no había datos)" aria-label={`Primera línea para ${r.full_name}`} />
                </li>
              ))}
            </ul>
          </ActionForm>
        </section>
      )}

      <nav className="chips" aria-label="Filtrar por estado">
        <Link href={`${base}?tab=contactos`} aria-current={!status ? "page" : undefined}>Todos</Link>
        {(["pending", "ready", "approved", "enrolled", "interested", "later", "not_interested", "unsubscribed", "bounced", "invalid", "completed"] as ContactStatus[]).map((s) => (
          <Link key={s} href={`${base}?tab=contactos&status=${s}`} aria-current={status === s ? "page" : undefined}>{CONTACT_STATUS[s]}</Link>
        ))}
      </nav>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Contacto</th><th>Empresa</th><th>Estado</th><th>Respuesta</th><th>Buzón</th>{canEdit && !example && <th><span className="sr-only">Acciones</span></th>}</tr></thead>
          <tbody>
            {contacts.length === 0 && <tr><td colSpan={6} className="empty-row">Sin contactos{status ? " en este estado" : ""}.</td></tr>}
            {contacts.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/persons/${r.person_id}`}>{r.full_name}</Link><div className="meta">{r.email}{r.job_title ? ` · ${r.job_title}` : ""}</div>
                  {r.personal_line && ["ready", "approved", "pending"].includes(r.status) && <div className="meta">«{r.personal_line}»</div>}</td>
                <td>{r.organization ?? "—"}</td>
                <td><span className={`badge ${r.status === "interested" ? "won" : ["invalid", "bounced", "unsubscribed", "not_interested"].includes(r.status) ? "lost" : ""}`}
                          title={r.verify_note ?? undefined}>{CONTACT_STATUS[r.status]}</span>
                  {r.status === "invalid" && r.verify_note && <div className="meta">{r.verify_note}</div>}
                  {r.retake_at && <div className="meta">Retomar el {date(r.retake_at)}</div>}</td>
                <td>{r.reply_class ? <><strong>{REPLY_LABEL[r.reply_class as ReplyClass] ?? r.reply_class}</strong>{r.reply_summary && <div className="meta">{r.reply_summary}</div>}</> : "—"}
                  {r.deal_id && <div><Link href={`/deals/${r.deal_id}`}>Ver deal</Link></div>}</td>
                <td className="meta">{r.mailbox_email ?? "—"}</td>
                {canEdit && !example && <td><form action={removeContactAction.bind(null, id, r.id)}><ConfirmButton label="Quitar" className="link-btn meta" confirm="Deja de recibir los correos de esta campaña." /></form></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && !example && (
        <section className="panel" aria-label="Añadir contactos" style={{ marginTop: 18 }}>
          <h2>Añadir contactos</h2>
          <p className="meta" style={{ marginTop: 0 }}>Desde un CSV (de un proveedor de datos o de una IA):</p>
          <ActionForm action={addCsvContactsAction.bind(null, id)} submitLabel="Añadir" pendingLabel="Añadiendo…" secondary>
            <label className="field"><span className="label">Archivo CSV</span><input type="file" name="file" accept=".csv,text/csv,text/plain" /></label>
            <label className="field"><span className="label">…o pégalo aquí</span>
              <textarea name="csv" rows={4} placeholder={"email;nombre;empresa;cargo\nana@empresa.es;Ana Gil;Empresa S.L.;Directora comercial"} /></label>
          </ActionForm>
          <details>
            <summary className="meta">Desde el CRM (contactos sin deals abiertos ni ganados)</summary>
            <ActionForm action={addCrmContactsAction.bind(null, id)} submitLabel="Añadir los que encajen" pendingLabel="Buscando…" secondary>
              <div className="grid-2">
                <label className="field"><span className="label">Sector contiene</span><input name="industry" defaultValue={target.sector ?? ""} /></label>
                <label className="field"><span className="label">País</span><input name="country" defaultValue={target.country ?? ""} /></label>
                <label className="field"><span className="label">Cargo contiene</span><input name="job_title" /></label>
                <label className="field"><span className="label">Empleados (mín.–máx.)</span>
                  <span style={{ display: "flex", gap: 6 }}><input name="min_employees" type="number" min={0} /><input name="max_employees" type="number" min={0} /></span></label>
              </div>
            </ActionForm>
          </details>
          {isAdmin && <p className="meta">También se pueden añadir desde otras herramientas (API: <code>POST /api/v1/campaigns/{id}/contacts</code>) o pidiéndoselo a un agente externo.</p>}
        </section>
      )}
    </>
  );
}

const SENT_FILTERS = [["", "Todos"], ["abiertos", "Abiertos"], ["sin_abrir", "Sin abrir"], ["clics", "Con clic"], ["respondidos", "Respondidos"], ["rebotados", "Rebotados"]] as const;

async function Emails({ id, view, filter }: { id: string; view: "sent" | "replies"; filter: string | null }) {
  const rows = await campaignEmails(id, view, filter);
  const base = `/campaigns/${id}?tab=correos`;
  return (
    <>
      <div className="filter-row">
        <nav className="chips" aria-label="Qué correos">
          <Link href={base} aria-current={view === "sent" ? "page" : undefined}>Enviados</Link>
          <Link href={`${base}&ver=respuestas`} aria-current={view === "replies" ? "page" : undefined}>Respuestas</Link>
        </nav>
        {view === "sent" && (
          <nav className="chips" aria-label="Filtrar">
            {SENT_FILTERS.map(([k, l]) => <Link key={k} href={k ? `${base}&filtro=${k}` : base} aria-current={(filter ?? "") === k ? "page" : undefined}>{l}</Link>)}
          </nav>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>{view === "sent"
            ? <tr><th>Para</th><th>Asunto</th><th>Enviado</th><th>Desde</th><th>Estado</th></tr>
            : <tr><th>De</th><th>Respuesta</th><th>Recibida</th><th>Tipo</th></tr>}</thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="empty-row">{view === "sent" ? "Ningún correo con este filtro." : "Aún no ha respondido nadie."}</td></tr>}
            {rows.map((m) => view === "sent" ? (
              <tr key={m.id}>
                <td>{m.person_id ? <Link href={`/persons/${m.person_id}`}>{m.person_name}</Link> : m.person_name}<div className="meta">{m.to}</div></td>
                <td><Link href={`/emails/${m.id}`}>{m.subject || "(sin asunto)"}</Link></td>
                <td className="nowrap">{dateTime(m.at)}</td>
                <td className="meta">{m.from ?? "—"}</td>
                <td>{m.bounced ? <span className="badge lost">Rebotó</span> : m.replied ? <span className="badge won">Respondió</span>
                  : m.opened ? <span className="badge open">Abierto{m.open_count > 1 ? ` ×${m.open_count}` : ""}</span> : <span className="badge">Entregado</span>}</td>
              </tr>
            ) : (
              <tr key={m.id}>
                <td>{m.person_id ? <Link href={`/persons/${m.person_id}`}>{m.person_name}</Link> : m.person_name}<div className="meta">{m.from}</div></td>
                <td><Link href={`/emails/${m.id}`}>{m.subject || "(sin asunto)"}</Link><div className="meta">{m.body}</div></td>
                <td className="nowrap">{dateTime(m.at)}</td>
                <td>{m.reply_class ? <span className={`badge ${m.reply_class === "interesado" ? "won" : m.reply_class === "baja" ? "lost" : ""}`}>
                  {REPLY_LABEL[(m.reply_class === "ooo" ? "fuera_oficina" : m.reply_class) as ReplyClass] ?? m.reply_class}</span> : <span className="meta">Sin clasificar</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

async function Settings({ c, canEdit }: { c: NonNullable<Awaited<ReturnType<typeof getCampaign>>>; canEdit: boolean }) {
  const [sequences, mailboxes, pipelines, users] = await Promise.all([listSequences(), listOutboundMailboxes(), listPipelines(), listUsers()]);
  const fields = (
    <CampaignFields c={c} sequences={sequences.filter((s) => (s.is_active && s.steps > 0) || s.id === c.sequence_id)}
                    mailboxes={mailboxes.map((m) => ({ id: m.id, email: m.email, paused: m.paused, limit: warmupLimit(m) }))}
                    pipelines={pipelines} users={users.filter((u) => u.kind === "human")} />
  );
  return (
    <section className="panel" aria-label="Ajustes de la campaña">
      <h2>Ajustes</h2>
      {c.example || !canEdit ? (
        <>
          <p className="meta" style={{ marginTop: 0 }}>{c.example ? "Así está configurada la campaña de ejemplo. No se puede cambiar: crea una campaña nueva para usar tus contactos." : "Solo lectura."}</p>
          <fieldset disabled className="form readonly-fields">{fields}</fieldset>
        </>
      ) : (
        <ActionForm action={saveCampaignAction.bind(null, c.id)} submitLabel="Guardar ajustes">{fields}</ActionForm>
      )}
    </section>
  );
}
