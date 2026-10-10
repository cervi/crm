import Link from "next/link";
import { deleteGoalAction, saveAnswerAction, saveGoalAction } from "@/app/actions/reports";
import { ActionForm } from "@/components/ActionForm";
import { WidgetView } from "@/components/charts/WidgetView";
import { aiReady, getAiSettings } from "@/lib/ai";
import { listDashboards } from "@/lib/analytics";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/format";
import { listPipelines } from "@/lib/pipelines";
import { DEAL_TYPE_LABEL, ORIGIN_LABEL } from "@/lib/deal-types";
import { ask, attribution, revenueMix, forecast, funnel, GOAL_METRICS, goalsProgress, velocity, type Answer } from "@/lib/reports";
import { listUsers } from "@/lib/users";
import { isId } from "@/lib/validation";
import { toUserMessage } from "@/lib/errors";
import { salesAnalytics, SEGMENTS, type Grain, type Segment } from "@/lib/sales-analytics";
import { GroupedBars, HBars, Lines, StackedBars } from "@/components/charts/SalesCharts";

export const dynamic = "force-dynamic";
export const metadata = { title: "Informes" };

const monthLabel = (m: string | null) => {
  if (m === null) return "Sin fecha de cierre";
  if (m === "vencido") return "Fecha ya pasada";
  const [y, mo] = m.split("-").map(Number);
  const s = new Intl.DateTimeFormat("es-ES", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, mo - 1, 1)));
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const pct = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)} %`);
const fmtGoal = (metric: keyof typeof GOAL_METRICS, n: number) => (GOAL_METRICS[metric].money ? money(n) : Math.round(n).toLocaleString("es-ES"));

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ pipeline?: string; owner?: string; q?: string; g?: string; seg?: string }> }) {
  const [sp, me] = await Promise.all([searchParams, requireUser()]);
  const [pipelines, users, ai, dashboards] = await Promise.all([listPipelines(), listUsers(), getAiSettings(), listDashboards()]);
  const active = pipelines.filter((p) => p.is_active);
  const pipelineId = isId(sp.pipeline) ? sp.pipeline : null;
  const ownerId = isId(sp.owner) ? sp.owner : null;
  const funnelPipeline = pipelineId ?? active[0]?.id ?? null;
  const grain: Grain = sp.g === "quarter" ? "quarter" : "month";
  const segment: Segment = (Object.keys(SEGMENTS) as Segment[]).includes(sp.seg as Segment) ? (sp.seg as Segment) : "none";
  const [fc, vel, goals, fun, attr, mix, sa] = await Promise.all([
    forecast({ pipelineId, ownerId }), velocity(pipelineId), goalsProgress(), funnelPipeline ? funnel(funnelPipeline) : null, attribution(365), revenueMix(365),
    salesAnalytics({ grain, segment, pipelineId, ownerId }),
  ]);
  const link = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ pipeline: pipelineId, owner: ownerId, g: grain === "month" ? null : grain, seg: segment === "none" ? null : segment, ...patch })) if (v) q.set(k, v);
    return `/reports${q.size ? `?${q}` : ""}#ventas`;
  };
  const range = grain === "month" ? "últimos 12 meses" : "últimos 8 trimestres";
  const delta = sa.totals.prevWon ? (sa.totals.won - sa.totals.prevWon) / sa.totals.prevWon : null;
  let answer: Answer | null = null, askError: string | null = null;
  if (sp.q) {
    try { answer = await ask(sp.q); } catch (err) { askError = toUserMessage(err); }
  }
  const openTotal = fc.months.reduce((n, r) => n + r.value, 0);
  const weightedTotal = fc.months.reduce((n, r) => n + r.weighted, 0);
  const maxReached = Math.max(1, ...(fun?.stages.map((s) => s.reached) ?? [1]));
  const humans = users.filter((u) => u.kind === "human");

  return (
    <main className="page reports">
      <div className="page-head">
        <h1>Informes</h1>
        <span className="spacer" />
        <form method="get" className="toolbar" style={{ margin: 0 }}>
          <select name="pipeline" defaultValue={pipelineId ?? ""} aria-label="Pipeline">
            <option value="">Todos los pipelines</option>
            {active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select name="owner" defaultValue={ownerId ?? ""} aria-label="Responsable">
            <option value="">Todo el equipo</option>
            {humans.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <button className="btn secondary">Ver</button>
        </form>
        <Link href="/dashboards" className="btn secondary">Dashboards</Link>
      </div>

      <section className="panel ask-panel">
        <h2>Pregunta a tus datos</h2>
        <form method="get" className="ask-form">
          {pipelineId && <input type="hidden" name="pipeline" value={pipelineId} />}
          <input name="q" defaultValue={sp.q ?? ""} placeholder="¿Cuánto hemos ganado este trimestre por origen? ¿Quién tiene más deals abiertos?"
                 aria-label="Tu pregunta" disabled={!aiReady(ai)} />
          <button type="submit" className="btn" disabled={!aiReady(ai)}>Preguntar</button>
        </form>
        {!aiReady(ai) && <p className="meta">Para preguntar, configura el modelo de IA en <Link href="/settings/ai">Ajustes → Modelo de IA</Link>.</p>}
        {askError && <p className="form-error" role="alert">{askError}</p>}
        {answer && (
          <div className="answer">
            <h3>{answer.title}</h3>
            <WidgetView result={answer.result} chart={answer.config.chart} />
            {dashboards.length > 0 && me.role !== "viewer" && (
              <ActionForm action={saveAnswerAction} submitLabel="Guardar en el dashboard" secondary className="form inline">
                <input type="hidden" name="title" value={answer.title} />
                <input type="hidden" name="width" value="1" />
                <input type="hidden" name="config" value={JSON.stringify(answer.config)} />
                <label className="field"><span className="label">Dashboard</span>
                  <select name="dashboard_id" defaultValue={dashboards[0].id}>
                    {dashboards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select></label>
              </ActionForm>
            )}
          </div>
        )}
      </section>


      <div className="kpis">
        <div className="kpi"><span className="meta">Ganado este mes</span><strong>{money(fc.wonThisMonth.value)}</strong><span className="meta">{fc.wonThisMonth.deals} deals</span></div>
        <div className="kpi"><span className="meta">Pipeline abierto</span><strong>{money(openTotal)}</strong><span className="meta">{fc.months.reduce((n, r) => n + r.deals, 0)} deals</span></div>
        <div className="kpi"><span className="meta">Previsión ponderada</span><strong>{money(weightedTotal)}</strong><span className="meta">importe × probabilidad de su fase</span></div>
        <div className="kpi"><span className="meta">Velocidad de ventas</span><strong>{vel.perMonth === null ? "—" : `${money(vel.perMonth)}/mes`}</strong>
          <span className="meta">cierre {pct(vel.win_rate)} · ciclo {vel.cycle === null ? "—" : `${Math.round(vel.cycle)} días`}</span></div>
      </div>

      <div className="sales-head" id="ventas">
        <div>
          <h2>Análisis de ventas</h2>
          <p className="meta">{range}{pipelineId ? ` · ${active.find((p) => p.id === pipelineId)?.name}` : ""}{ownerId ? ` · ${humans.find((u) => u.id === ownerId)?.name}` : ""}. Pasa el ratón por los gráficos para ver el detalle.</p>
        </div>
        <div className="sales-filters">
          <nav className="seg-links" aria-label="Agrupar por">
            <Link href={link({ g: null })} aria-current={grain === "month" ? "page" : undefined}>Por mes</Link>
            <Link href={link({ g: "quarter" })} aria-current={grain === "quarter" ? "page" : undefined}>Por trimestre</Link>
          </nav>
          <nav className="seg-links" aria-label="Segmentar por">
            {(Object.entries(SEGMENTS) as [Segment, string][]).map(([k, l]) => (
              <Link key={k} href={link({ seg: k === "none" ? null : k })} aria-current={segment === k ? "page" : undefined}>{k === "none" ? "Total" : l}</Link>
            ))}
          </nav>
        </div>
      </div>

      <div className="kpis sales-kpis">
        <div className="kpi"><span className="meta">Ganado</span><strong>{money(sa.totals.won)}</strong>
          <span className="meta">{sa.totals.wonCount} deals{delta !== null && <> · <span className={`delta ${delta >= 0 ? "tone-good" : "tone-bad"}`}>{delta >= 0 ? "▲" : "▼"} {Math.abs(Math.round(delta * 100))} %</span> vs. periodo anterior</>}</span></div>
        <div className="kpi"><span className="meta">Pipeline creado</span><strong>{money(sa.totals.created)}</strong><span className="meta">importe de los deals nuevos</span></div>
        <div className="kpi"><span className="meta">Tasa de cierre</span><strong>{pct(sa.totals.winRate)}</strong><span className="meta">ganados ÷ (ganados + perdidos)</span></div>
        <div className="kpi"><span className="meta">Ticket medio</span><strong>{sa.totals.avgDeal === null ? "—" : money(sa.totals.avgDeal)}</strong><span className="meta">por deal ganado</span></div>
        <div className="kpi"><span className="meta">Ciclo de venta</span><strong>{sa.totals.cycle === null ? "—" : `${Math.round(sa.totals.cycle)} días`}</strong><span className="meta">de crear a ganar</span></div>
      </div>

      <div className="charts-grid">
        <section className="chart-card wide" aria-label="Ingresos ganados">
          <h3>Ingresos ganados{segment !== "none" && <span className="muted"> · por {SEGMENTS[segment].toLowerCase()}</span>}</h3>
          <p className="chart-sub">Importe de los deals ganados en cada {grain === "month" ? "mes" : "trimestre"}.</p>
          <StackedBars periods={sa.periods} series={sa.wonValue} f="money" />
        </section>
        <section className="chart-card" aria-label="Nuevo pipeline">
          <h3>Nuevo pipeline creado{segment !== "none" && <span className="muted"> · por {SEGMENTS[segment].toLowerCase()}</span>}</h3>
          <p className="chart-sub">Importe de los deals que se crearon en cada periodo.</p>
          <StackedBars periods={sa.periods} series={sa.createdValue} f="money" />
        </section>
        <section className="chart-card" aria-label="Ganados y perdidos">
          <h3>Ganados y perdidos</h3>
          <p className="chart-sub">Número de deals cerrados en cada periodo.</p>
          <GroupedBars periods={sa.periods} f="number" series={[
            { key: "won", label: "Ganados", values: sa.wonCount, color: "var(--good)" },
            { key: "lost", label: "Perdidos", values: sa.lostCount, color: "var(--bad)" },
          ]} />
        </section>
        <section className="chart-card" aria-label="Tasa de cierre">
          <h3>Tasa de cierre</h3>
          <p className="chart-sub">De los deals cerrados en el periodo, qué parte se ganó.</p>
          <Lines periods={sa.periods} f="percent" maxValue={1} series={[{ key: "wr", label: "Tasa de cierre", values: sa.winRate }]} />
        </section>
        <section className="chart-card" aria-label="Ticket medio">
          <h3>Ticket medio</h3>
          <p className="chart-sub">Importe medio de los deals ganados.</p>
          <Lines periods={sa.periods} f="money" series={[{ key: "avg", label: "Ticket medio", values: sa.avgDeal }]} />
        </section>
        <section className="chart-card" aria-label="Ciclo de venta">
          <h3>Ciclo de venta</h3>
          <p className="chart-sub">Días medios desde que se crea el deal hasta que se gana.</p>
          <Lines periods={sa.periods} f="days" series={[{ key: "cycle", label: "Días hasta ganar", values: sa.cycleDays }]} />
        </section>
        <section className="chart-card" aria-label="Actividad del equipo">
          <h3>Actividad hecha</h3>
          <p className="chart-sub">Llamadas, reuniones, correos… completados en cada periodo.</p>
          <StackedBars periods={sa.periods} series={sa.activities} f="number" />
        </section>
        <section className="chart-card" aria-label="Motivos de pérdida">
          <h3>Motivos de pérdida</h3>
          <p className="chart-sub">Deals perdidos en los {range}, por motivo.</p>
          <div className="hbars-wrap lost"><HBars f="number" rows={sa.lostReasons.map((r) => ({ label: r.label, value: r.n, note: money(r.value) }))} /></div>
        </section>
        {segment !== "none" && (
          <section className="chart-card" aria-label={`Comparativa por ${SEGMENTS[segment].toLowerCase()}`}>
            <h3>Comparativa por {SEGMENTS[segment].toLowerCase()}</h3>
            <p className="chart-sub">Ganado en los {range}, tasa de cierre y pipeline abierto hoy.</p>
            <HBars f="money" rows={sa.bySegment.map((r) => ({ label: r.label, value: r.won, note: `${pct(r.winRate)} cierre` }))} />
            <div className="table-wrap">
              <table className="seg-table">
                <thead><tr><th>{SEGMENTS[segment]}</th><th className="num">Ganado</th><th className="num">Deals</th><th className="num">Cierre</th><th className="num">Abierto</th></tr></thead>
                <tbody>{sa.bySegment.map((r) => (
                  <tr key={r.label}><td>{r.label}</td><td className="num">{money(r.won)}</td><td className="num">{r.wonCount}</td><td className="num">{pct(r.winRate)}</td><td className="num">{money(r.open)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        )}
      </div>

      <h2 className="sales-head" style={{ margin: "36px 0 0" }}>Previsión y objetivos</h2>
      <div className="grid-2 reports-grid">
        <section className="panel">
          <h2>Previsión por mes de cierre</h2>
          <table>
            <thead><tr><th>Mes</th><th className="num">Deals</th><th className="num">Importe</th><th className="num">Ponderado</th></tr></thead>
            <tbody>
              {fc.months.length === 0 && <tr><td colSpan={4} className="empty-row">No hay deals abiertos.</td></tr>}
              {fc.months.map((r) => (
                <tr key={r.month ?? "none"} className={r.month === "vencido" ? "tone-bad" : undefined}>
                  <td>{monthLabel(r.month)}</td><td className="num">{r.deals}</td><td className="num">{money(r.value)}</td><td className="num">{money(r.weighted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="meta">La probabilidad de cada fase se ajusta en Ajustes → Pipelines y fases.</p>
        </section>

        <section className="panel">
          <h2>Previsión por responsable</h2>
          <table>
            <thead><tr><th>Responsable</th><th className="num">Deals</th><th className="num">Importe</th><th className="num">Ponderado</th></tr></thead>
            <tbody>
              {fc.byOwner.map((r) => (
                <tr key={r.owner}><td>{r.owner}</td><td className="num">{r.deals}</td><td className="num">{money(r.value)}</td><td className="num">{money(r.weighted)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section className="panel">
        <h2>Objetivos</h2>
        {goals.length === 0 && <p className="muted">Sin objetivos todavía.</p>}
        <ul className="goals">
          {goals.map((g) => {
            const ratio = g.actual / g.target;
            const onTrack = g.actual >= g.expected;
            return (
              <li key={g.id}>
                <div className="goal-head">
                  <strong>{g.user_name ?? "Equipo"} · {GOAL_METRICS[g.metric].label}{g.pipeline_name ? ` (${g.pipeline_name})` : ""}</strong>
                  <span className="meta">{g.period === "month" ? "este mes" : "este trimestre"}</span>
                  <span className="spacer" />
                  <span>{fmtGoal(g.metric, g.actual)} de {fmtGoal(g.metric, g.target)} · {Math.round(ratio * 100)} %</span>
                  {me.role === "admin" && <form action={deleteGoalAction.bind(null, g.id)}><button type="submit" className="link-btn" aria-label="Quitar objetivo">Quitar</button></form>}
                </div>
                <div className="goal-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, ratio) * 100)}>
                  <span className={onTrack ? "good" : "behind"} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                  <i style={{ left: `${Math.min(100, (g.expected / g.target) * 100)}%` }} title="Lo que tocaría llevar a estas alturas" />
                </div>
                <span className="meta">{onTrack ? "Al ritmo" : `Por debajo del ritmo: tocaría llevar ${fmtGoal(g.metric, g.expected)}`}</span>
              </li>
            );
          })}
        </ul>
        {me.role === "admin" && (
          <details>
            <summary className="meta">+ Añadir objetivo</summary>
            <ActionForm action={saveGoalAction} submitLabel="Añadir" resetOnSuccess className="form inline">
              <label className="field"><span className="label">Quién</span>
                <select name="user_id" defaultValue=""><option value="">Equipo</option>{humans.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
              <label className="field"><span className="label">Qué</span>
                <select name="metric">{Object.entries(GOAL_METRICS).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}</select></label>
              <label className="field"><span className="label">Periodo</span>
                <select name="period"><option value="month">Mes</option><option value="quarter">Trimestre</option></select></label>
              <label className="field"><span className="label">Objetivo</span><input name="target" type="number" min={1} step="any" required /></label>
              <label className="field"><span className="label">Pipeline</span>
                <select name="pipeline_id" defaultValue=""><option value="">Todos</option>{active.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            </ActionForm>
          </details>
        )}
      </section>

      {fun && (
        <section className="panel">
          <h2>Embudo · {active.find((p) => p.id === funnelPipeline)?.name} <span className="muted">deals creados en los últimos 12 meses</span></h2>
          <p className="meta">{fun.total} deals · {fun.won} ganados · {fun.lost} perdidos · tasa de cierre {pct(fun.won + fun.lost ? fun.won / (fun.won + fun.lost) : null)}</p>
          <ol className="funnel">
            {fun.stages.map((s) => (
              <li key={s.id}>
                <span className="funnel-name">{s.name}{s.probability !== null && <span className="meta"> · {s.probability} %</span>}</span>
                <span className="funnel-bar"><span style={{ width: `${(s.reached / maxReached) * 100}%` }} /><b>{s.reached}</b></span>
                <span className="meta">{[s.conversion === null ? null : `${pct(s.conversion)} pasa a la siguiente`,
                                         s.avg_days === null ? null : `${Math.round(s.avg_days)} días de media`].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="panel" aria-label="Nuevo negocio y expansión">
        <h2>Nuevo negocio, expansión y renovaciones <span className="muted">ganado en 12 meses · abierto ahora</span></h2>
        {mix.length === 0 ? <p className="muted">Todavía no hay datos.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Tipo</th><th>Lo trajo</th><th className="num">Ganados</th><th className="num">Importe ganado</th><th className="num">Abiertos</th><th className="num">Importe abierto</th></tr></thead>
              <tbody>
                {mix.map((r) => (
                  <tr key={`${r.deal_type}|${r.origin}`}>
                    <td>{DEAL_TYPE_LABEL[r.deal_type as keyof typeof DEAL_TYPE_LABEL] ?? r.deal_type}</td><td>{ORIGIN_LABEL[r.origin as keyof typeof ORIGIN_LABEL] ?? r.origin}</td>
                    <td className="num">{r.won}</td><td className="num">{money(r.won_value)}</td><td className="num">{r.open}</td><td className="num">{money(r.open_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-label="Atribución">
        <h2>Atribución <span className="muted">últimos 12 meses · qué canal trae deals ganados, no solo leads</span></h2>
        {attr.length === 0 ? <p className="muted">Todavía no hay datos.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Origen</th><th>Campaña (utm_campaign)</th><th className="num">Leads</th><th className="num">Deals</th><th className="num">Ganados</th><th className="num">Importe ganado</th><th className="num">Tasa de cierre</th></tr></thead>
              <tbody>
                {attr.map((r) => (
                  <tr key={`${r.source}|${r.campaign ?? ""}`}>
                    <td>{r.source}</td><td>{r.campaign ?? "—"}</td><td className="num">{r.leads}</td><td className="num">{r.deals}</td>
                    <td className="num">{r.won}</td><td className="num">{money(r.won_value)}</td>
                    <td className="num">{pct(r.won + r.lost ? r.won / (r.won + r.lost) : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
