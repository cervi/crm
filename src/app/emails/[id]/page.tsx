import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { getSentEmail } from "@/lib/emails";
import { DEVICE_LABEL } from "@/lib/reader";
import { isId } from "@/lib/validation";
import { attachmentsFor } from "@/lib/attachments";
import { fileSize } from "@/lib/files";
import { sql } from "@/lib/db";
import { duration } from "@/lib/library";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Correo enviado" };

/** Un correo enviado con cada apertura y cada clic (fecha, dispositivo, programa y lugar aproximado). */
type Ctx = {
  sequence_id: string | null; sequence_name: string | null; step: number | null; campaign_id: string | null; campaign_name: string | null; bounced: boolean;
  organization_name: string | null;
};

/** Qué rodea al correo: secuencia y paso, campaña, empresa del contacto. */
async function contextOf(id: string): Promise<Ctx> {
  const [c] = await sql<Ctx[]>`
    SELECT se.sequence_id, sq.name AS sequence_name, st.position AS step, e.campaign_id, cp.name AS campaign_name, coalesce(e.bounced, false) AS bounced,
           (SELECT o.name FROM person_organizations po JOIN organizations o ON o.id = po.organization_id
            WHERE po.person_id = e.person_id AND po.status = 'current' ORDER BY po.created_at DESC LIMIT 1) AS organization_name
    FROM emails e
    LEFT JOIN sequence_enrollments se ON se.id = e.enrollment_id LEFT JOIN sequences sq ON sq.id = se.sequence_id
    LEFT JOIN sequence_steps st ON st.id = e.sequence_step_id LEFT JOIN campaigns cp ON cp.id = e.campaign_id
    WHERE e.id = ${id}`;
  return c;
}

function ContextList({ c, person, personId, dealId, dealTitle }: { c: Ctx; person: string | null; personId: string | null; dealId: string | null; dealTitle: string | null }) {
  const rows: [string, React.ReactNode][] = [];
  if (person) rows.push(["Contacto", <>{personId ? <Link href={`/persons/${personId}`}>{person}</Link> : person}{c.organization_name && <div className="meta">{c.organization_name}</div>}</>]);
  if (dealId) rows.push(["Deal", <Link href={`/deals/${dealId}`}>{dealTitle}</Link>]);
  if (c.sequence_id) rows.push(["Secuencia", <><Link href={`/sequences/${c.sequence_id}`}>{c.sequence_name}</Link>{c.step && <div className="meta">Paso {c.step}</div>}</>]);
  if (c.campaign_id) rows.push(["Campaña", <Link href={`/campaigns/${c.campaign_id}`}>{c.campaign_name}</Link>]);
  if (!rows.length) return null;
  return (
    <section className="mail-card" aria-label="Contexto">
      <h2>Contexto</h2>
      <dl className="mail-dl">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </section>
  );
}

const REPLY_TEXT: Record<string, string> = {
  interesado: "Interesado", mas_adelante: "Más adelante", no_interesado: "No interesado", baja: "Pide la baja", ooo: "Fuera de la oficina", fuera_oficina: "Fuera de la oficina", otro: "Otra respuesta",
};
const replyTone = (c: string | null) => (c === "interesado" ? "won" : c === "baja" || c === "no_interesado" ? "lost" : "");

