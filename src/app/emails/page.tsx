import Link from "next/link";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { DataTable } from "@/components/DataTable";
import { requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { SENT_FILTERS, isSentFilter, listSent, sentStats } from "@/lib/emails";

export const dynamic = "force-dynamic";
export const metadata = { title: "Correos enviados" };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");

/** Bandeja de correos enviados desde el CRM: quién los abrió, cuántas veces, cuándo, clics y respuestas. */
export default async function SentPage({ searchParams }: { searchParams: Promise<{ who?: string; f?: string; q?: string; page?: string }> }) {
  const me = await requireUser();
  const sp = await searchParams;
  const who = sp.who === "all" ? "all" : "mine";
  const filter = isSentFilter(sp.f) ? sp.f : "all";
  const page = Math.max(0, Number(sp.page) || 0);
  const userId = who === "mine" ? me.id : null;
  const [rows, stats] = await Promise.all([listSent({ userId, filter, q: sp.q, page }), sentStats(userId)]);
  const more = rows.length > 100;
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ who, f: filter === "all" ? undefined : filter, q: sp.q, ...patch })) if (v) p.set(k, v);
    return `/emails?${p}`;
  };

  return (
    <main className="page">
      <div className="page-head">
        <h1>Correos enviados</h1>
        <span className="muted">Últimos 30 días: {stats.sent} enviados</span>
        <span className="spacer" />
        <nav className="chips" aria-label="De quién">
          <Link href={qs({ who: "mine", page: undefined })} aria-current={who === "mine" ? "page" : undefined}>Míos</Link>
          <Link href={qs({ who: "all", page: undefined })} aria-current={who === "all" ? "page" : undefined}>De todo el equipo</Link>
        </nav>
      </div>

      <section className="today-stats sent-stats" aria-label="Lectura en los últimos 30 días">
        <Link href={qs({ f: "opened", page: undefined })} className="today-stat"><span className="label">Abiertos</span><strong>{pct(stats.opened, stats.tracked)}</strong><span className="meta">{stats.opened} de {stats.tracked} con seguimiento</span></Link>
        <Link href={qs({ f: "clicked", page: undefined })} className="today-stat"><span className="label">Con clics</span><strong>{pct(stats.clicked, stats.tracked)}</strong><span className="meta">{stats.clicked} correos</span></Link>
        <Link href={qs({ f: "replied", page: undefined })} className="today-stat"><span className="label">Respondidos</span><strong>{pct(stats.replied, stats.sent)}</strong><span className="meta">{stats.replied} correos</span></Link>
        <Link href={qs({ f: "opened_no_reply", page: undefined })} className={`today-stat ${stats.opened - stats.replied > 0 ? "warn" : ""}`}><span className="label">Abiertos sin responder</span><strong>{Math.max(0, stats.opened - stats.replied)}</strong><span className="meta">buen momento para llamar</span></Link>
      </section>

      <form className="toolbar">
        <input type="hidden" name="who" value={who} />
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Asunto, contacto, email o deal" aria-label="Buscar" />
        <AutoSubmitSelect name="f" defaultValue={filter} aria-label="Lectura">
          {Object.entries(SENT_FILTERS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </AutoSubmitSelect>
        <button className="sr-only" tabIndex={-1}>Buscar</button>
      </form>

      <DataTable id="emails" empty={sp.q || filter !== "all" ? <>No hay correos con estos filtros. <Link href="/emails">Quitar filtros</Link></> : "Todavía no has enviado correos desde el CRM. Escribe desde la ficha de un deal o un contacto, o con una secuencia."}
        columns={[
          { key: "subject", label: "Correo", required: true, pinned: true },
          { key: "to", label: "Para" },
          { key: "deal", label: "Deal" },
          { key: "sent", label: "Enviado", className: "nowrap" },
          { key: "opened", label: "Abierto" },
          { key: "opens", label: "Veces", className: "num" },
          { key: "last_open", label: "Última apertura", className: "nowrap" },
          { key: "clicks", label: "Clics", className: "num" },
          { key: "replied", label: "Respondido" },
          { key: "sequence", label: "Secuencia", hidden: true },
          { key: "sender", label: "Enviado por", hidden: who !== "all" },
        ]}
        rows={rows.slice(0, 100).map((e) => ({
          id: e.id, label: e.subject,
          cells: {
            subject: <Link href={`/emails/${e.id}`}><strong>{e.subject || "(sin asunto)"}</strong></Link>,
            to: e.person_id ? <Link href={`/persons/${e.person_id}`}>{e.to_name ?? e.to_email}</Link> : e.to_name ?? e.to_email,
            deal: e.deal_id ? <Link href={`/deals/${e.deal_id}`}>{e.deal_title}</Link> : null,
            sent: dateTime(e.sent_at),
            opened: !e.track ? <span className="meta">Sin seguimiento</span> : e.open_count > 0 ? <span className="badge won">Sí</span> : <span className="badge">No</span>,
            opens: e.track ? e.open_count : null,
            last_open: e.last_opened_at ? dateTime(e.last_opened_at) : null,
            clicks: e.track ? e.click_count : null,
            replied: e.replied_at ? <span className="badge won" title={dateTime(e.replied_at)}>Sí</span> : <span className="meta">No</span>,
            sequence: e.sequence_name, sender: e.user_name,
          },
        }))} />
      <div className="pager">
        {page > 0 && <Link href={qs({ page: String(page - 1) })} className="btn secondary">← Más recientes</Link>}
        {more && <Link href={qs({ page: String(page + 1) })} className="btn secondary">Más antiguos →</Link>}
      </div>
      <p className="meta">Las aperturas son orientativas: algunos programas de correo abren las imágenes solos (no cuentan: se marcan como automáticas) o las bloquean (un clic cuenta como apertura).</p>
    </main>
  );
}
