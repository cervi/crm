import { changePasswordAction, saveUiPrefsAction, signOutOthersAction, updateProfileAction } from "@/app/actions/auth";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { AccountShell } from "@/components/account/AccountShell";
import { RichTextField } from "@/components/RichTextField";
import { saveSignatureAction } from "@/app/actions/email-editor";
import { ROLE_LABELS, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { saveNotificationPrefsAction, sendSummaryNowAction } from "@/app/actions/preferences";
import { CATEGORIES, CHANNELS, getPrefs, type Category } from "@/lib/notification-prefs";
import { connectionOf } from "@/lib/mailbox";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mi cuenta" };

const TABS = ["perfil", "preferencias", "seguridad", "avisos"] as const;
type Tab = (typeof TABS)[number];

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ change?: string; tab?: string }> }) {
  const [user, sp] = await Promise.all([requireUser(), searchParams]);
  const forced = Boolean(sp.change || user.must_change_password);
  const tab: Tab = forced ? "seguridad" : TABS.find((t) => t === sp.tab) ?? "perfil";
  const sessions = await sql<{ created_at: Date; last_seen_at: Date; user_agent: string | null }[]>`
    SELECT created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ${user.id} AND expires_at > now() ORDER BY last_seen_at DESC`;
  const [sig] = await sql<{ email_signature: string | null }[]>`SELECT email_signature FROM users WHERE id = ${user.id}`;
  const [prefs, conn] = await Promise.all([getPrefs(user.id), connectionOf(user.id).catch(() => null)]);
  const hasMail = conn?.status === "active";
  const [ui] = await sql<{ home: string | null; density: string | null }[]>`SELECT ui_prefs->>'home' AS home, ui_prefs->>'density' AS density FROM users WHERE id = ${user.id}`;
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <AccountShell user={user} active={tab} hideNav={forced}>
      {forced && <p className="callout" role="alert">Estás usando una contraseña temporal: elige una nueva para continuar.</p>}
          {tab === "perfil" && (
            <>
              <section className="panel" aria-labelledby="h-datos">
                <h2 id="h-datos">Tus datos</h2>
                <ActionForm action={updateProfileAction} submitLabel="Guardar nombre" secondary className="form form-narrow">
                  <label className="field"><span className="label">Nombre</span><input name="name" required defaultValue={user.name} autoComplete="name" /></label>
                </ActionForm>
                <dl className="account-facts">
                  <div><dt>Correo de acceso</dt><dd>{user.email}</dd></div>
                  <div><dt>Rol</dt><dd>{ROLE_LABELS[user.role]}</dd></div>
                </dl>
                <p className="meta" style={{ margin: 0 }}>El correo de acceso y el rol los cambia un administrador.</p>
              </section>
              <section className="panel" aria-labelledby="h-firma" id="firma">
                <h2 id="h-firma">Firma de tus correos</h2>
                <p className="meta" style={{ marginTop: 0 }}>Va al final de lo que envías desde el CRM: la ficha del deal, las secuencias y los agentes. Puedes pegar la que ya usas en Gmail u Outlook.</p>
                <ActionForm action={saveSignatureAction.bind(null, null)} submitLabel="Guardar firma" secondary>
                  <RichTextField name="signature" initial={sig?.email_signature ?? ""} label="Firma" hint="Admite {{remitente}} y {{remitente_email}}." />
                </ActionForm>
              </section>
            </>
          )}

          {tab === "preferencias" && (
            <section className="panel" aria-labelledby="h-pref">
              <h2 id="h-pref">Preferencias</h2>
              <ActionForm action={saveUiPrefsAction} submitLabel="Guardar preferencias" className="form form-narrow">
                <label className="field"><span className="label">Al entrar, empezar en</span>
                  <select name="home" defaultValue={ui?.home ?? "/"}>
                    <option value="/">Hoy (la portada)</option>
                    <option value="/deals">Mis deals</option>
                    <option value="/pipelines">Deals (tablero)</option>
                    <option value="/activities">Actividades</option>
                    <option value="/sequences/tasks">Tareas de secuencias</option>
                    <option value="/inbox">Bandeja de la IA</option>
                    <option value="/leads">Leads</option>
                  </select></label>
                <label className="field"><span className="label">Densidad de las tablas</span>
                  <select name="density" defaultValue={ui?.density ?? "comfortable"}>
                    <option value="comfortable">Cómoda</option>
                    <option value="compact">Compacta (más filas a la vista)</option>
                  </select></label>
                <p className="meta" style={{ margin: 0 }}>El tema claro u oscuro se cambia desde tu foto, arriba a la derecha.</p>
              </ActionForm>
            </section>
          )}

          {tab === "seguridad" && (
            <>
              <section className="panel" aria-labelledby="h-pass">
                <h2 id="h-pass">Cambiar la contraseña</h2>
                <ActionForm action={changePasswordAction} submitLabel="Cambiar contraseña" resetOnSuccess className="form form-narrow">
                  <label className="field"><span className="label">Contraseña actual</span>
                    <input name="current" type="password" required autoComplete="current-password" /></label>
                  <label className="field"><span className="label">Nueva contraseña</span>
                    <input name="password" type="password" required minLength={10} autoComplete="new-password" />
                    <span className="meta">Al menos 10 caracteres. Una frase corta que recuerdes funciona bien.</span></label>
                  <label className="field"><span className="label">Repítela</span>
                    <input name="repeat" type="password" required minLength={10} autoComplete="new-password" /></label>
                </ActionForm>
                <p className="meta" style={{ margin: 0 }}>Al cambiarla se cierran tus sesiones en otros dispositivos y te llega un aviso por correo.
                  {" "}¿No recuerdas la actual? <Link href="/login/recuperar">Te enviamos un enlace</Link>.</p>
              </section>
              {!forced && (
                <section className="panel" aria-labelledby="h-ses">
                  <h2 id="h-ses">Dónde tienes la sesión abierta</h2>
                  <ul className="session-list">
                    {sessions.map((s, i) => (
                      <li key={i}>
                        <strong>{browserName(s.user_agent)}</strong>{i === 0 && <span className="badge" style={{ marginLeft: 6 }}>Probablemente esta</span>}
                        <span className="meta">Desde el {dateTime(s.created_at)} · última actividad {dateTime(s.last_seen_at)}</span>
                      </li>
                    ))}
                  </ul>
                  {sessions.length > 1 && <ActionForm action={signOutOthersAction} submitLabel="Cerrar las demás sesiones" secondary />}
                </section>
              )}
            </>
          )}

          {tab === "avisos" && (
          <section className="panel" aria-label="Avisos y resúmenes" id="avisos">
            <h2>Avisos y resúmenes</h2>
            <p className="meta" style={{ marginTop: 0 }}>Qué te avisa el CRM y por dónde. Lo urgente puede llegarte al momento; el resto, agrupado a las 12:00 y a las 17:00 para no recibir un correo por cada cosa.
              {!hasMail && <> <strong className="tone-bad">Ahora mismo no te llega nada por correo:</strong> conecta tu cuenta en <a href="/settings/mailbox">Correo, calendario y documentos</a>.</>}</p>            <ActionForm action={saveNotificationPrefsAction} submitLabel="Guardar avisos">
              <div className="table-wrap">
                <table className="prefs-table">
                  <thead><tr><th>Cuando…</th><th>Cómo te aviso</th></tr></thead>
                  <tbody>
                    {(Object.keys(CATEGORIES) as Category[]).map((c) => (
                      <tr key={c}>
                        <td><strong>{CATEGORIES[c].label}</strong><div className="meta">{CATEGORIES[c].hint}</div></td>
                        <td>
                          <select name={`ch_${c}`} defaultValue={prefs.channels[c]} aria-label={`Avisos: ${CATEGORIES[c].label}`}>
                            {Object.entries(CHANNELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <fieldset className="prefs-group">
                <legend>Horas de silencio</legend>
                <div className="prefs-inline">
                  <label className="checkbox"><input type="checkbox" name="quiet" defaultChecked={prefs.quietFrom !== null} />No enviarme correos de</label>
                  <select name="quiet_from" defaultValue={prefs.quietFrom ?? 20} aria-label="Silencio desde">{hours.map((h) => <option key={h} value={h}>{`${h}:00`}</option>)}</select>
                  <span>a</span>
                  <select name="quiet_to" defaultValue={prefs.quietTo ?? 8} aria-label="Silencio hasta">{hours.map((h) => <option key={h} value={h}>{`${h}:00`}</option>)}</select>
                </div>
                <p className="meta">Lo que llegue en ese rato te espera en la campana y sale por correo al terminar.</p>
              </fieldset>

              <fieldset className="prefs-group">
                <legend>Resúmenes por correo</legend>
                <label className="checkbox"><input type="checkbox" name="daily" defaultChecked={prefs.daily} /><span><strong>Parte del día</strong> <span className="meta">— lo que toca hoy, cada mañana</span></span></label>
                <label className="checkbox"><input type="checkbox" name="week_plan" defaultChecked={prefs.weekPlan} /><span><strong>Plan de la semana</strong> <span className="meta">— el lunes: reuniones, deals por cerrar y deals sin siguiente paso (va dentro del parte del día si lo recibes)</span></span></label>
                <label className="checkbox"><input type="checkbox" name="week_review" defaultChecked={prefs.weekReview} /><span><strong>Balance del viernes</strong> <span className="meta">— a las 16:00: ganados, perdidos, actividad y lo que queda para el lunes</span></span></label>
                {user.role === "admin" && <label className="checkbox"><input type="checkbox" name="team_week" defaultChecked={prefs.teamWeek} /><span><strong>Semana del equipo</strong> <span className="meta">— el lunes: cifras de cada comercial y del pipeline (también dentro del parte)</span></span></label>}
                <label className="checkbox"><input type="checkbox" name="meeting_prep" defaultChecked={prefs.meetingPrep} /><span><strong>Ficha de cada reunión</strong> <span className="meta">— por correo, poco antes de empezar</span></span></label>
              </fieldset>

              <fieldset className="prefs-group">
                <legend>Correos sin respuesta</legend>
                <label className="field" style={{ maxWidth: 360 }}><span className="label">Avisarme si no me responden en</span>
                  <select name="no_reply_days" defaultValue={prefs.noReplyDays}>
                    <option value={0}>No avisarme</option>
                    {[2, 3, 4, 5, 7, 10, 14].map((d) => <option key={d} value={d}>{d} días</option>)}
                  </select></label>
                <p className="meta">Solo correos tuyos a deals abiertos (no los de secuencias, que ya hacen su seguimiento), y te dice si llegó a abrirlo.</p>
              </fieldset>
            </ActionForm>
            {hasMail && (
              <div className="prefs-try">
                <span className="meta">¿Quieres ver cómo son?</span>
                <ActionForm action={sendSummaryNowAction.bind(null, "week_plan")} submitLabel="Enviarme el plan de la semana" secondary className="form inline" />
                <ActionForm action={sendSummaryNowAction.bind(null, "week_review")} submitLabel="Enviarme el balance" secondary className="form inline" />
                {user.role === "admin" && <ActionForm action={sendSummaryNowAction.bind(null, "team_week")} submitLabel="Enviarme la semana del equipo" secondary className="form inline" />}
              </div>
            )}
          </section>
          )}
    </AccountShell>
  );
}

function browserName(ua: string | null): string {
  if (!ua) return "Navegador";
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} en ${os}` : b;
}
