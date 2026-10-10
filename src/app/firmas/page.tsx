import Link from "next/link";
import { DataTable } from "@/components/DataTable";
import { NewSignRequest } from "@/components/esign/NewSignRequest";
import { requireUser } from "@/lib/auth";
import { listRequests, REQUEST_STATUS } from "@/lib/esign";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Firmas" };

const FILTERS = [
  { key: "", label: "Todos" }, { key: "sent", label: "Esperando firmas" }, { key: "completed", label: "Firmados" },
  { key: "declined", label: "Rechazados" }, { key: "expired", label: "Caducados" }, { key: "draft", label: "Borradores" },
] as const;

export default async function SignListPage({ searchParams }: { searchParams: Promise<{ f?: string; mine?: string }> }) {
  const [me, sp] = await Promise.all([requireUser(), searchParams]);
  const status = FILTERS.some((x) => x.key === sp.f) ? sp.f || null : null;
  const mine = sp.mine !== "0";
  const [rows, all] = await Promise.all([
    listRequests({ status, ownerId: mine ? me.id : null }), listRequests({ ownerId: mine ? me.id : null }),
  ]);
  const qs = (p: Record<string, string | null>) => {
    const u = new URLSearchParams();
    const m = { f: status, mine: mine ? null : "0", ...p };
    for (const [k, v] of Object.entries(m)) if (v) u.set(k, v);
    return u.toString() ? `/firmas?${u}` : "/firmas";
  };
  const days = (d: Date | null) => (d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : 0);
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Firmas</h1>
          <p className="muted" style={{ margin: 0 }}>Contratos enviados a firmar: quién ha firmado, quién falta y desde cuándo.</p>
        </div>
        <div className="head-actions"><NewSignRequest buttonClass="btn" label="Nuevo documento para firmar" /></div>
      </div>
      <nav className="chips" aria-label="Filtrar">
        {FILTERS.map((x) => {
          const n = x.key ? all.filter((r) => r.status === x.key).length : all.length;
          return <Link key={x.key} href={qs({ f: x.key || null })} aria-current={(status ?? "") === x.key ? "page" : undefined}
                       className={x.key === "sent" && n ? "warn" : undefined}>{x.label}<span className="chip-count">{n}</span></Link>;
        })}
        <span className="spacer" />
        <Link href={qs({ mine: mine ? "0" : null })}>{mine ? "Ver los de todo el equipo" : "Ver solo los míos"}</Link>
      </nav>
      <DataTable id="sign-requests"
        empty={all.length === 0 ? <>Aún no has enviado nada a firmar. Desde la ficha de un deal, «Enviar un contrato a firmar».</> : <>No hay documentos con este filtro.</>}
        columns={[
          { key: "doc", label: "Documento", required: true, pinned: true },
          { key: "status", label: "Estado" },
          { key: "signers", label: "Firmantes" },
          { key: "waiting", label: "Esperando", className: "nowrap" },
          { key: "deal", label: "Deal" },
          { key: "sent", label: "Enviado", className: "nowrap" },
          { key: "by", label: "Enviado por", hidden: true },
        ]}
        rows={rows.map((r) => {
          const s = REQUEST_STATUS[r.status];
          const signed = r.signers.filter((x) => x.status === "signed").length;
          const w = r.status === "sent" ? days(r.sent_at) : 0;
          return {
            id: r.id, label: r.title,
            cells: {
              doc: <Link href={`/firmas/${r.id}`}><strong>{r.title}</strong></Link>,
              status: <span className={`badge ${s.tone}`}>{s.label}</span>,
              signers: <span title={r.signers.map((x) => `${x.name}: ${x.status === "signed" ? "firmado" : x.status === "declined" ? "rechazado" : x.first_viewed_at ? "lo ha abierto" : "sin abrir"}`).join("\n")}>
                {signed}/{r.signers.length} · <span className="meta">{r.signers.map((x) => x.name.split(" ")[0]).join(", ")}</span></span>,
              waiting: r.status === "sent" ? <span className={w >= 3 ? "tone-bad" : undefined}>{w === 0 ? "hoy" : `${w} día${w === 1 ? "" : "s"}`}</span> : <span className="muted">—</span>,
              deal: r.deal_id ? <Link href={`/deals/${r.deal_id}`}>{r.deal_title}</Link> : <span className="muted">—</span>,
              sent: r.sent_at ? dateTime(r.sent_at) : <span className="muted">—</span>,
              by: r.sender_name ?? r.creator_name,
            },
          };
        })}
      />
    </main>
  );
}
