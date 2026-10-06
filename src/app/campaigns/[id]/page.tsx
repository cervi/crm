import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { CAMPAIGN_STATUS, CONTACT_STATUS, REPLY_LABEL, campaignStats, getCampaign, listContacts, type ContactStatus, type ReplyClass } from "@/lib/campaigns";
import { listSequences } from "@/lib/sequences";
import { listOutboundMailboxes, warmupLimit } from "@/lib/mailbox";
import { listPipelines } from "@/lib/pipelines";
import { listUsers } from "@/lib/users";
import { ActionForm } from "@/components/ActionForm";
import { CampaignFields } from "@/components/CampaignFields";
import {
  addCrmContactsAction, addCsvContactsAction, approveContactsAction, removeContactAction, saveCampaignAction, setCampaignStatusAction,
} from "@/app/actions/outbound";
import { date, money } from "@/lib/format";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaña" };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ status?: string }> }) {
  await requireUser();
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  if (!isId(id)) notFound();
  const c = await getCampaign(id);
  if (!c) notFound();
  const status = sp.status && sp.status in CONTACT_STATUS ? sp.status : null;
  const [stats, contacts, ready, sequences, mailboxes, pipelines, users] = await Promise.all([
    campaignStats([id]).then((m) => m.get(id)!), listContacts(id, status), listContacts(id, "ready", 200),
    listSequences(), listOutboundMailboxes(), listPipelines(), listUsers(),
  ]);
  const funnel = [
    { label: "Contactos", value: stats.contacts, sub: `${stats.invalid} no válidos` },
    { label: "Enviados", value: stats.sent, sub: `${stats.enrolled} en la secuencia` },
    { label: "Abiertos", value: pct(stats.opened, stats.sent), sub: `${stats.clicked} con clics` },
    { label: "Respuestas", value: stats.replied, sub: `${stats.unsubscribed} bajas · ${stats.bounced} rebotes` },
    { label: "Interesados", value: stats.interested, sub: `${stats.meetings} con reunión` },
    { label: "Deals", value: stats.deals, sub: stats.won ? `${stats.won} ganados · ${money(stats.won_value)}` : "ninguno ganado aún" },
  ];

  return (
    <main className="page">
      <div className="crumbs"><Link href="/campaigns">Campañas</Link></div>
      <div className="page-head">
        <div>
          <h1>{c.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            <span className={`badge ${c.status === "active" ? "won" : ""}`}>{CAMPAIGN_STATUS[c.status]}</span>{" "}
            {c.sequence_name ? `Secuencia «${c.sequence_name}»` : "Sin secuencia"} · {c.mailbox_ids.length} buzón{c.mailbox_ids.length === 1 ? "" : "es"} ·
            de {c.send_from}:00 a {c.send_to}:00
          </p>
        </div>
        <div className="head-actions">
          {c.status !== "active" && c.status !== "finished" && <ActionForm action={setCampaignStatusAction.bind(null, id, "active")} submitLabel="Poner en marcha" pendingLabel="…" good className="form inline" />}
          {c.status === "active" && <ActionForm action={setCampaignStatusAction.bind(null, id, "paused")} submitLabel="Pausar" pendingLabel="…" secondary className="form inline" />}
          {c.status !== "finished" && <ActionForm action={setCampaignStatusAction.bind(null, id, "finished")} submitLabel="Terminar" pendingLabel="…" secondary className="form inline" />}
        </div>
      </div>

      <section className="today-stats campaign-funnel" aria-label="Resultados">
        {funnel.map((f) => (
          <div key={f.label} className="today-stat"><span className="label">{f.label}</span><strong>{f.value}</strong><span className="meta">{f.sub}</span></div>
        ))}
      </section>

      {ready.length > 0 && (
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
          <ActionForm action={approveContactsAction.bind(null, id)} submitLabel={`Aprobar todos (${ready.length})`} pendingLabel="Aprobando…" secondary className="form inline">
            <input type="hidden" name="all" value="1" />
          </ActionForm>
        </section>
      )}

      <div className="split">
        <section className="panel" aria-label="Añadir contactos">
          <h2>Añadir contactos</h2>
          <details open={stats.contacts === 0}>
            <summary className="meta">Desde un CSV (de un proveedor de datos o de una IA)</summary>
            <ActionForm action={addCsvContactsAction.bind(null, id)} submitLabel="Añadir" pendingLabel="Añadiendo…" secondary>
              <label className="field"><span className="label">Archivo CSV</span><input type="file" name="file" accept=".csv,text/csv,text/plain" /></label>
              <label className="field"><span className="label">…o pégalo aquí</span>
                <textarea name="csv" rows={4} placeholder={"email;nombre;empresa;cargo\nana@empresa.es;Ana Gil;Empresa S.L.;Directora comercial"} /></label>
            </ActionForm>
          </details>
          <details>
            <summary className="meta">Desde el CRM (contactos sin deals abiertos ni ganados)</summary>
            <ActionForm action={addCrmContactsAction.bind(null, id)} submitLabel="Añadir los que encajen" pendingLabel="Buscando…" secondary>
              <div className="grid-2">
                <label className="field"><span className="label">Sector contiene</span><input name="industry" defaultValue={c.target.sector ?? ""} /></label>
                <label className="field"><span className="label">País</span><input name="country" defaultValue={c.target.country ?? ""} /></label>
                <label className="field"><span className="label">Cargo contiene</span><input name="job_title" /></label>
                <label className="field"><span className="label">Empleados (mín.–máx.)</span>
                  <span style={{ display: "flex", gap: 6 }}><input name="min_employees" type="number" min={0} /><input name="max_employees" type="number" min={0} /></span></label>
              </div>
            </ActionForm>
          </details>
          <p className="meta">También por la API (<code>POST /api/v1/campaigns/{id}/contacts</code>) o pidiéndoselo a un agente conectado por MCP.</p>
        </section>
        <section className="panel" aria-label="Ajustes de la campaña">
          <details>
            <summary><h2 style={{ display: "inline" }}>Ajustes</h2></summary>
            <ActionForm action={saveCampaignAction.bind(null, id)} submitLabel="Guardar" secondary>
              <CampaignFields c={c} sequences={sequences.filter((s) => s.is_active && s.steps > 0)}
                              mailboxes={mailboxes.map((m) => ({ id: m.id, email: m.email, paused: m.paused, limit: warmupLimit(m) }))}
                              pipelines={pipelines} users={users.filter((u) => u.kind === "human")} />
            </ActionForm>
          </details>
        </section>
      </div>

      <h2 className="section-title">Contactos <span className="muted">{contacts.length}</span></h2>
      <nav className="chips" aria-label="Filtrar por estado">
        <Link href={`/campaigns/${id}`} aria-current={!status ? "page" : undefined}>Todos</Link>
        {(["pending", "ready", "enrolled", "interested", "later", "not_interested", "unsubscribed", "bounced", "invalid", "completed"] as ContactStatus[]).map((s) => (
          <Link key={s} href={`/campaigns/${id}?status=${s}`} aria-current={status === s ? "page" : undefined}>{CONTACT_STATUS[s]}</Link>
        ))}
      </nav>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Contacto</th><th>Empresa</th><th>Estado</th><th>Respuesta</th><th>Buzón</th><th /></tr></thead>
          <tbody>
            {contacts.length === 0 && <tr><td colSpan={6} className="empty-row">Sin contactos{status ? " en este estado" : ""}.</td></tr>}
            {contacts.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/persons/${r.person_id}`}>{r.full_name}</Link><div className="meta">{r.email}{r.job_title ? ` · ${r.job_title}` : ""}</div></td>
                <td>{r.organization ?? "—"}</td>
                <td><span className={`badge ${r.status === "interested" ? "won" : ["invalid", "bounced", "unsubscribed", "not_interested"].includes(r.status) ? "lost" : ""}`}
                          title={r.verify_note ?? undefined}>{CONTACT_STATUS[r.status]}</span>
                  {r.retake_at && <div className="meta">Retomar el {date(r.retake_at)}</div>}</td>
                <td>{r.reply_class ? <><strong>{REPLY_LABEL[r.reply_class as ReplyClass] ?? r.reply_class}</strong>{r.reply_summary && <div className="meta">{r.reply_summary}</div>}</> : "—"}
                  {r.deal_id && <div><Link href={`/deals/${r.deal_id}`}>Ver deal</Link></div>}</td>
                <td className="meta">{r.mailbox_email ?? "—"}</td>
                <td><form action={removeContactAction.bind(null, id, r.id)}><button type="submit" className="link-btn meta">Quitar</button></form></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
