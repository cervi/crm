import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { BULK_APPROVABLE, actionLabel, countPending, getSettings, listActions, pendingFacets } from "@/lib/automations";
import { hasActiveMailbox } from "@/lib/mailbox";
import { dateTime } from "@/lib/format";
import { runNowAction, setPausedAction } from "@/app/actions/automations";
import { ActionForm } from "@/components/ActionForm";
import { LogRow, ProposalCard, proposer } from "@/components/ai/ProposalCard";
import { InboxList, type InboxRow } from "@/components/ai/InboxList";
import { requireUser } from "@/lib/auth";
import { pendingDiscounts } from "@/lib/products";
import { money } from "@/lib/format";
import { decideDiscountAction } from "@/app/actions/deal-agent";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bandeja de la IA" };

/** «hace 3 h», «hace 2 d»: lo bastante para ordenar mentalmente la cola. */
function age(d: Date) {
  const m = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
  if (m < 1) return "ahora";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.round(h / 24)} d`;
}

type SP = { view?: string; tipo?: string; regla?: string; q?: string; sel?: string };

export default async function InboxPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const view = sp.view === "log" ? "log" : "pending";
  const filter = { type: sp.tipo || null, rule: sp.regla || null, q: sp.q || null };
  const [items, pending, settings, canSend, me, facets] = await Promise.all([
    listActions({ view, filter: view === "pending" ? filter : undefined, limit: view === "pending" ? 500 : 200 }), countPending(), getSettings(), hasActiveMailbox(), requireUser(), pendingFacets(),
  ]);
  const discounts = me.role === "admin" ? await pendingDiscounts() : [];
  const canEdit = me.role !== "viewer";

  // Enlaces que conservan los filtros.
  const qs = (p: Partial<SP>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ tipo: sp.tipo, regla: sp.regla, q: sp.q, ...p })) if (v) u.set(k, v);
    const s = u.toString();
    return s ? `/inbox?${s}` : "/inbox";
  };
  const idx = Math.max(0, items.findIndex((i) => i.id === sp.sel));
  const current = view === "pending" ? items[idx] ?? null : null;
  // Tras decidir, la siguiente de la lista (o la anterior si era la última).
  const after = items[idx + 1] ?? items[idx - 1] ?? null;
  const nextUrl = qs({ sel: after?.id });
  const rows: InboxRow[] = items.map((i) => ({
    id: i.id, title: i.title, type: i.action_type, typeLabel: actionLabel(i.action_type),
    context: [i.deal_title ?? i.lead_title ?? i.account_name, i.organization_name].filter(Boolean).join(" · ") || null,
    age: age(i.created_at), href: qs({ sel: i.id }), selected: current?.id === i.id, bulkApprovable: BULK_APPROVABLE.has(i.action_type),
  }));
  const filtered = Boolean(sp.tipo || sp.regla || sp.q);

  return (
    <main className="page inbox-page">
      <div className="page-head">
        <div>
          <h1>Bandeja de la IA</h1>
          <p className="muted" style={{ margin: 0 }}>
            Lo que la IA propone y espera tu decisión, y el registro de lo que ha hecho.
            {" "}<Link href="/settings/automations">Ajustar su autonomía</Link>
          </p>
        </div>
        <div className="head-actions">
          <span className="meta">Última revisión: {settings.last_run_at ? dateTime(settings.last_run_at) : "nunca"}</span>
          <ActionForm action={runNowAction} submitLabel="Revisar ahora" pendingLabel="Revisando…" secondary className="form inline" />
        </div>
      </div>

      {settings.paused && (
        <div className="callout">
          La IA está en pausa: no propone ni hace nada nuevo.
          <form action={setPausedAction.bind(null, false)} style={{ display: "inline" }}>
            <button className="link" type="submit">Reanudar</button>
          </form>
        </div>
      )}

      {discounts.length > 0 && (
        <section className="panel" aria-label="Descuentos por aprobar">
          <h2>Descuentos por aprobar <span className="muted">{discounts.length}</span></h2>
          <ul className="items">
            {discounts.map((d) => (
              <li key={d.id} className="item">
                <div className="item-head">
                  <strong><Link href={`/deals/${d.deal_id}#productos`}>{d.deal_title}</Link></strong>
                  <span className="meta">{d.product}: {Number(d.discount_pct)} % (límite {Number(d.discount_limit)} %) · {money(d.subtotal, d.currency)}{d.requested_by_name ? ` · lo pide ${d.requested_by_name}` : ""}</span>
                  <span className="spacer" />
                  <ActionForm action={decideDiscountAction.bind(null, d.deal_id, d.id, true, "/inbox")} submitLabel="Aprobar" pendingLabel="…" good className="form inline" />
                  <ActionForm action={decideDiscountAction.bind(null, d.deal_id, d.id, false, "/inbox")} submitLabel={`Dejar en ${Number(d.discount_limit)} %`} pendingLabel="…" secondary className="form inline" />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav className="tabs">
        <Link href="/inbox" aria-current={view === "pending" ? "page" : undefined}>Pendientes {pending > 0 && <span className="count">{pending}</span>}</Link>
        <Link href="/inbox?view=log" aria-current={view === "log" ? "page" : undefined}>Registro</Link>
        {view === "log" && <span className="tabs-end"><ExportLink dataset="ai-log" label="Exportar CSV" small /></span>}
      </nav>

      {view === "log" ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Cuándo</th><th>Estado</th><th>Acción</th><th>Deal</th><th /></tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={5} className="empty-row">Todavía no hay acciones registradas.</td></tr>}
              {items.map((i) => <LogRow key={i.id} item={i} />)}
            </tbody>
          </table>
        </div>
      ) : pending === 0 ? (
        <div className="empty-state"><strong>No hay nada pendiente de decidir.</strong><span className="meta">Cuando la IA proponga algo (un correo, una tarea, mover un deal…), aparecerá aquí.</span></div>
      ) : (
        <>
          <div className="inbox-filters">
            <nav className="chips" aria-label="Por tipo">
              <Link href={qs({ tipo: undefined, sel: undefined })} aria-current={!sp.tipo ? "page" : undefined}>Todas <span className="meta">{pending}</span></Link>
              {facets.types.map((t) => (
                <Link key={t.key} href={qs({ tipo: t.key, sel: undefined })} aria-current={sp.tipo === t.key ? "page" : undefined}>{actionLabel(t.key)} <span className="meta">{t.n}</span></Link>
              ))}
            </nav>
            <form className="inbox-search" role="search">
              {sp.tipo && <input type="hidden" name="tipo" value={sp.tipo} />}
              {facets.rules.length > 1 && (
                <select name="regla" defaultValue={sp.regla ?? ""} aria-label="Quién lo propone">
                  <option value="">Todas las reglas</option>
                  {facets.rules.map((r) => <option key={r.key} value={r.key}>{r.label} ({r.n})</option>)}
                </select>
              )}
              <input name="q" defaultValue={sp.q} placeholder="Buscar por título, deal o empresa" aria-label="Buscar" />
              <button className="btn secondary small" type="submit">Filtrar</button>
              {filtered && <Link className="meta" href="/inbox">Quitar filtros</Link>}
            </form>
          </div>

          {items.length === 0 ? (
            <div className="empty-state"><strong>Ninguna propuesta con estos filtros.</strong><Link href="/inbox">Ver todas</Link></div>
          ) : (
            <div className="inbox-split">
              <aside className="inbox-side" aria-label="Lista de propuestas">
                <InboxList rows={rows} canEdit={canEdit} />
              </aside>
              <section className="inbox-detail" aria-label="Propuesta seleccionada">
                {current && (
                  <>
                    <div className="inbox-nav">
                      <span className="meta">{idx + 1} de {items.length}{filtered ? " (filtradas)" : ""} · propone {proposer(current)}</span>
                      <span className="inbox-nav-btns">
                        {items[idx - 1] ? <Link className="btn secondary small" href={qs({ sel: items[idx - 1].id })} scroll={false}>← Anterior</Link> : <span className="btn secondary small" aria-disabled="true">← Anterior</span>}
                        {items[idx + 1] ? <Link className="btn secondary small" href={qs({ sel: items[idx + 1].id })} scroll={false}>Siguiente →</Link> : <span className="btn secondary small" aria-disabled="true">Siguiente →</span>}
                      </span>
                    </div>
                    <ProposalCard key={current.id} item={current} canSend={canSend} next={nextUrl} />
                    <p className="meta">Al aprobar o descartar pasas a la siguiente.</p>
                  </>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </main>
  );
}
