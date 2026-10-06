import Link from "next/link";
import { buildDigest, type DigestItem } from "@/lib/digest";
import { HealthBadge } from "@/components/HealthBadge";
import { getDealBrief } from "@/lib/briefs";
import { listConnections } from "@/lib/mailbox";
import { listUsers } from "@/lib/users";
import { aiReady, getAiSettings } from "@/lib/ai";
import { dateTime, money } from "@/lib/format";
import { isId } from "@/lib/validation";
import { refreshFocusAction, sendDigestNowAction } from "@/app/actions/ai";
import { runNowAction } from "@/app/actions/automations";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hoy" };

const TZ = process.env.TZ || "Europe/Madrid";
const time = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("es-ES", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d)) : "";

function List({ items, empty, showTime, showDate }: { items: DigestItem[]; empty: string; showTime?: boolean; showDate?: boolean }) {
  if (items.length === 0) return <p className="muted today-empty">{empty}</p>;
  return (
    <ul className="today-list">
      {items.map((i, n) => (
        <li key={n} className={i.tone ? `tone-${i.tone}-edge` : undefined}>
          {showTime && <span className="today-time">{time(i.at)}</span>}
          <div>
            {i.href ? <Link href={i.href}>{i.title}</Link> : <span>{i.title}</span>}
            {(i.detail || showDate) && <div className="meta">{[i.detail, showDate && i.at ? dateTime(i.at) : null].filter(Boolean).join(" · ")}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ owner?: string }> }) {
  const sp = await searchParams;
  const ownerId = isId(sp.owner) ? sp.owner : null;
  const [users, d, connections, ai] = await Promise.all([
    listUsers(), buildDigest(ownerId, { ai: "cached" }), listConnections(), getAiSettings(),
  ]);
  const humans = users.filter((u) => u.kind === "human");
  const conn = ownerId ? connections.find((c) => c.user_id === ownerId && c.status === "active") : null;
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const greeting = hour < 14 ? "Buenos días" : hour < 21 ? "Buenas tardes" : "Buenas noches";
  const today = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(new Date());
  // El primer deal de la lista lleva su resumen completo.
  const top = d.attention[0] ? await getDealBrief(d.attention[0].deal.id) : null;

  const stats = [
    { label: "Decisiones pendientes", value: d.decisions.count, href: "/inbox", tone: d.decisions.count ? "accent" : "" },
    { label: "Reuniones hoy", value: d.agenda.length, href: "/activities", tone: "", sub: `${d.tasks.length} tareas para hoy` },
    { label: "Vencidas", value: d.overdue.length, href: "/activities", tone: d.overdue.length ? "bad" : "" },
    { label: "Deals con atención", value: d.attention.length, href: "#atencion", tone: d.attention.length ? "warn" : "" },
    { label: "Pipeline abierto", value: money(d.pipeline.value), href: "/pipelines", tone: "", sub: `${d.pipeline.count} deals` },
  ];

  return (
    <main className="page today" style={{ maxWidth: 1180 }}>
      <div className="page-head">
        <div>
          <h1>{greeting}{d.ownerName ? `, ${d.ownerName}` : ""}</h1>
          <p className="muted" style={{ margin: 0, textTransform: "none" }}>Tu parte de hoy, {today}.</p>
        </div>
        <div className="head-actions">
          <nav className="chips" aria-label="Ver el parte de">
            <Link href="/" aria-current={!ownerId ? "page" : undefined}>Todo el equipo</Link>
            {humans.map((u) => <Link key={u.id} href={`/?owner=${u.id}`} aria-current={ownerId === u.id ? "page" : undefined}>{u.name}</Link>)}
          </nav>
        </div>
      </div>

      <section className="today-stats" aria-label="Resumen">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className={`today-stat ${s.tone}`}>
            <span className="label">{s.label}</span>
            <strong>{s.value}</strong>
            {s.sub && <span className="meta">{s.sub}</span>}
          </Link>
        ))}
      </section>

      <section className="panel today-focus" aria-label="Enfoque del día">
        <div className="today-focus-head">
          <h2><Icon name="spark" />Enfoque del día</h2>
          <span className="meta">{d.focusSource === "ai" ? "Redactado por la IA" : "Según tus deals y tu agenda"}</span>
          <span className="spacer" />
          {aiReady(ai) && (
            <ActionForm action={refreshFocusAction.bind(null, ownerId)} submitLabel={d.focusSource === "ai" ? "Rehacer con IA" : "Redactar con IA"} pendingLabel="Redactando…" secondary className="form inline" />
          )}
          {conn && <ActionForm action={sendDigestNowAction.bind(null, ownerId!)} submitLabel="Enviármelo por correo" pendingLabel="Enviando…" secondary className="form inline" />}
          <ActionForm action={runNowAction} submitLabel="Revisar ahora" pendingLabel="Revisando…" secondary className="form inline" />
        </div>
        <p className="today-focus-text">{d.focus}</p>
      </section>

      <div className="today-grid">
        <div className="today-col">
          <section className="panel" id="atencion" aria-label="Deals que piden atención">
            <h2>Deals que piden atención <span className="muted">{d.attention.length}</span></h2>
            {d.attention.length === 0 ? <p className="muted today-empty">Ningún deal necesita nada urgente.</p> : (
              <ol className="attention">
                {d.attention.map((a, i) => (
                  <li key={a.deal.id} className={`p${a.step.priority}`}>
                    <div className="attention-main">
                      <Link href={`/deals/${a.deal.id}`} className="attention-title">{a.deal.title}</Link>
                      <span className="meta">{[a.deal.organization_name, a.deal.stage_name, money(a.deal.value, a.deal.currency), a.deal.owner_name].filter(Boolean).join(" · ")}</span>
                      <div className="attention-step"><strong>{a.step.text}</strong> <span className="muted">{a.step.why}</span></div>
                      {i === 0 && top && (
                        <div className="attention-brief">
                          <p>{top.resumen}</p>
                          {top.riesgos.length > 0 && <ul>{top.riesgos.map((r) => <li key={r}>{r}</li>)}</ul>}
                        </div>
                      )}
                    </div>
                    <span className={`badge ${a.step.priority === 1 ? "lost" : "warn"}`}>{a.step.priority === 1 ? "Urgente" : "Esta semana"}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {(d.movers.length > 0 || d.hotOpens.length > 0) && (
            <section className="panel" aria-label="Señales">
              <h2>Señales <span className="muted">desde ayer</span></h2>
              {d.movers.length > 0 && (
                <ul className="today-list movers">
                  {d.movers.map((m) => (
                    <li key={m.id}>
                      <HealthBadge score={m.score} compact />
                      <Link href={`/deals/${m.id}`}>{m.title}</Link>
                      <span className={m.score < m.before ? "tone-bad" : "tone-good"}> {m.score < m.before ? "▼" : "▲"} {Math.abs(m.score - m.before)}</span>
                      {m.why && <span className="meta"> · {m.why}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {d.hotOpens.length > 0 && <><h3 className="meta" style={{ margin: "10px 0 4px" }}>Abiertos sin responder: buen momento para llamar</h3><List items={d.hotOpens} empty="" /></>}
            </section>
          )}

          <section className="panel" aria-label="Decisiones pendientes">
            <h2>Decide <span className="muted">{d.decisions.count}</span></h2>
            <List items={d.decisions.items} empty="No hay propuestas de la IA esperando." />
            {d.decisions.count > 0 && <Link href="/inbox" className="btn secondary small" style={{ marginTop: 10 }}>Abrir la bandeja</Link>}
          </section>
        </div>

        <div className="today-col">
          <section className="panel" aria-label="Agenda de hoy">
            <h2>Reuniones de hoy</h2>
            <List items={d.agenda} empty="Ninguna reunión hoy." showTime />
          </section>
          <section className="panel" aria-label="Tareas de hoy">
            <h2>Tareas de hoy <span className="muted">{d.tasks.length}</span></h2>
            <List items={d.tasks.slice(0, 6)} empty="Ninguna tarea para hoy." />
            {d.tasks.length > 6 && <Link href="/activities" className="meta">Ver las {d.tasks.length}</Link>}
          </section>
          <section className="panel" aria-label="Vencidas">
            <h2>Vencidas <span className="muted">{d.overdue.length}</span></h2>
            <List items={d.overdue} empty="Nada vencido." showDate />
          </section>
          <section className="panel" aria-label="Lo que hizo la IA">
            <h2>Lo que hizo la IA <span className="muted">últimas 24 h</span></h2>
            <List items={d.aiDone.items} empty="Nada en las últimas 24 horas." />
            {d.aiDone.count > d.aiDone.items.length && <Link href="/inbox?view=log" className="meta">Ver las {d.aiDone.count}</Link>}
          </section>
          <section className="panel" aria-label="Novedades">
            <h2>Novedades <span className="muted">últimas 24 h</span></h2>
            <List items={[...d.closed, ...d.leads.items]} empty="Sin leads nuevos ni cierres." />
            {d.leads.count > d.leads.items.length && <Link href="/leads" className="meta">Ver los {d.leads.count} leads</Link>}
          </section>
        </div>
      </div>
    </main>
  );
}
