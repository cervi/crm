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
import { runNowAction, setPausedAction, setRuleAutonomyAction } from "@/app/actions/automations";
import { saveAgentLimitsAction, setJobEnabledAction } from "@/app/actions/agent-panel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agentes" };

const eur = (n: number) => `${n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Panel del «jefe de agentes»: qué hace cada agente, con qué autonomía, cuánto gasta y lo último que ha hecho. */
export default async function AgentsPage() {
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

  return (
    <main className="page agents-page" style={{ maxWidth: 1180 }}>
      <div className="page-head">
        <div>
          <h1>Agentes</h1>
          <p className="muted" style={{ margin: 0 }}>
            Seis agentes cubren el ciclo entero, de la primera visita a la renovación. Cada uno propone o hace según la autonomía que le des;
            todo queda en la <Link href="/inbox">bandeja</Link> y en el registro, con «Deshacer».
          </p>
        </div>
        <div className="head-actions">
          {admin && (
            <form action={setPausedAction.bind(null, !settings.paused)}>
              <button type="submit" className={settings.paused ? "btn" : "btn secondary"}>{settings.paused ? "Reanudar a los agentes" : "Pausar a todos"}</button>
            </form>
          )}
          {!settings.paused && <ActionForm action={runNowAction} submitLabel="Revisar ahora" pendingLabel="Revisando…" secondary className="form inline" />}
        </div>
      </div>

      <section className="panel boss" aria-label="Jefe de agentes">
        <div className="boss-grid">
          <div>
            <h2><Icon name="spark" />Jefe de agentes</h2>
            <p className="muted" style={{ margin: 0 }}>
              {settings.paused ? "Todos en pausa: no proponen ni hacen nada nuevo." : `Activos. Última revisión: ${settings.last_run_at ? dateTime(settings.last_run_at) : "nunca"}.`}
              {" "}Reparte el trabajo, evita que dos agentes escriban al mismo contacto el mismo día (como mucho {limits?.per_contact ?? 1} correo{(limits?.per_contact ?? 1) === 1 ? "" : "s"} al día) y resume cada mañana lo hecho en el <Link href="/">parte del día</Link>.
            </p>
          </div>
          <div className="boss-stat">
            <span className="label">IA este mes</span>
            <strong>{eur(spend.month)}</strong>
            <span className="meta">{spend.calls} llamadas{spend.budget !== null ? ` · presupuesto ${eur(spend.budget)}` : " · sin presupuesto"}{!aiReady(ai) ? " · IA sin configurar" : ""}</span>
            {used !== null && <div className={`meter ${used >= 100 ? "bad" : used >= 80 ? "warn" : ""}`}><i style={{ width: `${used}%` }} /></div>}
          </div>
        </div>
      </section>

      <div className="agent-grid">
        {AGENT_KEYS.map((key) => {
          const info = AGENT_INFO[key];
          const own = rules.filter((r) => r.agent === key && !r.instruction_id);
          const ownJobs = jobs.filter((j) => j.agent === key);
          const acts = recent.filter((r) => r.agent === key);
          const s = own.map((r) => stats.get(r.id)).filter(Boolean);
          const decided = s.reduce((n, x) => n + x!.decided, 0), approved = s.reduce((n, x) => n + x!.approved, 0);
          const auto = s.reduce((n, x) => n + x!.auto_done, 0), pending = s.reduce((n, x) => n + x!.pending, 0);
          const budget = spend.agentBudgets[key];
          return (
            <article key={key} className="panel agent-card" aria-label={`Agente ${info.name}`}>
              <div className="agent-head">
                <h2>{info.name}</h2>
                <span className="meta">{info.goal}</span>
              </div>
              <p className="meta agent-stats">
                90 días: {auto} hechas solas · {approved} de {decided} propuestas aprobadas{pending ? ` · ${pending} pendientes` : ""}
                {" · "}IA: {eur(spend.byAgent[key] ?? 0)}{budget !== undefined ? ` de ${eur(budget)}` : ""}
              </p>
              {own.length > 0 && (
                <ul className="agent-rules">
                  {own.map((r) => {
                    const action = ruleAction(r)!;
                    const eff = effectiveAutonomy(r, permissions, { mailbox });
                    return (
                      <li key={r.id}>
                        <div>
                          <strong>{r.name}</strong>
                          <div className="meta">{actionLabel(action)}{eff !== r.autonomy ? ` · limitada a «${eff === "off" ? "No" : eff === "ask" ? "Preguntar" : "Sola"}» por los permisos` : ""}</div>
                        </div>
                        {admin
                          ? <AutonomyPicker label={`Autonomía: ${r.name}`} value={r.autonomy} allowed={r.allowed_autonomy} action={setRuleAutonomyAction.bind(null, r.id)} />
                          : <span className="badge">{r.autonomy === "off" ? "No" : r.autonomy === "ask" ? "Preguntar" : "Sola"}</span>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {ownJobs.length > 0 && (
                <ul className="agent-rules">
                  {ownJobs.map((j) => (
                    <li key={j.key}>
                      <div>
                        <strong>{j.name}</strong>
                        <div className="meta">{j.last_run_at ? `Última vez ${dateTime(j.last_run_at)}${j.last_result ? ` · ${/^\d+$/.test(j.last_result) ? `${j.last_result} hechos` : j.last_result}` : ""}` : "Todavía no ha trabajado"}</div>
                      </div>
                      {admin
                        ? <form action={setJobEnabledAction.bind(null, j.key, !j.enabled)}><button type="submit" className={j.enabled ? "btn small good job-toggle" : "btn small secondary job-toggle"} aria-pressed={j.enabled}>{j.enabled ? "Activo" : "Apagado"}</button></form>
                        : <span className="badge">{j.enabled ? "Activo" : "Apagado"}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {key === "riesgo" && <p className="meta">Calcula la salud de cada deal y cada cuenta y avisa cuando entran en rojo (siempre activo; solo avisa, nunca cambia datos). <Link href="/settings/signals">Señales y avisos</Link></p>}
              {acts.length > 0 && (
                <details>
                  <summary className="meta">Lo último que ha hecho ({acts.length} en 30 días)</summary>
                  <ul className="agent-log">
                    {acts.slice(0, 8).map((a) => (
                      <li key={a.id}><span className={`badge ${a.status === "done" ? (a.mode === "auto" ? "ai" : "won") : a.status === "pending" ? "warn" : ""}`}>
                        {a.status === "done" ? (a.mode === "auto" ? "Sola" : "Aprobada") : a.status === "pending" ? "Pendiente" : a.status === "dismissed" ? "Descartada" : a.status === "undone" ? "Deshecha" : a.status === "failed" ? "Falló" : "Caducada"}</span>
                        {a.deal_id ? <Link href={`/deals/${a.deal_id}`}>{a.title}</Link> : a.title} <span className="meta">· {dateTime(a.at)}</span></li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </div>

      <section className="panel" aria-label="Instrucciones por fase">
        <h2><Icon name="spark" />Instrucciones por fase del funnel</h2>
        <p className="meta" style={{ marginTop: 0 }}>Lo que has pedido en lenguaje natural en cada fase («cuando entre aquí, escríbele para agendar…»). Se escriben y se cambian desde cada pipeline.</p>
        <ul className="agent-rules">
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

      {admin && (
        <section className="panel" aria-label="Límites de los agentes" style={{ marginTop: 18 }}>
          <h2>Límites</h2>
          <p className="muted">
            Presupuesto de IA al mes (el coste es estimado con los precios por millón de tokens de vuestro proveedor): al 80 % te avisa y al 100 % deja
            de usar la IA en lo que no es urgente (el chat de la web, las propuestas y las preguntas a los datos siguen). El descuento máximo sin
            aprobación está en <Link href="/settings/products">Productos</Link> y la autonomía de cada acción en <Link href="/settings/automations">Automatizaciones</Link>.
          </p>
          <ActionForm action={saveAgentLimitsAction} submitLabel="Guardar límites" secondary>
            <div className="grid-3">
              <label className="field"><span className="label">Presupuesto mensual de IA (€)</span><input name="monthly_budget" type="number" min={0} step="0.01" defaultValue={spend.budget ?? ""} placeholder="sin límite" /></label>
              <label className="field"><span className="label">€ por millón de tokens de entrada</span><input name="price_in" type="number" min={0} step="0.01" defaultValue={limits?.price_in ?? "3"} /></label>
              <label className="field"><span className="label">€ por millón de tokens de salida</span><input name="price_out" type="number" min={0} step="0.01" defaultValue={limits?.price_out ?? "15"} /></label>
              {AGENT_KEYS.map((a) => (
                <label key={a} className="field"><span className="label">Tope de {AGENT_INFO[a].name} (€/mes)</span>
                  <input name={`budget_${a}`} type="number" min={0} step="0.01" defaultValue={spend.agentBudgets[a] ?? ""} placeholder="sin tope" /></label>
              ))}
              <label className="field"><span className="label">Correos de los agentes por contacto y día</span><input name="per_contact" type="number" min={1} max={10} defaultValue={limits?.per_contact ?? 1} /></label>
            </div>
          </ActionForm>
        </section>
      )}
    </main>
  );
}
