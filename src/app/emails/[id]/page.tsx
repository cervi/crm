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

export const dynamic = "force-dynamic";
export const metadata = { title: "Correo enviado" };

/** Un correo enviado con cada apertura y cada clic (fecha, dispositivo, programa y lugar aproximado). */
export default async function SentEmailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const e = isId(id) ? await getSentEmail(id) : null;
  if (!e) return <ReceivedEmail id={id} />;
  const human = e.opens.filter((o) => !o.automatic);
  const auto = e.opens.length - human.length;
  const days = new Set(human.map((o) => new Date(o.at).toDateString())).size;
  const [atts, docs] = await Promise.all([
    attachmentsFor([e.id]).then((m) => m.get(e.id) ?? []),
    // Documentos de la biblioteca enviados como enlace a este contacto (y si los ha abierto).
    e.person_id ? sql<{ name: string; views: number; seconds: number; last: Date | null }[]>`
      SELECT coalesce(i.name, f.name) AS name, l.view_count AS views, l.seconds, l.last_viewed_at AS last
      FROM doc_links l LEFT JOIN library_items i ON i.id = l.library_id LEFT JOIN files f ON f.id = l.file_id
      WHERE l.person_id = ${e.person_id} AND l.created_at BETWEEN ${e.sent_at ?? new Date()}::timestamptz - interval '1 day' AND ${e.sent_at ?? new Date()}::timestamptz + interval '1 hour'
      ORDER BY l.created_at`.catch(() => []) : Promise.resolve([]),
  ]);

  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/emails">Correos enviados</Link></div>
      <div className="page-head"><h1>{e.subject || "(sin asunto)"}</h1></div>
      <dl className="dl compact">
        <div className="dl-row"><dt>Para</dt><dd>{e.person_id ? <Link href={`/persons/${e.person_id}`}>{e.to_name ?? e.to_email}</Link> : e.to_name ?? e.to_email} {e.to_email && <span className="meta">· {e.to_email}</span>}</dd></div>
        <div className="dl-row"><dt>Desde</dt><dd>{e.from_email ?? "—"}{e.user_name && <span className="meta"> · {e.user_name}</span>}</dd></div>
        <div className="dl-row"><dt>Enviado</dt><dd>{dateTime(e.sent_at)}</dd></div>
        {e.deal_id && <div className="dl-row"><dt>Deal</dt><dd><Link href={`/deals/${e.deal_id}`}>{e.deal_title}</Link></dd></div>}
        {e.sequence_name && <div className="dl-row"><dt>Secuencia</dt><dd>{e.sequence_name}</dd></div>}
        <div className="dl-row"><dt>Respondido</dt><dd>{e.replied_at ? dateTime(e.replied_at) : "Todavía no"}</dd></div>
        {atts.length > 0 && <div className="dl-row"><dt>Adjuntos</dt><dd>{atts.map((a) => `${a.name} (${fileSize(a.size)})`).join(", ")}</dd></div>}
        {docs.length > 0 && <div className="dl-row"><dt>Documentos con enlace</dt><dd>{docs.map((d, i) => (
          <div key={i}>{d.name} · {d.views ? <span className="tone-good">abierto {d.views} {d.views === 1 ? "vez" : "veces"}{d.seconds ? `, ${duration(d.seconds)}` : ""}</span> : <span className="muted">sin abrir</span>}</div>
        ))}</dd></div>}
      </dl>

      <section className="panel" aria-label="Lectura">
        <h2 className="section-title">Lectura</h2>
        {!e.track ? <p className="muted">Este correo se envió sin seguimiento.</p> : (
          <>
            <p>
              {human.length === 0 ? "Todavía no se ha abierto." : <>Abierto <strong>{human.length} {human.length === 1 ? "vez" : "veces"}</strong>
                {days > 1 && <> en {days} días distintos</>}: la primera el {dateTime(e.first_opened_at)}{human.length > 1 && <> y la última el {dateTime(e.last_opened_at)}</>}.</>}
              {e.click_count > 0 && <> {e.click_count} clic{e.click_count === 1 ? "" : "s"} en enlaces.</>}
            </p>
            {e.opens.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Fecha y hora</th><th>Qué</th><th>Dispositivo</th><th>Programa</th><th>Lugar</th></tr></thead>
                  <tbody>
                    {[...e.opens.map((o) => ({ ...o, kind: "open" as const, url: null as string | null })),
                      ...e.clicks.map((c) => ({ at: c.at, device: c.device, client: null, place: null, automatic: c.automatic, kind: "click" as const, url: c.url }))]
                      .sort((a, b) => +new Date(b.at) - +new Date(a.at))
                      .map((o, i) => (
                        <tr key={i} className={o.automatic ? "muted-row" : undefined}>
                          <td>{dateTime(o.at)}</td>
                          <td>{o.kind === "open" ? "Apertura" : <>Clic <span className="meta">{o.url}</span></>}{o.automatic && <span className="badge" style={{ marginLeft: 6 }} title="No cuenta: la hizo un escáner o la precarga del programa de correo">Automática</span>}</td>
                          <td>{o.device ? DEVICE_LABEL[o.device as keyof typeof DEVICE_LABEL] ?? o.device : "—"}</td>
                          <td>{o.client ?? "—"}</td>
                          <td>{o.place ?? "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
            {auto > 0 && <p className="meta">{auto} apertura{auto === 1 ? "" : "s"} automática{auto === 1 ? "" : "s"} (escáneres de seguridad o precarga de Apple Mail): se muestran en gris y no cuentan.</p>}
            <p className="meta">El lugar solo aparece si el CRM está publicado detrás de un proxy que lo indique (Cloudflare, Vercel…). Gmail descarga las imágenes por su cuenta: en sus aperturas no se sabe el dispositivo.</p>
          </>
        )}
      </section>

      <section aria-label="Texto">
        <h2 className="section-title">Texto</h2>
        <p className="note-body">{e.body}</p>
      </section>
    </main>
  );
}

const REPLY_TEXT: Record<string, string> = {
  interesado: "Interesado", mas_adelante: "Más adelante", no_interesado: "No interesado", baja: "Pide la baja", ooo: "Fuera de la oficina", fuera_oficina: "Fuera de la oficina", otro: "Otra respuesta",
};

/** Un correo recibido (una respuesta): quién, cuándo, cómo se clasificó y a qué contestaba. */
async function ReceivedEmail({ id }: { id: string }) {
  if (!isId(id)) notFound();
  const [r] = await sql<{ id: string; subject: string; body: string; from_email: string | null; to_email: string | null; sent_at: Date; person_id: string | null;
                          person_name: string | null; deal_id: string | null; deal_title: string | null; reply_class: string | null; reply_to_email: string | null; prev_subject: string | null }[]>`
    SELECT e.id, e.subject, e.body, e.from_email, e.to_email, e.sent_at, e.person_id, p.full_name AS person_name, e.deal_id, d.title AS deal_title, e.reply_class,
           e.reply_to_email, prev.subject AS prev_subject
    FROM emails e LEFT JOIN persons p ON p.id = e.person_id LEFT JOIN deals d ON d.id = e.deal_id LEFT JOIN emails prev ON prev.id = e.reply_to_email
    WHERE e.id = ${id} AND e.direction = 'in'`;
  if (!r) notFound();
  return (
    <main className="page medium">
      <div className="crumbs">{r.person_id ? <Link href={`/persons/${r.person_id}`}>{r.person_name}</Link> : <Link href="/emails">Correos</Link>}</div>
      <div className="page-head"><h1>{r.subject || "(sin asunto)"}</h1></div>
      <dl className="dl compact">
        <div className="dl-row"><dt>De</dt><dd>{r.person_id ? <Link href={`/persons/${r.person_id}`}>{r.person_name ?? r.from_email}</Link> : r.from_email} {r.from_email && <span className="meta">· {r.from_email}</span>}</dd></div>
        <div className="dl-row"><dt>Para</dt><dd>{r.to_email ?? "—"}</dd></div>
        <div className="dl-row"><dt>Recibido</dt><dd>{dateTime(r.sent_at)}</dd></div>
        {r.reply_class && <div className="dl-row"><dt>Tipo de respuesta</dt><dd><span className={`badge ${r.reply_class === "interesado" ? "won" : r.reply_class === "baja" ? "lost" : ""}`}>{REPLY_TEXT[r.reply_class] ?? r.reply_class}</span></dd></div>}
        {r.reply_to_email && <div className="dl-row"><dt>Responde a</dt><dd><Link href={`/emails/${r.reply_to_email}`}>{r.prev_subject || "(sin asunto)"}</Link></dd></div>}
        {r.deal_id && <div className="dl-row"><dt>Deal</dt><dd><Link href={`/deals/${r.deal_id}`}>{r.deal_title}</Link></dd></div>}
      </dl>
      <section className="panel" aria-label="Texto">
        <h2 className="section-title">Texto</h2>
        <p className="note-body">{r.body}</p>
      </section>
    </main>
  );
}
