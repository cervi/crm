import { duration, listLinks } from "@/lib/library";
import { sql } from "@/lib/db";
import { LibraryShare } from "./LibraryShare";
import { dateTime } from "@/lib/format";

/** En la ficha del deal: documentos compartidos con enlace y si los han abierto. */
export async function DealDocsSection({ dealId }: { dealId: string }) {
  const [links, items, people] = await Promise.all([
    listLinks({ dealId }),
    sql<{ id: string; name: string }[]>`SELECT id, name FROM library_items WHERE archived_at IS NULL ORDER BY folder, name LIMIT 200`.catch(() => []),
    sql<{ id: string; name: string }[]>`SELECT p.id, p.full_name AS name FROM deal_participants dp JOIN persons p ON p.id = dp.person_id WHERE dp.deal_id = ${dealId} ORDER BY dp.is_primary DESC, dp.created_at`,
  ]);
  const opened = links.filter((l) => l.view_count > 0).length;
  return (
    <details className="side-section" id="documentos-enviados" aria-label="Documentos compartidos" open={links.length > 0}>
      <summary><h3>Documentos compartidos</h3><span className="meta">{links.length ? `${opened}/${links.length} abiertos` : ""}</span></summary>
      <LibraryShare items={[...items]} people={[...people]} dealId={dealId} />
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
