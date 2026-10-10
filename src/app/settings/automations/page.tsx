import Link from "next/link";
import {
  ACTION_TYPES, AGENTS, RULE_PARAMS, ruleAction, actionLabel, autonomySuggestion, effectiveAutonomy, getSettings,
  listPermissions, listRules, ruleStats, AUTONOMY_LEVELS,
} from "@/lib/automations";
import { dateTime } from "@/lib/format";
import { hasActiveMailbox } from "@/lib/mailbox";
import { getDigestSettings } from "@/lib/digest";
import { saveDigestSettingsAction } from "@/app/actions/ai";
import {
  runNowAction, setPausedAction, setPermissionAction, setRuleAutonomyAction, updateRuleParamsAction,
} from "@/app/actions/automations";
import { ActionForm } from "@/components/ActionForm";
import { AutonomyPicker } from "@/components/ai/AutonomyPicker";
import { CustomRuleForm } from "@/components/ai/CustomRuleForm";
import { activityTypes } from "@/lib/activity-types";
import { sql } from "@/lib/db";
import { createCustomRuleAction, deleteCustomRuleAction, updateCustomRuleAction } from "@/app/actions/automations";
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automatizaciones e IA" };

export default async function AutomationsSettingsPage() {
  await requireAdminPage();
  const [rules, permissions, settings, stats, mailbox, digest] = await Promise.all([listRules(), listPermissions(), getSettings(), ruleStats(), hasActiveMailbox(), getDigestSettings()]);
  // Sin buzón conectado, un correo no puede salir solo.
  const allowedFor = (action: string, allowed: typeof permissions[number]["allowed_autonomy"]) =>
    action === "draft_email" && !mailbox ? allowed.filter((l) => l !== "auto") : allowed;
  const types = await activityTypes();
  const typeOptions = types.filter((t) => t.is_active).map((t) => ({ value: t.key, label: t.label }));
  const stageRows = await sql<{ id: string; name: string; pipeline: string }[]>`
    SELECT s.id, s.name, p.name AS pipeline FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
    WHERE s.is_active AND p.is_active ORDER BY p.name, s.position`;
  const stageOptions = [...new Set(stageRows.map((r) => r.pipeline))].map((pipeline) => ({
    pipeline, options: stageRows.filter((r) => r.pipeline === pipeline).map((r) => ({ value: r.id, label: r.name })),
  }));
  const [pipelineRows, userRows] = await Promise.all([
    sql<{ id: string; name: string }[]>`SELECT id, name FROM pipelines WHERE is_active ORDER BY position, name`,
    sql<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE kind = 'human' AND is_active ORDER BY name`,
  ]);
  const pipelineOptions = pipelineRows.map((p) => ({ value: p.id, label: p.name }));
  const userOptions = userRows.map((u) => ({ value: u.id, label: u.name }));
  const NO_MAILBOX = "Para que envíe correos sola, conecta tu cuenta en Ajustes → Correo, calendario y documentos.";
  const perm = (actor: string, action: string) => permissions.find((p) => p.actor === actor && p.action_type === action);
  const levelLabel = (v: string) => AUTONOMY_LEVELS.find((l) => l.value === v)?.label ?? v;

  return (
    <main className="page">
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

      <section className="panel" aria-label="Parte del día">
        <h2>Parte del día</h2>
        <p className="muted">
          Cada persona con su cuenta conectada recibe en su correo el parte del día: lo que tiene que decidir, su agenda, lo vencido,
          los deals que piden atención con el siguiente paso y lo que hizo la IA. También está siempre en <Link href="/">Hoy</Link>.
        </p>
        <ActionForm action={saveDigestSettingsAction} submitLabel="Guardar" secondary className="form inline">
          <label className="checkbox"><input type="checkbox" name="enabled" defaultChecked={digest.enabled} />Enviar el parte por correo</label>
          <label className="field"><span className="label">A partir de las</span>
            <select name="hour" defaultValue={digest.hour}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
          </label>
          <div className="day-picks" role="group" aria-label="Días del parte">
            {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((d, i) => (
              <label key={d} className="checkbox"><input type="checkbox" name={`day_${i + 1}`} defaultChecked={digest.days.includes(i + 1)} />{d}</label>
            ))}
          </div>
        </ActionForm>
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
        <h2 className="section-title">Reglas de serie</h2>
        <div className="rules">
          {rules.filter((r) => !r.is_custom).map((r) => {
            const action = ruleAction(r)!;
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
                {r.key === "won_handoff_email" && r.autonomy !== "off" && !String(r.params.cs_email ?? "") && (
                  <p className="callout" style={{ margin: "10px 0 0" }}>
                    Falta el email de Customer Success por defecto (en «Ajustes de la regla»). Mientras, solo se envía a las empresas que tengan su responsable de CS en su ficha.
                  </p>
                )}
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
                              : s.kind === "text" || s.kind === "email"
                                ? <input name={s.key} type={s.kind} defaultValue={String(r.params[s.key] ?? "")} />
                                : <input name={s.key} type="number" step={s.kind === "number" ? "0.5" : "1"}
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

      <section className="rules-section" id="reglas-personalizadas" aria-label="Tus reglas">
        <h2 className="section-title">Tus reglas</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Reglas sobre las actividades de los deals: cuando una actividad de un tipo se hace (con un resultado) o no se hace a tiempo,
          la IA crea otra actividad, escribe al contacto, mueve el deal o te pide una decisión. Los tipos se configuran en{" "}
          <Link href="/settings/activity-types">Ajustes → Tipos de actividad</Link>.
        </p>
        <div className="rules">
          {rules.filter((r) => r.is_custom && !r.instruction_id).map((r) => {
            const action = ruleAction(r)!;
            const eff = effectiveAutonomy(r, permissions, { mailbox });
            const st = stats.get(r.id);
            const tip = autonomySuggestion(r, st);
            return (
              <article key={r.id} className="panel rule" aria-label={r.name}>
                <div className="rule-head">
                  <div>
                    <h3>{r.name}</h3>
                    <p className="custom-rule-desc">{r.description}</p>
                  </div>
                  <AutonomyPicker label={`Autonomía: ${r.name}`} value={r.autonomy} allowed={allowedFor(action, r.allowed_autonomy)}
                                  action={setRuleAutonomyAction.bind(null, r.id)} unavailableHint={NO_MAILBOX} />
                </div>
                <div className="rule-foot meta">
                  <span>Acción: {actionLabel(action)}</span>
                  {eff !== r.autonomy && <span className="badge warn">Limitada a «{levelLabel(eff)}»</span>}
                  <span>Últimos 90 días: {st ? `${st.approved} aprobadas, ${st.auto_done} hechas solas, ${st.pending} pendientes` : "sin actividad"}</span>
                </div>
                {tip && <p className="callout good" style={{ margin: "10px 0 0" }}>{tip}</p>}
                <details className="rule-params">
                  <summary className="meta">Editar la regla</summary>
                  <CustomRuleForm action={updateCustomRuleAction.bind(null, r.id)} types={typeOptions} stages={stageOptions} pipelines={pipelineOptions} users={userOptions}
                                  initial={{ name: r.name, trigger: r.trigger ?? undefined, action: r.action ?? undefined }} submitLabel="Guardar" />
                  <ActionForm action={deleteCustomRuleAction.bind(null, r.id)} submitLabel="Borrar la regla" pendingLabel="…" secondary className="form inline" confirm="La regla deja de actuar y se descartan sus propuestas pendientes." />
                </details>
              </article>
            );
          })}
          <article className="panel rule new-rule" aria-label="Nueva regla">
            <h3>Nueva regla</h3>
            <CustomRuleForm action={createCustomRuleAction} types={typeOptions} stages={stageOptions} pipelines={pipelineOptions} users={userOptions} submitLabel="Crear regla" withAutonomy />
          </article>
        </div>
      </section>
    </main>
  );
}
