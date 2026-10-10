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
import { ActionForm } from "@/components/ActionForm";
import { sql } from "@/lib/db";
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

  const pipelines = await sql<{ id: string; name: string; value: number; count: number }[]>`
    SELECT p.id, p.name, coalesce(sum(d.value), 0)::float8 AS value, count(d.id)::int AS count
    FROM pipelines p JOIN deals d ON d.pipeline_id = p.id AND d.status = 'open' AND d.deleted_at IS NULL
      AND (${ownerId}::uuid IS NULL OR d.owner_id = ${ownerId}::uuid)
    WHERE p.is_active GROUP BY p.id, p.name, p.position ORDER BY value DESC, p.position`;
  const maxPipe = Math.max(1, ...pipelines.map((p) => p.value));
  const todayCount = d.agenda.length + d.tasks.length;
  const pendingTotal = d.overdue.length + todayCount + d.attention.length;
  const SHOW = 5;

  return (
    <main className="page today">
      <div className="page-head">
        <div>
          <h1>{greeting}{d.ownerName ? `, ${d.ownerName}` : ""}</h1>
          <p className="muted" style={{ margin: 0, textTransform: "none" }}>
            {pendingTotal ? `Hoy, ${today}, tienes ${pendingTotal} cosa${pendingTotal === 1 ? "" : "s"} pendiente${pendingTotal === 1 ? "" : "s"}.` : `Hoy, ${today}. No tienes nada pendiente.`}
          </p>
        </div>
        <div className="head-actions">
          <nav className="chips" aria-label="Ver el parte de">
            <Link href="/" aria-current={!ownerId ? "page" : undefined}>Todo el equipo</Link>
            {humans.map((u) => <Link key={u.id} href={`/?owner=${u.id}`} aria-current={ownerId === u.id ? "page" : undefined}>{u.name}</Link>)}
          </nav>
        </div>
      </div>

      {/* Primera plana: lo que toca hoy y cómo va el pipeline. */}
      <div className="today-hero">
        <section className="hero-todo" aria-label="Lo que toca hoy">
          <header className="hero-head">
            <h2>Lo que toca hoy</h2>
            <nav className="hero-counts" aria-label="Resumen">
              <a href="#vencidas" className={d.overdue.length ? "bad" : ""}><strong>{d.overdue.length}</strong><span>vencidas</span></a>
              <a href="#hoy"><strong>{todayCount}</strong><span>para hoy</span></a>
              <a href="#atencion" className={d.attention.length ? "warn" : ""}><strong>{d.attention.length}</strong><span>deals con atención</span></a>
            </nav>
          </header>

          {d.decisions.count > 0 && (
            <Link href="/inbox" className="hero-decisions">
              <Icon name="spark" /><span><strong>La IA tiene {d.decisions.count} propuesta{d.decisions.count === 1 ? "" : "s"}</strong> esperando tu decisión</span><span className="go">Revisar →</span>
            </Link>
          )}

          {pendingTotal === 0 && (
            <div className="hero-empty"><strong>Todo al día.</strong><span className="muted">No hay nada vencido ni para hoy, y ningún deal pide atención. Buen momento para prospectar.</span></div>
          )}

          {d.overdue.length > 0 && (
            <div className="todo-group" id="vencidas">
              <h3>Vencidas <span className="muted">{d.overdue.length}</span></h3>
              <ul className="todo-list">
                {d.overdue.slice(0, SHOW).map((i, n) => (
                  <li key={n} className="todo bad">
                    <span className="todo-dot" aria-hidden="true" />
                    <div>{i.href ? <Link href={i.href}>{i.title}</Link> : i.title}
                      <div className="meta">{[i.detail, i.at ? `vencía ${dateTime(i.at)}` : null].filter(Boolean).join(" · ")}</div></div>
                  </li>
                ))}
              </ul>
              {d.overdue.length > SHOW && <Link href="/activities?period=overdue" className="todo-more">Ver las {d.overdue.length} vencidas</Link>}
            </div>
          )}

          {todayCount > 0 && (
            <div className="todo-group" id="hoy">
              <h3>Hoy <span className="muted">{todayCount}</span></h3>
              <ul className="todo-list">
                {d.agenda.map((i, n) => (
                  <li key={`a${n}`} className="todo"><span className="todo-time">{time(i.at)}</span>
                    <div>{i.href ? <Link href={i.href}>{i.title}</Link> : i.title}{i.detail && <div className="meta">{i.detail}</div>}</div></li>
                ))}
                {d.tasks.slice(0, SHOW).map((i, n) => (
                  <li key={`t${n}`} className="todo"><span className="todo-dot" aria-hidden="true" />
                    <div>{i.href ? <Link href={i.href}>{i.title}</Link> : i.title}{i.detail && <div className="meta">{i.detail}</div>}</div></li>
                ))}
              </ul>
              {d.tasks.length > SHOW && <Link href="/activities?period=today" className="todo-more">Ver las {d.tasks.length} tareas de hoy</Link>}
            </div>
          )}

          {d.attention.length > 0 && (
            <div className="todo-group" id="atencion">
              <h3>Deals que piden atención <span className="muted">{d.attention.length}</span></h3>
              <ul className="todo-list">
                {d.attention.slice(0, SHOW).map((a) => (
                  <li key={a.deal.id} className={`todo ${a.step.priority === 1 ? "bad" : "warn"}`}>
                    <span className="todo-dot" aria-hidden="true" />
                    <div>
                      <Link href={`/deals/${a.deal.id}`}><strong>{a.deal.title}</strong></Link> · {a.step.text}
                      <div className="meta">{[a.step.why, a.deal.stage_name, money(a.deal.value, a.deal.currency), !ownerId ? a.deal.owner_name : null].filter(Boolean).join(" · ")}</div>
                    </div>
                    <span className={`badge ${a.step.priority === 1 ? "lost" : "warn"}`}>{a.step.priority === 1 ? "Urgente" : "Esta semana"}</span>
                  </li>
                ))}
              </ul>
              {d.attention.length > SHOW && <a href="#mas-atencion" className="todo-more">Ver los {d.attention.length} deals</a>}
            </div>
          )}
        </section>

        <section className="hero-pipeline" aria-label="Pipeline abierto">
          <h2>Pipeline abierto</h2>
          <Link href="/pipelines" className="hero-total"><strong>{money(d.pipeline.value)}</strong><span className="meta">{d.pipeline.count} deals abiertos</span></Link>
          <ul className="pipe-list">
            {pipelines.map((p) => (
              <li key={p.id}>
                <Link href={`/pipelines/${p.id}`}>
                  <span className="pipe-name">{p.name}</span>
                  <span className="pipe-value">{money(p.value)}</span>
                  <span className="pipe-bar" aria-hidden="true"><i style={{ width: `${(p.value / maxPipe) * 100}%` }} /></span>
                  <span className="meta">{p.count} deal{p.count === 1 ? "" : "s"}</span>
                </Link>
              </li>
            ))}
            {pipelines.length === 0 && <li className="muted">Sin deals abiertos.</li>}
          </ul>
        </section>
      </div>

      {/* Lo demás, al hacer scroll. */}
      <h2 className="today-more-title">Para profundizar</h2>
      <section className="panel today-focus" aria-label="Enfoque del día">
        <div className="today-focus-head">
          <h2><Icon name="spark" />Enfoque del día</h2>
          <span className="meta">{d.focusSource === "ai" ? "Redactado por la IA" : "Según tus deals y tu agenda"}</span>
          <span className="spacer" />
          {aiReady(ai) && (
            <ActionForm action={refreshFocusAction.bind(null, ownerId)} submitLabel={d.focusSource === "ai" ? "Rehacer con IA" : "Redactar con IA"} pendingLabel="Redactando…" secondary className="form inline" />
          )}
          {conn && <ActionForm action={sendDigestNowAction.bind(null, ownerId!)} submitLabel="Enviármelo por correo" pendingLabel="Enviando…" secondary className="form inline" />}
        </div>
        <p className="today-focus-text">{d.focus}</p>
      </section>

      <div className="today-more">
        {d.attention.length > 0 && (
          <section className="panel" id="mas-atencion" aria-label="Deals que piden atención en detalle">
            <h2>Deals que piden atención, en detalle <span className="muted">{d.attention.length}</span></h2>
            <ol className="attention">
              {d.attention.map((a, i) => (
                <li key={a.deal.id} className={`p${a.step.priority}`}>
                  <div className="attention-main">
                    <Link href={`/deals/${a.deal.id}`} className="attention-title">{a.deal.title}</Link>
                    <span className="meta">{[a.deal.organization_name, a.deal.stage_name, money(a.deal.value, a.deal.currency), a.deal.owner_name].filter(Boolean).join(" · ")}</span>
                    <div className="attention-step"><strong>{a.step.text}</strong> <span className="muted">{a.step.why}</span></div>
                    {i === 0 && top && (
                      <details className="brief-why">
                        <summary>Resumen del deal</summary>
                        <div className="attention-brief">
                          <p>{top.resumen}</p>
                          {top.riesgos.length > 0 && <ul>{top.riesgos.map((r) => <li key={r}>{r}</li>)}</ul>}
                        </div>
                      </details>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
        <div className="today-col">
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
          <section className="panel" aria-label="Lo que hizo la IA">
            <h2>Lo que hizo la IA <span className="muted">últimas 24 h</span></h2>
            {d.agents.length > 0 && <p className="meta" style={{ marginTop: 0 }}>{d.agents.map((a) => `${a.name}: ${a.done}${a.pending ? ` (+${a.pending} por decidir)` : ""}`).join(" · ")} · <Link href="/agents">Ver agentes</Link></p>}
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
