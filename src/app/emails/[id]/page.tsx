import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { getSentEmail } from "@/lib/emails";
import { DEVICE_LABEL } from "@/lib/reader";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Correo enviado" };

/** Un correo enviado con cada apertura y cada clic (fecha, dispositivo, programa y lugar aproximado). */
export default async function SentEmailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const e = isId(id) ? await getSentEmail(id) : null;
  if (!e) notFound();
  const human = e.opens.filter((o) => !o.automatic);
  const auto = e.opens.length - human.length;
  const days = new Set(human.map((o) => new Date(o.at).toDateString())).size;

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
