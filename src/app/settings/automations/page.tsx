import Link from "next/link";
import {
  ACTION_TYPES, AGENTS, RULE_ACTION, RULE_PARAMS, actionLabel, autonomySuggestion, effectiveAutonomy, getSettings,
  listPermissions, listRules, ruleStats, AUTONOMY_LEVELS,
} from "@/lib/automations";
import { dateTime } from "@/lib/format";
import { hasActiveMailbox } from "@/lib/mailbox";
import {
  runNowAction, setPausedAction, setPermissionAction, setRuleAutonomyAction, updateRuleParamsAction,
} from "@/app/actions/automations";
import { ActionForm } from "@/components/ActionForm";
import { AutonomyPicker } from "@/components/ai/AutonomyPicker";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automatizaciones e IA" };

export default async function AutomationsSettingsPage() {
  const [rules, permissions, settings, stats, mailbox] = await Promise.all([listRules(), listPermissions(), getSettings(), ruleStats(), hasActiveMailbox()]);
  // Sin buzón conectado, un correo no puede salir solo.
  const allowedFor = (action: string, allowed: typeof permissions[number]["allowed_autonomy"]) =>
    action === "draft_email" && !mailbox ? allowed.filter((l) => l !== "auto") : allowed;
  const NO_MAILBOX = "Para que envíe correos sola, conecta tu correo en Ajustes → Correo y calendario.";
  const perm = (actor: string, action: string) => permissions.find((p) => p.actor === actor && p.action_type === action);
  const levelLabel = (v: string) => AUTONOMY_LEVELS.find((l) => l.value === v)?.label ?? v;

  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><h1>Automatizaciones e IA</h1></div>

      <section className="panel ai-status">
        <div>
          <h2>{settings.paused ? "La IA está en pausa" : "La IA está activa"}</h2>
          <p className="muted" style={{ margin: 0 }}>
            {settings.paused
              ? "No propone ni hace nada nuevo. Lo pendiente sigue en la bandeja."
              : "Revisa los deals cada pocos minutos y actúa según la autonomía que le des abajo."}
            {" "}Última revisión: {settings.last_run_at ? dateTime(settings.last_run_at) : "nunca"}.
          </p>
        </div>
        <div className="head-actions">
          <form action={setPausedAction.bind(null, !settings.paused)}>
            <button type="submit" className={settings.paused ? "btn" : "btn secondary"}>{settings.paused ? "Reanudar" : "Pausar todo"}</button>
          </form>
          {!settings.paused && <ActionForm action={runNowAction} submitLabel="Revisar ahora" pendingLabel="Revisando…" secondary className="form inline" />}
        </div>
      </section>

      <section className="panel">
        <h2>Qué puede hacer la IA</h2>
        <p className="muted">
          El límite para cada tipo de acción. <strong>No</strong>: no lo hace. <strong>Preguntar</strong>: lo propone en
          la <Link href="/inbox">bandeja</Link> y espera tu decisión. <strong>Sola</strong>: lo hace y queda en el registro,
          desde donde se puede deshacer. Una regla nunca supera este límite.
        </p>
        <div className="table-wrap">
          <table className="perm-table">
            <thead>
              <tr>
                <th>Acción</th>
                {AGENTS.map((a) => <th key={a.value}>{a.label}<div className="meta" style={{ fontWeight: 400 }}>{a.help}</div></th>)}
              </tr>
            </thead>
            <tbody>
              {ACTION_TYPES.map((t) => (
                <tr key={t.value}>
                  <td><strong>{t.label}</strong><div className="meta">{t.help}</div></td>
                  {AGENTS.map((a) => {
                    const p = perm(a.value, t.value);
                    return (
                      <td key={a.value}>
                        {p && (
                          <AutonomyPicker
                            label={`${t.label} — ${a.label}`}
                            value={p.autonomy}
                            allowed={allowedFor(t.value, p.allowed_autonomy)}
                            action={setPermissionAction.bind(null, a.value, t.value)}
                            unavailableHint={t.value === "draft_email" ? NO_MAILBOX : undefined}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rules-section">
        <h2 className="section-title">Reglas</h2>
        <div className="rules">
          {rules.map((r) => {
            const action = RULE_ACTION[r.key];
            const eff = effectiveAutonomy(r, permissions, { mailbox });
            const st = stats.get(r.id);
            const tip = autonomySuggestion(r, st);
            const specs = RULE_PARAMS[r.key] ?? [];
            return (
              <article key={r.id} className="panel rule" aria-label={r.name}>
                <div className="rule-head">
                  <div>
                    <h3>{r.name}</h3>
                    <p className="muted" style={{ margin: 0 }}>{r.description}</p>
                  </div>
                  <AutonomyPicker
                    label={`Autonomía: ${r.name}`}
                    value={r.autonomy}
                    allowed={allowedFor(action, r.allowed_autonomy)}
                    action={setRuleAutonomyAction.bind(null, r.id)}
                    unavailableHint={NO_MAILBOX}
                  />
                </div>
                <div className="rule-foot meta">
                  <span>Acción: {actionLabel(action)}</span>
                  {eff !== r.autonomy && (
                    <span className="badge warn">
                      Limitada a «{levelLabel(eff)}» {action === "draft_email" && !mailbox && r.autonomy === "auto" ? "hasta que conectes tu correo" : <>por el permiso «{actionLabel(action)}»</>}
                    </span>
                  )}
                  {st ? (
                    <span>
                      Últimos 90 días: {st.decided > 0 && `${st.approved} de ${st.decided} propuesta${st.decided === 1 ? "" : "s"} aprobada${st.decided === 1 ? "" : "s"}`}
                      {st.decided > 0 && st.auto_done > 0 && " · "}
                      {st.auto_done > 0 && `${st.auto_done} hecha${st.auto_done === 1 ? "" : "s"} sola${st.auto_done === 1 ? "" : "s"}`}
                      {st.undone > 0 && ` · ${st.undone} deshecha${st.undone === 1 ? "" : "s"}`}
                      {st.pending > 0 && ` · ${st.pending} pendiente${st.pending === 1 ? "" : "s"}`}
                      {st.decided === 0 && st.auto_done === 0 && st.pending === 0 && "sin actividad"}
                    </span>
                  ) : <span>Últimos 90 días: sin actividad</span>}
                </div>
                {tip && <p className="callout good" style={{ margin: "10px 0 0" }}>{tip}</p>}
                {specs.length > 0 && (
                  <details className="rule-params">
                    <summary className="meta">Ajustes de la regla</summary>
                    <ActionForm action={updateRuleParamsAction.bind(null, r.id)} submitLabel="Guardar" secondary>
                      <div className="grid-2">
                        {specs.map((s) => (
                          <label key={s.key} className="field" style={s.kind === "textarea" ? { gridColumn: "1 / -1" } : undefined}>
                            <span className="label">{s.label}</span>
                            {s.kind === "textarea"
                              ? <textarea name={s.key} rows={6} defaultValue={String(r.params[s.key] ?? "")} />
                              : <input name={s.key} type={s.kind === "text" ? "text" : "number"} step={s.kind === "number" ? "0.5" : "1"}
                                       min={s.kind === "days" ? 0 : 1} defaultValue={String(r.params[s.key] ?? "")} />}
                            {s.help && <span className="meta">{s.help}</span>}
                          </label>
                        ))}
                      </div>
                    </ActionForm>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