export default async function SentEmailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const e = isId(id) ? await getSentEmail(id) : null;
  if (!e) return <ReceivedEmail id={id} />;
  const human = e.opens.filter((o) => !o.automatic);
  const auto = e.opens.length - human.length;
  const days = new Set(human.map((o) => new Date(o.at).toDateString())).size;
  const [atts, docs, ctx, [reply]] = await Promise.all([
    attachmentsFor([e.id]).then((m) => m.get(e.id) ?? []),
    // Documentos de la biblioteca enviados como enlace a este contacto (y si los ha abierto).
    e.person_id ? sql<{ name: string; views: number; seconds: number; last: Date | null }[]>`
      SELECT coalesce(i.name, f.name) AS name, l.view_count AS views, l.seconds, l.last_viewed_at AS last
      FROM doc_links l LEFT JOIN library_items i ON i.id = l.library_id LEFT JOIN files f ON f.id = l.file_id
      WHERE l.person_id = ${e.person_id} AND l.created_at BETWEEN ${e.sent_at ?? new Date()}::timestamptz - interval '1 day' AND ${e.sent_at ?? new Date()}::timestamptz + interval '1 hour'
      ORDER BY l.created_at`.catch(() => []) : Promise.resolve([]),
    contextOf(e.id),
    // La respuesta del contacto (la primera después de este envío), para verla aquí mismo.
    sql<{ id: string; body: string; sent_at: Date; reply_class: string | null }[]>`
      SELECT r.id, r.body, r.sent_at, r.reply_class FROM emails r
      WHERE r.direction = 'in' AND r.sent_at > ${e.sent_at ?? new Date()} AND (r.person_id = ${e.person_id} OR lower(r.from_email) = lower(${e.to_email ?? ""}))
      ORDER BY r.sent_at LIMIT 1`,
  ]);
  const events = [...e.opens.map((o) => ({ ...o, kind: "open" as const, url: null as string | null })),
    ...e.clicks.map((c) => ({ at: c.at, device: c.device, client: null, place: null, automatic: c.automatic, kind: "click" as const, url: c.url }))]
    .sort((a, b) => +new Date(b.at) - +new Date(a.at));

  return (
    <main className="page">
      <div className="crumbs">
        {ctx.campaign_id ? <Link href={`/campaigns/${ctx.campaign_id}?tab=correos`}>{ctx.campaign_name}</Link>
          : ctx.sequence_id ? <Link href={`/sequences/${ctx.sequence_id}?tab=correos`}>{ctx.sequence_name}</Link>
          : <Link href="/emails">Correos enviados</Link>}
      </div>
      <div className="page-head mail-head">
        <div>
          <h1>{e.subject || "(sin asunto)"}</h1>
          <p className="mail-status">
            {ctx.bounced ? <span className="badge lost">Rebotó</span>
              : <>
                <span className="badge">Entregado</span>
                {e.track && (human.length ? <span className="badge open">Abierto {human.length > 1 ? `×${human.length}` : ""}</span> : <span className="badge">Sin abrir</span>)}
                {e.click_count > 0 && <span className="badge open">{e.click_count} clic{e.click_count === 1 ? "" : "s"}</span>}
                {e.replied_at && <span className="badge won">Respondió</span>}
              </>}
            <span className="meta">Enviado el {dateTime(e.sent_at)}</span>
          </p>
        </div>
      </div>

      <div className="mail-layout">
        <div className="mail-main">
          <article className="mail-card mail-message" aria-label="Correo">
            <header className="mail-from">
              <Avatar name={e.user_name ?? e.from_email} />
              <div>
                <strong>{e.user_name ?? e.from_email ?? "—"}</strong> {e.user_name && e.from_email && <span className="meta">&lt;{e.from_email}&gt;</span>}
                <div className="meta">Para {e.person_id ? <Link href={`/persons/${e.person_id}`}>{e.to_name ?? e.to_email}</Link> : e.to_name ?? e.to_email}
                  {e.to_name && e.to_email && <> &lt;{e.to_email}&gt;</>}</div>
              </div>
              <time className="meta">{dateTime(e.sent_at)}</time>
            </header>
            <div className="mail-body">{e.body}</div>
            {(atts.length > 0 || docs.length > 0) && (
              <footer className="mail-attachments">
                {atts.map((a) => <span key={a.name} className="chip-file"><Icon name="file" />{a.name} <span className="meta">{fileSize(a.size)}</span></span>)}
                {docs.map((d, i) => (
                  <span key={`d${i}`} className="chip-file"><Icon name="file" />{d.name}{" "}
                    {d.views ? <span className="tone-good">abierto {d.views} {d.views === 1 ? "vez" : "veces"}{d.seconds ? `, ${duration(d.seconds)}` : ""}</span> : <span className="meta">sin abrir</span>}</span>
                ))}
              </footer>
            )}
          </article>

          {reply && (
            <article className="mail-card mail-message mail-reply" aria-label="Respuesta">
              <header className="mail-from">
                <Avatar name={e.to_name ?? e.to_email} />
                <div>
                  <strong>{e.to_name ?? e.to_email}</strong> <span className="meta">respondió</span>
                  {reply.reply_class && <> <span className={`badge ${replyTone(reply.reply_class)}`}>{REPLY_TEXT[reply.reply_class] ?? reply.reply_class}</span></>}
                </div>
                <time className="meta">{dateTime(reply.sent_at)}</time>
              </header>
              <div className="mail-body">{reply.body}</div>
              <footer><Link className="meta" href={`/emails/${reply.id}`}>Abrir la respuesta</Link></footer>
            </article>
          )}
        </div>

        <aside className="mail-side">
          <section className="mail-card" aria-label="Lectura">
            <h2>Lectura</h2>
            {!e.track ? <p className="meta" style={{ margin: 0 }}>Este correo se envió sin seguimiento.</p> : (
              <>
                <div className="mail-stats">
                  <div><strong>{human.length}</strong><span className="meta">apertura{human.length === 1 ? "" : "s"}</span></div>
                  <div><strong>{e.click_count}</strong><span className="meta">clic{e.click_count === 1 ? "" : "s"}</span></div>
                  <div><strong>{days}</strong><span className="meta">día{days === 1 ? "" : "s"} distinto{days === 1 ? "" : "s"}</span></div>
                </div>
                {human.length === 0 && !e.click_count ? <p className="meta" style={{ margin: 0 }}>Todavía no se ha abierto.</p> : (
                  <p className="meta" style={{ margin: 0 }}>Primera apertura el {dateTime(e.first_opened_at)}{human.length > 1 && <>; la última, el {dateTime(e.last_opened_at)}</>}.</p>
                )}
                {events.length > 0 && (
                  <ol className="mail-timeline">
                    {events.map((o, i) => (
                      <li key={i} className={o.automatic ? "auto" : o.kind}>
                        <span className="dot" aria-hidden="true" />
                        <div>
                          <strong>{o.kind === "open" ? "Abierto" : "Clic"}</strong>
                          {o.automatic && <span className="badge" title="No cuenta: la hizo un escáner o la precarga del programa de correo"> automática</span>}
                          <div className="meta">{dateTime(o.at)}</div>
                          <div className="meta">{[o.device ? DEVICE_LABEL[o.device as keyof typeof DEVICE_LABEL] ?? o.device : null, o.client, o.place].filter(Boolean).join(" · ")}</div>
                          {o.url && <div className="meta mail-url">{o.url}</div>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
                {auto > 0 && <p className="meta" style={{ margin: 0 }}>{auto} apertura{auto === 1 ? "" : "s"} automática{auto === 1 ? "" : "s"} (escáneres o precarga de Apple Mail): en gris, no cuentan.</p>}
                <details className="meta"><summary>Sobre estos datos</summary>
                  El lugar solo aparece si el CRM está publicado detrás de un proxy que lo indique (Cloudflare, Vercel…). Gmail descarga las imágenes por su cuenta: en sus aperturas no se sabe el dispositivo.</details>
              </>
            )}
          </section>
          <ContextList c={ctx} person={e.to_name ?? e.to_email} personId={e.person_id} dealId={e.deal_id} dealTitle={e.deal_title} />
        </aside>
      </div>
    </main>
  );
}

/** Un correo recibido (una respuesta): quién, cuándo, cómo se clasificó y a qué contestaba. */
async function ReceivedEmail({ id }: { id: string }) {
  if (!isId(id)) notFound();
  const [r] = await sql<{ id: string; subject: string; body: string; from_email: string | null; to_email: string | null; sent_at: Date; person_id: string | null;
                          person_name: string | null; deal_id: string | null; deal_title: string | null; reply_class: string | null; reply_to_email: string | null;
                          prev_subject: string | null; prev_body: string | null; prev_sent_at: Date | null; prev_from: string | null }[]>`
    SELECT e.id, e.subject, e.body, e.from_email, e.to_email, e.sent_at, e.person_id, p.full_name AS person_name, e.deal_id, d.title AS deal_title, e.reply_class,
           e.reply_to_email, prev.subject AS prev_subject, prev.body AS prev_body, prev.sent_at AS prev_sent_at, prev.from_email AS prev_from
    FROM emails e LEFT JOIN persons p ON p.id = e.person_id LEFT JOIN deals d ON d.id = e.deal_id LEFT JOIN emails prev ON prev.id = e.reply_to_email
    WHERE e.id = ${id} AND e.direction = 'in'`;
  if (!r) notFound();
  const ctx = r.reply_to_email ? await contextOf(r.reply_to_email) : await contextOf(r.id);
  return (
    <main className="page">
      <div className="crumbs">
        {ctx.campaign_id ? <Link href={`/campaigns/${ctx.campaign_id}?tab=correos&ver=respuestas`}>{ctx.campaign_name}</Link>
          : r.person_id ? <Link href={`/persons/${r.person_id}`}>{r.person_name}</Link> : <Link href="/emails">Correos</Link>}
      </div>
      <div className="page-head mail-head">
        <div>
          <h1>{r.subject || "(sin asunto)"}</h1>
          <p className="mail-status">
            <span className="badge">Recibido</span>
            {r.reply_class && <span className={`badge ${replyTone(r.reply_class)}`}>{REPLY_TEXT[r.reply_class] ?? r.reply_class}</span>}
            <span className="meta">el {dateTime(r.sent_at)}</span>
          </p>
        </div>
      </div>
      <div className="mail-layout">
        <div className="mail-main">
          <article className="mail-card mail-message" aria-label="Respuesta">
            <header className="mail-from">
              <Avatar name={r.person_name ?? r.from_email} />
              <div>
                <strong>{r.person_id ? <Link href={`/persons/${r.person_id}`}>{r.person_name ?? r.from_email}</Link> : r.from_email}</strong>
                {r.from_email && <span className="meta"> &lt;{r.from_email}&gt;</span>}
                <div className="meta">Para {r.to_email ?? "—"}</div>
              </div>
              <time className="meta">{dateTime(r.sent_at)}</time>
            </header>
            <div className="mail-body">{r.body}</div>
          </article>
          {r.reply_to_email && (
            <article className="mail-card mail-message mail-quoted" aria-label="Correo al que responde">
              <header className="mail-from">
                <span className="meta">Responde a</span>
                <div><Link href={`/emails/${r.reply_to_email}`}><strong>{r.prev_subject || "(sin asunto)"}</strong></Link>
                  <div className="meta">{r.prev_from} · {dateTime(r.prev_sent_at)}</div></div>
              </header>
              {r.prev_body && <div className="mail-body">{r.prev_body}</div>}
            </article>
          )}
        </div>
        <aside className="mail-side">
          <ContextList c={ctx} person={r.person_name ?? r.from_email} personId={r.person_id} dealId={r.deal_id} dealTitle={r.deal_title} />
        </aside>
      </div>
    </main>
  );
}
