import Link from "next/link";
import { buildDigest } from "@/lib/digest";
import { listUsers } from "@/lib/users";
import { sql } from "@/lib/db";
import { money } from "@/lib/format";
import { isId } from "@/lib/validation";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Hoy · versión B" };

// ===========================================================================
// Versión B de «Hoy»: la misma información, más visual. Es una propuesta para
// comparar con la home actual; no la sustituye.
// ===========================================================================

const TZ = process.env.TZ || "Europe/Madrid";
const time = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("es-ES", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d)) : "";
const compact = (n: number) =>
  new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: n >= 1_000_000 ? 1 : 0, style: "currency", currency: "EUR" }).format(n);
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** Línea de tendencia (SVG) con área suave. */
function Spark({ values, label }: { values: number[]; label: string }) {
  const w = 120, h = 36, max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * w, h - 3 - (v / max) * (h - 6)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <svg className="b-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path d={`${line}L${w},${h}L0,${h}Z`} className="area" />
      <path d={line} className="line" />
      {pts.length > 0 && <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.6" className="dot" />}
    </svg>
  );
}

/** Anillo de progreso. */
function Ring({ value, total, children }: { value: number; total: number; children: React.ReactNode }) {
  const r = 52, c = 2 * Math.PI * r, p = total ? Math.min(1, value / total) : 0;
  return (
    <div className="b-ring">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r={r} className="track" />
        {p > 0 && <circle cx="60" cy="60" r={r} className="fill" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 60 60)" />}
      </svg>
      <div className="b-ring-label">{children}</div>
    </div>
  );
}

function Delta({ now, before, suffix = "que el mes pasado" }: { now: number; before: number; suffix?: string }) {
  if (!before && !now) return <span className="b-delta flat">sin datos aún</span>;
  if (!before) return <span className="b-delta up">nuevo</span>;
  const d = Math.round(((now - before) / before) * 100);
  return <span className={`b-delta ${d > 0 ? "up" : d < 0 ? "down" : "flat"}`}>{d > 0 ? "▲" : d < 0 ? "▼" : "="} {Math.abs(d)} % {suffix}</span>;
}

const initials = (n: string) => n.split(/\s+/).map((x) => x[0]).slice(0, 2).join("").toUpperCase();

