import { duration, listLinks } from "@/lib/library";
import { dateTime } from "@/lib/format";

/** En la ficha del deal: documentos compartidos con enlace y si los han abierto. */
export async function DealDocsSection({ dealId }: { dealId: string }) {
  const links = await listLinks({ dealId });
  if (!links.length) return null;
  const opened = links.filter((l) => l.view_count > 0).length;
  return (
    <details className="side-section" id="documentos-enviados" aria-label="Documentos compartidos" open>
      <summary><h3>Documentos compartidos</h3><span className="meta">{opened}/{links.length} abiertos</span></summary>
      <ul className="doc-list">
        {links.map((l) => (
          <li key={l.id}>
            <div>
              <span className="doc-title">{l.item}</span>
              <div className={l.view_count ? "meta tone-good" : "meta"}>
                {l.person ?? "Enlace genérico"} · {l.view_count
                  ? `abierto ${l.view_count} ${l.view_count === 1 ? "vez" : "veces"}${l.seconds ? `, ${duration(l.seconds)}` : ""}, la última ${dateTime(l.last_viewed_at)}`
                  : `sin abrir (enviado ${dateTime(l.created_at)})`}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
