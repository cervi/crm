import Link from "next/link";
import { ExportLink } from "@/components/ExportLink";
import { countPending, getSettings, listActions } from "@/lib/automations";
import { hasActiveMailbox } from "@/lib/mailbox";
import { dateTime } from "@/lib/format";
import { runNowAction, setPausedAction } from "@/app/actions/automations";
import { ActionForm } from "@/components/ActionForm";
import { LogRow, ProposalCard } from "@/components/ai/ProposalCard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bandeja de la IA" };

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const view = (await searchParams).view === "log" ? "log" : "pending";
  const [items, pending, settings, canSend] = await Promise.all([listActions({ view }), countPending(), getSettings(), hasActiveMailbox()]);

  return (
    <main className="page" style={{ maxWidth: 980 }}>
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

      <nav className="tabs">
        <Link href="/inbox" aria-current={view === "pending" ? "page" : undefined}>Pendientes {pending > 0 && <span className="count">{pending}</span>}</Link>
        <Link href="/inbox?view=log" aria-current={view === "log" ? "page" : undefined}>Registro</Link>
        {view === "log" && <span className="tabs-end"><ExportLink dataset="ai-log" label="Exportar CSV" small /></span>}
      </nav>

      {view === "pending" ? (
        items.length === 0 ? (
          <div className="empty">No hay nada pendiente de decidir.</div>
        ) : (
          <div className="proposals">{items.map((i) => <ProposalCard key={i.id} item={i} canSend={canSend} />)}</div>
        )
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Cuándo</th><th>Estado</th><th>Acción</th><th>Deal</th><th /></tr></thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={5} className="empty-row">Todavía no hay acciones registradas.</td></tr>}
              {items.map((i) => <LogRow key={i.id} item={i} />)}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