export default async function TodayB({ searchParams }: { searchParams: Promise<{ owner?: string }> }) {
  const sp = await searchParams;
  const ownerId = isId(sp.owner) ? sp.owner : null;
  const mine = (col: string) => (ownerId ? sql`${sql.unsafe(col)} = ${ownerId}` : sql`true`);

  const [users, d, [won], wonWeeks, actDays, [mail], [today], stages, board, recentWins] = await Promise.all([
    listUsers(),
    buildDigest(ownerId, { ai: "cached" }),
    sql<{ month: number; prev: number; n: number }[]>`
      SELECT coalesce(sum(value) FILTER (WHERE won_at >= date_trunc('month', now())), 0)::float8 AS month,
             coalesce(sum(value) FILTER (WHERE won_at >= date_trunc('month', now()) - interval '1 month' AND won_at < now() - interval '1 month'), 0)::float8 AS prev,
             count(*) FILTER (WHERE won_at >= date_trunc('month', now()))::int AS n
      FROM deals WHERE status = 'won' AND deleted_at IS NULL AND ${mine("owner_id")}`,
    sql<{ v: number }[]>`
      SELECT coalesce(sum(d.value), 0)::float8 AS v
      FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') w
      LEFT JOIN deals d ON d.status = 'won' AND d.deleted_at IS NULL AND d.won_at >= w AND d.won_at < w + interval '1 week' AND ${mine("d.owner_id")}
      GROUP BY w ORDER BY w`,
    sql<{ day: string; n: number }[]>`
      SELECT to_char(g, 'YYYY-MM-DD') AS day, count(a.id)::int AS n
      FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()) + interval '6 days', interval '1 day') g
      LEFT JOIN activities a ON a.done AND a.done_at >= g AND a.done_at < g + interval '1 day' AND ${mine("a.owner_id")}
      GROUP BY g ORDER BY g`,
    sql<{ sent: number; opened: number; replied: number }[]>`
      SELECT count(*)::int AS sent, count(*) FILTER (WHERE e.open_count > 0)::int AS opened,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM emails r WHERE r.direction = 'in' AND r.person_id = e.person_id AND r.sent_at > e.sent_at))::int AS replied
      FROM emails e WHERE e.direction = 'out' AND e.status = 'sent' AND e.track AND e.sent_at > now() - interval '30 days' AND ${mine("e.user_id")}`,
    sql<{ done: number; total: number }[]>`
      SELECT count(*) FILTER (WHERE done)::int AS done, count(*)::int AS total FROM activities
      WHERE due_at >= date_trunc('day', now()) AND due_at < date_trunc('day', now()) + interval '1 day' AND ${mine("owner_id")}`,
    sql<{ pipeline_id: string; pipeline: string; stage: string; n: number; v: number }[]>`
      SELECT p.id AS pipeline_id, p.name AS pipeline, s.name AS stage, count(d.id)::int AS n, coalesce(sum(d.value), 0)::float8 AS v
      FROM pipelines p JOIN stages s ON s.pipeline_id = p.id
      LEFT JOIN deals d ON d.stage_id = s.id AND d.status = 'open' AND d.deleted_at IS NULL AND ${mine("d.owner_id")}
      WHERE p.is_active GROUP BY p.id, p.name, p.position, s.id, s.name, s.position ORDER BY p.position, s.position`,
    sql<{ id: string; name: string; v: number; n: number }[]>`
      SELECT u.id, u.name, coalesce(sum(d.value), 0)::float8 AS v, count(d.id)::int AS n
      FROM users u LEFT JOIN deals d ON d.owner_id = u.id AND d.status = 'won' AND d.deleted_at IS NULL AND d.won_at >= date_trunc('month', now())
      WHERE u.is_active AND u.kind = 'human' GROUP BY u.id, u.name ORDER BY v DESC, n DESC, u.name LIMIT 6`,
    sql<{ id: string; title: string; value: number | null; currency: string; owner: string | null; won_at: Date }[]>`
      SELECT d.id, d.title, d.value::float8 AS value, d.currency, u.name AS owner, d.won_at FROM deals d LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.status = 'won' AND d.deleted_at IS NULL AND d.won_at > now() - interval '30 days' AND ${mine("d.owner_id")}
      ORDER BY d.won_at DESC LIMIT 4`,
  ]);

  const humans = users.filter((u) => u.kind === "human");
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const greeting = hour < 14 ? "Buenos días" : hour < 21 ? "Buenas tardes" : "Buenas noches";
  const dateLabel = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" }).format(new Date());
  const firstFocus = d.focus.split("\n")[0]?.replace(/^\d+\.\s*/, "") ?? "";

  // Pipelines con sus fases (el embudo).
  const pipes = Object.values(stages.reduce<Record<string, { id: string; name: string; stages: (typeof stages)[number][] }>>((acc, s) => {
    (acc[s.pipeline_id] ??= { id: s.pipeline_id, name: s.pipeline, stages: [] }).stages.push(s);
    return acc;
  }, {})).filter((p) => p.stages.some((s) => s.n > 0))
    .sort((a, b) => b.stages.reduce((x, s) => x + s.v, 0) - a.stages.reduce((x, s) => x + s.v, 0) || b.stages.reduce((x, s) => x + s.n, 0) - a.stages.reduce((x, s) => x + s.n, 0));
  const PIPES = 6;

  // Mapa de calor: 12 semanas × 7 días.
  const maxDay = Math.max(1, ...actDays.map((x) => x.n));
  const weeks = Array.from({ length: 12 }, (_, w) => actDays.slice(w * 7, w * 7 + 7));
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  const thisWeek = weeks[11]?.reduce((a, x) => a + x.n, 0) ?? 0, lastWeek = weeks[10]?.reduce((a, x) => a + x.n, 0) ?? 0;

  // Agenda en una línea de tiempo de 8:00 a 20:00.
  const tl = (at: Date | null | undefined) => {
    if (!at) return 0;
    const [hh, mm] = time(at).split(":").map(Number);
    return Math.min(100, Math.max(0, ((hh + mm / 60 - 8) / 12) * 100));
  };
  const nowPos = Math.min(100, Math.max(0, ((hour + new Date().getMinutes() / 60 - 8) / 12) * 100));
  const maxBoard = Math.max(1, ...board.map((b) => b.v));

  return (
    <main className="page b-home">
      <div className="b-switch">
        <span className="b-tag">Versión B · propuesta</span>
        <Link href={ownerId ? `/?owner=${ownerId}` : "/"} className="btn secondary small">Volver a la versión actual</Link>
      </div>

      {/* Cabecera */}
      <section className="b-hero">
        <div className="b-hero-text">
          <p className="b-date">{dateLabel}</p>
          <h1>{greeting}{d.ownerName ? `, ${d.ownerName.split(" ")[0]}` : ""}</h1>
          {firstFocus && <p className="b-focus"><Icon name="spark" />{firstFocus}</p>}
          <nav className="b-people" aria-label="Ver el panel de">
            <Link href="/b" aria-current={!ownerId ? "page" : undefined}>Equipo</Link>
            {humans.map((u) => (
              <Link key={u.id} href={`/b?owner=${u.id}`} aria-current={ownerId === u.id ? "page" : undefined} title={u.name}>
                <span className="b-av">{initials(u.name)}</span><span className="b-av-name">{u.name.split(" ")[0]}</span>
              </Link>
            ))}
          </nav>
        </div>
        <Ring value={today.done} total={today.total}>
          <strong>{today.done}<small>/{today.total}</small></strong>
          <span>hecho hoy</span>
        </Ring>
      </section>

      {/* Cifras clave */}
      <section className="b-kpis" aria-label="Cifras clave">
        <Link href="/pipelines" className="b-kpi k1">
          <span className="b-kpi-label"><Icon name="deals" />Pipeline abierto</span>
          <strong>{compact(d.pipeline.value)}</strong>
          <span className="meta">{d.pipeline.count} deals en juego</span>
        </Link>
        <Link href="/reports" className="b-kpi k2">
          <span className="b-kpi-label"><Icon name="rocket" />Ganado este mes</span>
          <strong>{compact(won.month)}</strong>
          <Delta now={won.month} before={won.prev} />
          <Spark values={wonWeeks.map((w) => w.v)} label="Ganado por semana, últimas 12 semanas" />
        </Link>
        <Link href="/activities" className="b-kpi k3">
          <span className="b-kpi-label"><Icon name="activities" />Actividades esta semana</span>
          <strong>{thisWeek}</strong>
          <Delta now={thisWeek} before={lastWeek} suffix="que la anterior" />
          <Spark values={weeks.map((w) => w.reduce((a, x) => a + x.n, 0))} label="Actividades hechas por semana" />
        </Link>
        <Link href="/emails" className="b-kpi k4">
          <span className="b-kpi-label"><Icon name="mail" />Correos (30 días)</span>
          <strong>{pct(mail.opened, mail.sent)} %<small> abiertos</small></strong>
          <span className="meta">{mail.sent} enviados · {pct(mail.replied, mail.sent)} % respondidos</span>
          <span className="b-bar2" aria-hidden="true"><i style={{ width: `${pct(mail.opened, mail.sent)}%` }} /><i className="r" style={{ width: `${pct(mail.replied, mail.sent)}%` }} /></span>
        </Link>
      </section>

      <div className="b-grid">
        {/* Agenda del día */}
        <section className="b-card b-day" aria-label="Tu día">
          <header><h2>Tu día</h2>
            <span className="b-chips">
              {d.overdue.length > 0 && <Link href="/activities?period=overdue" className="b-chip bad">{d.overdue.length} vencidas</Link>}
              <span className="b-chip">{d.agenda.length} reuniones</span>
              <span className="b-chip">{d.tasks.length} tareas</span>
            </span>
          </header>
          <div className="b-timeline" aria-hidden="true">
            {[8, 10, 12, 14, 16, 18, 20].map((h) => <span key={h} className="tick" style={{ left: `${((h - 8) / 12) * 100}%` }}>{h}h</span>)}
            {hour >= 8 && hour < 20 && <span className="now" style={{ left: `${nowPos}%` }} />}
            {d.agenda.map((a, i) => <span key={i} className="ev" style={{ left: `${tl(a.at)}%` }} title={`${time(a.at)} ${a.title}`} />)}
          </div>
          <ul className="b-agenda">
            {d.agenda.slice(0, 5).map((a, i) => (
              <li key={`a${i}`}><span className="t">{time(a.at)}</span><span className="pip meet" />
                <div>{a.href ? <Link href={a.href}>{a.title}</Link> : a.title}{a.detail && <div className="meta">{a.detail}</div>}</div></li>
            ))}
            {d.tasks.slice(0, Math.max(0, 6 - Math.min(5, d.agenda.length))).map((a, i) => (
              <li key={`t${i}`}><span className="t">tarea</span><span className="pip" />
                <div>{a.href ? <Link href={a.href}>{a.title}</Link> : a.title}{a.detail && <div className="meta">{a.detail}</div>}</div></li>
            ))}
            {d.agenda.length + d.tasks.length === 0 && <li className="b-empty">Agenda despejada. Buen día para abrir conversaciones nuevas.</li>}
          </ul>
          {d.decisions.count > 0 && (
            <Link href="/inbox" className="b-ai"><Icon name="spark" /><span><strong>{d.decisions.count}</strong> propuesta{d.decisions.count === 1 ? "" : "s"} de la IA esperan tu visto bueno</span><span className="go">→</span></Link>
          )}
        </section>

        {/* Deals calientes y que piden atención */}
        <section className="b-card b-hot" aria-label="Dónde poner el foco">
          <header><h2>Dónde poner el foco</h2><Link href="/" className="meta">Ver todo</Link></header>
          {d.hotOpens.length > 0 && (
            <>
              <h3><span className="flame" aria-hidden="true">●</span>Calientes ahora</h3>
              <ul className="b-hotlist">
                {d.hotOpens.slice(0, 3).map((h, i) => (
                  <li key={i}><Link href={h.href ?? "/emails"}>{h.title}</Link><div className="meta">{h.detail} · {time(h.at)}</div></li>
                ))}
              </ul>
            </>
          )}
          <h3><span className="warn" aria-hidden="true">●</span>Piden atención</h3>
          <ul className="b-attn">
            {d.attention.slice(0, 5).map((a) => (
              <li key={a.deal.id} className={a.step.priority === 1 ? "p1" : "p2"}>
                <Link href={`/deals/${a.deal.id}`}><strong>{a.deal.title}</strong><span className="v">{money(a.deal.value, a.deal.currency)}</span></Link>
                <div className="meta">{a.step.text}</div>
              </li>
            ))}
            {d.attention.length === 0 && <li className="b-empty">Ningún deal pide atención. 👌</li>}
          </ul>
        </section>

        {/* Embudo por pipeline */}
        <section className="b-card b-funnels" aria-label="Embudos">
          <header><h2>Embudo abierto</h2><Link href="/pipelines" className="meta">Abrir tablero</Link></header>
          {pipes.length === 0 && <p className="b-empty">Sin deals abiertos.</p>}
          <div className="b-funnel-wrap">
            {pipes.slice(0, PIPES).map((p, pi) => {
              const maxN = Math.max(1, ...p.stages.map((s) => s.n));
              return (
                <div key={p.id} className="b-funnel">
                  <Link href={`/pipelines/${p.id}`} className="b-funnel-name">{p.name}<span className="meta">{compact(p.stages.reduce((a, s) => a + s.v, 0))}</span></Link>
                  {p.stages.map((s, si) => (
                    <div key={si} className={s.n ? "b-stage" : "b-stage zero"} title={`${s.stage}: ${s.n} deals · ${money(s.v)}`}>
                      <span className="nm">{s.stage}</span>
                      <span className="bar"><i className={`s${(pi % 4) + 1}`} style={{ width: `${Math.max(s.n ? 6 : 0, (s.n / maxN) * 100)}%`, opacity: 0.55 + 0.45 * ((si + 1) / p.stages.length) }} /></span>
                      <span className="n">{s.n}</span>
                      <span className="v">{s.v ? compact(s.v) : ""}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {pipes.length > PIPES && <Link href="/pipelines" className="b-more">Ver los {pipes.length} pipelines →</Link>}
        </section>

        {/* Ritmo: mapa de calor */}
        <section className="b-card b-heat" aria-label="Ritmo de las últimas 12 semanas">
          <header><h2>Ritmo</h2><span className="meta">actividades hechas, últimas 12 semanas</span></header>
          <div className="b-heatmap" role="img" aria-label={`Actividades hechas por día. Esta semana: ${thisWeek}.`}>
            <div className="days" aria-hidden="true">{["L", "", "X", "", "V", "", "D"].map((x, i) => <span key={i}>{x}</span>)}</div>
            {weeks.map((w, wi) => (
              <div key={wi} className="col">
                {w.map((x) => {
                  const lvl = x.n === 0 ? 0 : Math.min(4, Math.ceil((x.n / maxDay) * 4));
                  return <span key={x.day} className={`c l${lvl}${x.day === todayKey ? " today" : ""}${x.day > todayKey ? " future" : ""}`} title={`${x.day}: ${x.n} actividades`} />;
                })}
              </div>
            ))}
          </div>
          <div className="b-legend" aria-hidden="true"><span>menos</span>{[0, 1, 2, 3, 4].map((l) => <span key={l} className={`c l${l}`} />)}<span>más</span></div>
        </section>

        {/* Ranking del mes */}
        <section className="b-card b-board" aria-label="Ganado este mes por persona">
          <header><h2>Ganado este mes</h2><span className="meta">{won.n} deal{won.n === 1 ? "" : "s"}</span></header>
          <ol className="b-podium">
            {board.map((b, i) => (
              <li key={b.id} className={ownerId === b.id ? "me" : undefined}>
                <span className={`pos p${i + 1}`}>{i + 1}</span>
                <span className="b-av">{initials(b.name)}</span>
                <span className="who">{b.name}<span className="bar"><i style={{ width: `${(b.v / maxBoard) * 100}%` }} /></span></span>
                <span className="v">{b.v ? compact(b.v) : "—"}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Últimas victorias */}
        <section className="b-card b-wins" aria-label="Últimas victorias">
          <header><h2>Últimas victorias</h2></header>
          {recentWins.length === 0 ? <p className="b-empty">Aún no hay victorias este mes. La primera está cerca.</p> : (
            <ul>
              {recentWins.map((w) => (
                <li key={w.id}>
                  <span className="trophy" aria-hidden="true"><Icon name="check" /></span>
                  <div><Link href={`/deals/${w.id}`}>{w.title}</Link><div className="meta">{w.owner ?? "Sin responsable"} · {new Intl.DateTimeFormat("es-ES", { timeZone: TZ, day: "numeric", month: "short" }).format(new Date(w.won_at))}</div></div>
                  <strong>{money(w.value, w.currency)}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
