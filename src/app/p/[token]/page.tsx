import { notFound } from "next/navigation";
import { money } from "@/lib/format";
import { proposalByToken, recordView } from "@/lib/proposals";
import { Decision } from "./Decision";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const p = await proposalByToken((await params).token);
  return { title: p?.title ?? "Propuesta", robots: { index: false } };
}

/** Propuesta para el cliente (pública con su enlace). */
export default async function ProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = await proposalByToken(token);
  if (!p) notFound();
  await recordView(token).catch(() => null);
  const expired = p.valid_until !== null && new Date(`${p.valid_until}T23:59:59`) < new Date();
  const until = p.valid_until ? new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${p.valid_until}T00:00:00Z`)) : null;
  return (
    <main className="proposal">
      <header>
        <p className="meta">{p.organization ?? p.deal_title}</p>
        <h1>{p.title}</h1>
        {until && <p className="meta">Válida hasta el {until}</p>}
      </header>
      <div className="proposal-text">{p.intro}</div>
      <table className="proposal-lines">
        <thead><tr><th>Concepto</th><th className="num">Cantidad</th><th className="num">Precio</th><th className="num">Dto.</th><th className="num">Importe</th></tr></thead>
        <tbody>
          {p.lines.map((l, i) => (
            <tr key={i}>
              <td>{l.name}<div className="meta">{l.billing}</div></td>
              <td className="num">{l.quantity.toLocaleString("es-ES")}</td>
              <td className="num">{money(l.unit_price, p.currency)}</td>
              <td className="num">{l.discount_pct ? `${l.discount_pct} %` : "—"}</td>
              <td className="num">{money(l.subtotal, p.currency)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={4}>Total (impuestos no incluidos)</td><td className="num"><strong>{money(p.total, p.currency)}</strong></td></tr></tfoot>
      </table>
      {p.status === "accepted" ? <p className="callout good">Propuesta aceptada por {p.decided_name}. ¡Gracias!</p>
        : p.status === "declined" ? <p className="callout">Propuesta rechazada. Gracias por responder.</p>
        : expired ? <p className="callout">Esta propuesta ha caducado. Escribe a {p.owner ?? "tu contacto"} para actualizarla.</p>
        : <Decision token={token} />}
      {p.owner && <p className="meta">Cualquier duda: {p.owner}{p.owner_email ? ` · ${p.owner_email}` : ""}</p>}
    </main>
  );
}
