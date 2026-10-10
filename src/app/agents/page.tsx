import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { AGENT_INFO, AGENT_KEYS, listJobs } from "@/lib/agent-jobs";
import { actionLabel, effectiveAutonomy, getSettings, listPermissions, listRules, ruleAction, ruleStats } from "@/lib/automations";
import { hasActiveMailbox } from "@/lib/mailbox";
import { listInstructions } from "@/lib/stage-agents";
import { aiReady, aiSpend, getAiSettings } from "@/lib/ai";
import { dateTime } from "@/lib/format";
import { AutonomyPicker } from "@/components/ai/AutonomyPicker";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { runNowAction, setAgentAutonomyAction, setPausedAction, setRuleAutonomyAction } from "@/app/actions/automations";
import { saveAgentLimitsAction, setJobEnabledAction } from "@/app/actions/agent-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agentes" };

const eur = (n: number) => `${n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Panel del «jefe de agentes»: qué hace cada agente, con qué autonomía, cuánto gasta y lo último que ha hecho. */
export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ ver?: string }> }) {
  const { ver } = await searchParams;
  const me = await requireUser();
  const admin = me.role === "admin";
  const [rules, permissions, jobs, stats, settings, mailbox, spend, ai, [limits], recent] = await Promise.all([
    listRules(), listPermissions(), listJobs(), ruleStats(), getSettings(), hasActiveMailbox(), aiSpend(), getAiSettings(),
    sql<{ price_in: string; price_out: string; per_contact: number }[]>`
      SELECT a.price_in::text, a.price_out::text, (SELECT agent_emails_per_contact_day FROM app_settings LIMIT 1) AS per_contact FROM ai_settings a`,
    sql<{ id: string; agent: string | null; title: string; status: string; mode: string; deal_id: string | null; at: Date }[]>`
      SELECT x.id, r.agent, x.title, x.status, x.mode, x.deal_id, coalesce(x.executed_at, x.decided_at, x.created_at) AS at
      FROM automation_actions x JOIN automation_rules r ON r.id = x.rule_id
      WHERE r.agent IS NOT NULL AND x.created_at > now() - interval '30 days'
      ORDER BY coalesce(x.executed_at, x.decided_at, x.created_at) DESC LIMIT 300`,
  ]);
  const instructions = await listInstructions({ all: true });
  const pipelines = await sql<{ id: string; name: string }[]>`SELECT id, name FROM pipelines ORDER BY position, name`;
  const used = spend.budget ? Math.min(100, Math.round((spend.month / spend.budget) * 100)) : null;

  const pendingAll = recent.filter((r) => r.status === "pending").length;
  const agentData = AGENT_KEYS.map((key) => {
    const own = rules.filter((r) => r.agent === key && !r.instruction_id);
    const ownJobs = jobs.filter((j) => j.agent === key);
    const s = own.map((r) => stats.get(r.id)).filter(Boolean);
    return {
      key, info: AGENT_INFO[key], own, ownJobs, acts: recent.filter((r) => r.agent === key),
      decided: s.reduce((n, x) => n + x!.decided, 0), approved: s.reduce((n, x) => n + x!.approved, 0),
      auto: s.reduce((n, x) => n + x!.auto_done, 0), pending: s.reduce((n, x) => n + x!.pending, 0),
      on: own.filter((r) => r.autonomy !== "off").length + ownJobs.filter((j) => j.enabled).length,
      total: own.length + ownJobs.length,
      solo: own.some((r) => r.autonomy === "auto"),
    };
  });
  const view = ver === "instrucciones" || ver === "limites" ? ver : (AGENT_KEYS as string[]).includes(ver ?? "") ? ver! : "captacion";
  const cur = agentData.find((a) => a.key === view);
  const levelName = (a: string) => (a === "off" ? "No" : a === "ask" ? "Preguntar" : "Sola");
  const statusLabel = (a: (typeof agentData)[number]) => a.on === 0 ? "Apagado" : a.solo ? "Actúa solo en parte" : "Te pregunta";

  return (
    <main className="page agents-page">
      <div className="page-head">
        <div>
          <h1>Agentes</h1>
          <p className="muted" style={{ margin: 0 }}>
            Seis agentes cubren el ciclo entero. Cada uno propone o hace según la autonomía que le des; todo queda en la <Link href="/inbox">bandeja</Link> y se puede deshacer.
          </p>
        </div>
        <div className="head-actions">
          {!settings.paused && <ActionForm action={runNowAction} submitLabel="Revisar ahora" pendingLabel="Revisando…" secondary className="form inline" />}
          {admin && (
            <form action={setPausedAction.bind(null, !settings.paused)}>
              <button type="submit" className={settings.paused ? "btn" : "btn secondary"}>{settings.paused ? "Reanudar a los agentes" : "Pausar a todos"}</button>
            </form>
          )}
        </div>
      </div>

      <section className="boss-strip" aria-label="Jefe de agentes">
        <div className="boss-cell main">
          <h2><Icon name="spark" />Jefe de agentes</h2>
          <span className={settings.paused ? "boss-state off" : "boss-state on"}>{settings.paused ? "Todos en pausa" : "Trabajando"}</span>
          <span className="meta" title={`Reparte el trabajo, evita que dos agentes escriban al mismo contacto el mismo día (como mucho ${limits?.per_contact ?? 1} al día) y resume cada mañana lo hecho en el parte del día.`}>
            {settings.paused ? "No proponen ni hacen nada nuevo" : `Última revisión: ${settings.last_run_at ? dateTime(settings.last_run_at) : "nunca"}`} <Icon name="info" />
          </span>
        </div>
        <Link href="/inbox" className="boss-cell"><span className="label">Esperando tu decisión</span><strong className={pendingAll ? "tone-warn" : undefined}>{pendingAll}</strong></Link>
        <div className="boss-cell"><span className="label">Hechas solas · 90 días</span><strong>{agentData.reduce((n, a) => n + a.auto, 0)}</strong></div>
        <div className="boss-cell">
          <span className="label">IA este mes</span>
          <strong>{eur(spend.month)}</strong>
          <span className="meta">{spend.budget !== null ? `de ${eur(spend.budget)}` : "sin presupuesto"}{!aiReady(ai) ? " · IA sin configurar" : ""}</span>
          {used !== null && <div className={`meter ${used >= 100 ? "bad" : used >= 80 ? "warn" : ""}`}><i style={{ width: `${used}%` }} /></div>}
        </div>
      </section>

      <div className="agents-layout">
        <nav className="stage-rail agent-rail" aria-label="Agentes">
          <span className="rail-group">Agentes</span>
          {agentData.map((a) => (
            <Link key={a.key} href={`/agents?ver=${a.key}`} scroll={false} aria-current={view === a.key ? "page" : undefined}
                  className={`rail-item${a.on ? " has" : ""}`} title={statusLabel(a)}>
              <span className={`rail-dot ${a.on === 0 ? "off" : a.solo ? "auto" : "ask"}`} />
              <span className="rail-name"><strong>{a.info.name}</strong><span className="meta">{a.on} de {a.total} activas</span></span>
              {a.pending > 0 && <span className="rail-badge ask" title="Propuestas esperando tu decisión">{a.pending}</span>}
            </Link>
          ))}
          <span className="rail-group">Configuración</span>
          <Link href="/agents?ver=instrucciones" scroll={false} aria-current={view === "instrucciones" ? "page" : undefined} className="rail-item">
            <span className="rail-n"><Icon name="board" /></span>
            <span className="rail-name"><strong>Instrucciones por fase</strong><span className="meta">{instructions.length} en {new Set(instructions.map((i) => i.pipeline_id)).size} pipeline{new Set(instructions.map((i) => i.pipeline_id)).size === 1 ? "" : "s"}</span></span>
          </Link>
          {admin && (
            <Link href="/agents?ver=limites" scroll={false} aria-current={view === "limites" ? "page" : undefined} className="rail-item">
              <span className="rail-n"><Icon name="target" /></span>
              <span className="rail-name"><strong>Límites</strong><span className="meta">Presupuesto y topes</span></span>
            </Link>
          )}
        </nav>

        <div className="stage-detail">
          {cur && (
            <article className="agent-detail" aria-label={`Agente ${cur.info.name}`}>
              <header className="stage-detail-head">
                <div>
                  <span className="meta">{cur.info.goal}</span>
                  <h2>{cur.info.name}</h2>
                </div>
                <div className="stage-facts">
                  <span title="Últimos 90 días"><strong>{cur.auto}</strong> hechas solas</span>
                  <span title="Últimos 90 días"><strong>{cur.approved}</strong> de {cur.decided} aprobadas</span>
                  {cur.pending > 0 && <Link href="/inbox"><span className="fact-warn"><strong>{cur.pending}</strong> pendientes</span></Link>}
                  <span>IA <strong>{eur(spend.byAgent[cur.key] ?? 0)}</strong>{spend.agentBudgets[cur.key] !== undefined ? ` de ${eur(spend.agentBudgets[cur.key]!)}` : ""}</span>
                </div>
              </header>

              {cur.own.length > 0 && (
                <section className="agent-block" aria-label="Qué puede hacer">
                  <div className="agent-block-head">
                    <div>
                      <h3>Qué puede hacer</h3>
                      <p className="meta">Para cada cosa, elige si no lo hace, te pregunta antes o lo hace solo.</p>
                    </div>
                    {admin && (
                      <div className="bulk-levels" role="group" aria-label="Poner todo en">
                        <span className="meta">Todo en:</span>
                        {(["off", "ask", "auto"] as const).map((lv) => (
                          <form key={lv} action={setAgentAutonomyAction.bind(null, cur.key, lv)}>
                            <button type="submit" className="btn small secondary">{levelName(lv)}</button>
                          </form>
                        ))}
                      </div>
                    )}
                  </div>
                  {Object.entries(cur.own.reduce<Record<string, typeof cur.own>>((g, r) => { (g[actionLabel(ruleAction(r)!)] ??= []).push(r); return g; }, {})).map(([group, list]) => (
                    <div key={group} className="agent-group">
                      <h4>{group} <span className="muted">{list!.length}</span></h4>
                      <ul className="agent-rules">
                        {list!.map((r) => {
                          const eff = effectiveAutonomy(r, permissions, { mailbox });
                          const st = stats.get(r.id);
                          return (
                            <li key={r.id}>
                              <div>
                                <strong title={r.description ?? undefined}>{r.name}</strong>
                                <div className="meta">
                                  {st && (st.auto_done || st.decided) ? `${st.auto_done} solas · ${st.approved}/${st.decided} aprobadas` : "Sin actividad todavía"}
                                  {eff !== r.autonomy ? ` · limitada a «${levelName(eff)}» por los permisos` : ""}
                                </div>
                              </div>
                              {admin
                                ? <AutonomyPicker label={`Autonomía: ${r.name}`} value={r.autonomy} allowed={r.allowed_autonomy} action={setRuleAutonomyAction.bind(null, r.id)} />
                                : <span className="badge">{levelName(r.autonomy)}</span>}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </section>
              )}

              {cur.ownJobs.length > 0 && (
                <section className="agent-block" aria-label="Trabajos automáticos">
                  <div className="agent-block-head">
                    <div>
                      <h3>Trabajos automáticos</h3>
                      <p className="meta">Tareas de fondo que no tocan a los contactos: preparan, ordenan o enriquecen datos.</p>
                    </div>
                  </div>
                  <ul className="agent-rules">
                    {cur.ownJobs.map((j) => (
                      <li key={j.key}>
                        <div>
                          <strong title={j.description}>{j.name}</strong>
                          <div className="meta">{j.last_run_at ? `Última vez ${dateTime(j.last_run_at)}${j.last_result ? ` · ${/^\d+$/.test(j.last_result) ? `${j.last_result} hechos` : j.last_result}` : ""}` : "Todavía no ha trabajado"}</div>
                        </div>
                        {admin
                          ? <form action={setJobEnabledAction.bind(null, j.key, !j.enabled)}><button type="submit" className={j.enabled ? "switch on job-toggle" : "switch job-toggle"} aria-pressed={j.enabled} aria-label={`${j.enabled ? "Apagar" : "Encender"}: ${j.name}`}><i /></button></form>
                          : <span className="badge">{j.enabled ? "Activo" : "Apagado"}</span>}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {cur.key === "riesgo" && <p className="callout">Además calcula la salud de cada deal y cada cuenta y avisa cuando entran en rojo (siempre activo; solo avisa, nunca cambia datos). <Link href="/settings/signals">Señales y avisos</Link></p>}

              <section className="agent-block" aria-label="Lo último que ha hecho">
                <div className="agent-block-head"><div><h3>Lo último que ha hecho</h3><p className="meta">Últimos 30 días</p></div>
                  {cur.acts.length > 0 && <Link href="/inbox?view=log" className="meta">Ver el registro</Link>}</div>
                {cur.acts.length === 0 ? <p className="meta">Nada todavía.</p> : (
                  <ul className="agent-log">
                    {cur.acts.slice(0, 10).map((a) => (
                      <li key={a.id}><span className={`badge ${a.status === "done" ? (a.mode === "auto" ? "ai" : "won") : a.status === "pending" ? "warn" : ""}`}>
                        {a.status === "done" ? (a.mode === "auto" ? "Sola" : "Aprobada") : a.status === "pending" ? "Pendiente" : a.status === "dismissed" ? "Descartada" : a.status === "undone" ? "Deshecha" : a.status === "failed" ? "Falló" : "Caducada"}</span>
                        {a.deal_id ? <Link href={`/deals/${a.deal_id}`}>{a.title}</Link> : a.title} <span className="meta">· {dateTime(a.at)}</span></li>
                    ))}
                  </ul>
                )}
              </section>
            </article>
          )}

          {view === "instrucciones" && (
            <section aria-label="Instrucciones por fase">
              <header className="stage-detail-head"><div><span className="meta">Lo que has pedido en lenguaje natural en cada fase</span><h2>Instrucciones por fase</h2></div></header>
              <ul className="agent-rules agent-block">
                {pipelines.map((p) => {
                  const own = instructions.filter((i) => i.pipeline_id === p.id);
                  return (
                    <li key={p.id}>
                      <div><strong>{p.name}</strong><div className="meta">{own.length ? `${own.length} instrucci${own.length === 1 ? "ón" : "ones"} · ${own.filter((i) => i.autonomy === "auto").length} actúan solas` : "Sin instrucciones"}</div></div>
                      <Link className="btn small secondary" href={`/pipelines/${p.id}/agentes`}>{own.length ? "Ver y cambiar" : "Escribir instrucciones"}</Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {view === "limites" && admin && (
            <section aria-label="Límites de los agentes">
              <header className="stage-detail-head"><div><span className="meta">Presupuesto de IA y topes</span><h2>Límites</h2></div></header>
              <div className="agent-block">
                <p className="muted" style={{ marginTop: 0 }}>
                  Al 80 % del presupuesto te avisa y al 100 % deja de usar la IA en lo que no es urgente (el chat, las propuestas y las preguntas a los datos siguen).
                  El coste es estimado con los precios por millón de tokens de vuestro proveedor. El descuento máximo sin aprobación está en <Link href="/settings/products">Productos</Link>.
                </p>
                <ActionForm action={saveAgentLimitsAction} submitLabel="Guardar límites" secondary>
                  <h4 className="form-sub">Presupuesto y precios</h4>
                  <div className="grid-3">
                    <label className="field"><span className="label">Presupuesto mensual de IA (€)</span><input name="monthly_budget" type="number" min={0} step="0.01" defaultValue={spend.budget ?? ""} placeholder="sin límite" /></label>
                    <label className="field"><span className="label">€ por millón de tokens de entrada</span><input name="price_in" type="number" min={0} step="0.01" defaultValue={limits?.price_in ?? "3"} /></label>
                    <label className="field"><span className="label">€ por millón de tokens de salida</span><input name="price_out" type="number" min={0} step="0.01" defaultValue={limits?.price_out ?? "15"} /></label>
                  </div>
                  <h4 className="form-sub">Tope por agente (€/mes)</h4>
                  <div className="grid-3">
                    {AGENT_KEYS.map((a) => (
                      <label key={a} className="field"><span className="label">{AGENT_INFO[a].name}</span>
                        <input name={`budget_${a}`} type="number" min={0} step="0.01" defaultValue={spend.agentBudgets[a] ?? ""} placeholder="sin tope" /></label>
                    ))}
                  </div>
                  <h4 className="form-sub">Contacto con clientes</h4>
                  <div className="grid-3">
                    <label className="field"><span className="label">Correos de los agentes por contacto y día</span><input name="per_contact" type="number" min={1} max={10} defaultValue={limits?.per_contact ?? 1} /></label>
                  </div>
                </ActionForm>
              </div>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
