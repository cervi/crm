import Link from "next/link";
import { sql } from "@/lib/db";
import { listRequests, REQUEST_STATUS } from "@/lib/esign";
import { NewSignRequest } from "./NewSignRequest";

/** En la ficha del deal: los contratos enviados a firmar y el botón para enviar uno. */
export async function DealSignSection({ dealId }: { dealId: string }) {
  const [rows, pdfs] = await Promise.all([
    listRequests({ dealId }),
    sql<{ id: string; name: string }[]>`SELECT id, name FROM files WHERE deal_id = ${dealId} AND (mime = 'application/pdf' OR name ILIKE '%.pdf') ORDER BY created_at DESC LIMIT 30`,
  ]);
  const waiting = rows.filter((r) => r.status === "sent").length;
  return (
    <details className="side-section" aria-label="Firmas" open={rows.length > 0}>
      <summary><h3>Firmas</h3><span className="meta">{waiting ? `${waiting} esperando` : rows.length || ""}</span></summary>
      {rows.length > 0 && (
        <ul className="doc-list">
          {rows.map((r) => {
            const s = REQUEST_STATUS[r.status];
            const signed = r.signers.filter((x) => x.status === "signed").length;
            return (
              <li key={r.id}>
                <div>
                  <Link className="doc-title" href={`/firmas/${r.id}`}>{r.title}</Link>
                  <div className="meta"><span className={`badge ${s.tone}`}>{s.label}</span> {r.status !== "draft" && `${signed}/${r.signers.length} firmas`}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <NewSignRequest dealId={dealId} pdfs={pdfs.filter((p) => !p.name.includes("(firmado)"))} />
    </details>
  );
}
