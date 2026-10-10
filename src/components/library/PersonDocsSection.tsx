import Link from "next/link";
import { sql } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { duration, listLinks } from "@/lib/library";

/** En la ficha del contacto: documentos que le has compartido y contratos que tiene que firmar o ha firmado. */
export async function PersonDocsSection({ personId }: { personId: string }) {
  const [links, signs] = await Promise.all([
    listLinks({ personId }),
    sql<{ id: string; title: string; status: string; signer_status: string; signed_at: Date | null }[]>`
      SELECT r.id, r.title, r.status, s.status AS signer_status, s.signed_at FROM sign_signers s JOIN sign_requests r ON r.id = s.request_id
      WHERE s.person_id = ${personId} AND r.status <> 'draft' ORDER BY coalesce(r.sent_at, r.created_at) DESC LIMIT 10`.catch(() => []),
  ]);
  if (!links.length && !signs.length) return null;
  const label = (s: string) => ({ signed: "Firmado", pending: "Pendiente de firmar", waiting: "Esperando su turno", declined: "Rechazado" }[s] ?? s);
  return (
    <section className="side-section" aria-label="Documentos y firmas">
      <h3>Documentos y firmas</h3>
      <ul className="doc-list">
        {signs.map((s) => (
          <li key={s.id}><div><Link className="doc-title" href={`/firmas/${s.id}`}>{s.title}</Link>
            <div className={s.signer_status === "signed" ? "meta tone-good" : "meta"}>{label(s.signer_status)}{s.signed_at ? ` · ${dateTime(s.signed_at)}` : ""}</div></div></li>
        ))}
        {links.map((l) => (
          <li key={l.id}><div><span className="doc-title">{l.item}</span>
            <div className={l.view_count ? "meta tone-good" : "meta"}>{l.view_count ? `Abierto ${l.view_count} ${l.view_count === 1 ? "vez" : "veces"}${l.seconds ? `, ${duration(l.seconds)}` : ""}` : "Sin abrir"} · compartido {dateTime(l.created_at)}</div></div></li>
        ))}
      </ul>
    </section>
  );
}
