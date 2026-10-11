import Link from "next/link";
import { ackAlertsAction, endSessionAction, saveRulesAction, saveSsoSettingsAction, saveSystemMailAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { requireAdminPage, ROLE_LABELS } from "@/lib/auth";
import { encryptionConfigured } from "@/lib/crypto";
import { sql } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { PROVIDERS } from "@/lib/integrations";
import { listLoginEvents, METHOD_LABEL } from "@/lib/login-log";
import { getSsoSettings } from "@/lib/sso";
import { systemSender } from "@/lib/user-lifecycle";
import { ALERT_TEXT, getRules, listAlerts, recentExports, securityPosture } from "@/lib/security";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centro de seguridad" };

const TABS = [["panel", "Panel"], ["alertas", "Alertas"], ["reglas", "Reglas y acceso"], ["registro", "Registro"]] as const;

const device = (ua: string | null) => {
  if (!ua) return "—";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  return [br, os].filter(Boolean).join(" · ");
};

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ fallidos?: string; tab?: string; todas?: string }> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const tab = (TABS.find(([k]) => k === sp.tab)?.[0] ?? (sp.fallidos ? "registro" : "panel")) as (typeof TABS)[number][0];
  const [posture, alerts, rules, exportsList] = await Promise.all([securityPosture(), listAlerts(sp.todas !== "1"), getRules(true), recentExports(30)]);
  const failedOnly = sp.fallidos === "1";
  const [sso, events, sessions, [stats]] = await Promise.all([
    getSsoSettings(), listLoginEvents({ failed: failedOnly, limit: 200 }),
    sql<{ id: string; name: string; role: keyof typeof ROLE_LABELS; created_at: Date; last_seen_at: Date; user_agent: string | null }[]>`
      SELECT s.id, u.name, u.role, s.created_at, s.last_seen_at, s.user_agent FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.expires_at > now() ORDER BY s.last_seen_at DESC LIMIT 200`,
    sql<{ ok: number; bad: number; locked: number }[]>`
      SELECT count(*) FILTER (WHERE success)::int AS ok, count(*) FILTER (WHERE NOT success)::int AS bad,
             (SELECT count(*)::int FROM users WHERE locked_until > now()) AS locked
      FROM login_events WHERE at > now() - interval '7 days'`,
  ]);
  const providers = (["google", "microsoft"] as const).filter((k) => PROVIDERS[k].configured());
  const [mailboxes, [mailSetting], autoSender] = await Promise.all([
    sql<{ user_id: string; email: string; name: string }[]>`
      SELECT m.user_id, m.email, u.name FROM mailbox_connections m JOIN users u ON u.id = m.user_id
      WHERE m.purpose = 'main' AND m.status = 'active' AND u.role = 'admin' AND u.is_active ORDER BY u.name`,
    sql<{ system_mail_user_id: string | null }[]>`SELECT system_mail_user_id FROM app_settings LIMIT 1`,
    systemSender(null),
  ]);
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Centro de seguridad</h1>
          <p className="muted" style={{ margin: 0 }}>Cómo se entra al CRM, quién ha entrado, qué se ha descargado y lo que conviene revisar.</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Secciones">
        {TABS.map(([k, l]) => (
          <Link key={k} href={`/settings/security?tab=${k}`} aria-current={tab === k ? "page" : undefined}>
            {l}{k === "alertas" && posture.open_alerts > 0 && <span className="count">{posture.open_alerts}</span>}
          </Link>
        ))}
      </nav>

      {tab === "panel" && (
        <>
          <section className="kpi-row" aria-label="De un vistazo">
            <Link href="/settings/security?tab=alertas" className="kpi kpi-link"><span className="meta">Alertas por revisar</span><strong className={posture.open_alerts ? "tone-bad" : undefined}>{posture.open_alerts}</strong></Link>
            <Link href="/settings/security?tab=registro&fallidos=1" className="kpi kpi-link"><span className="meta">Intentos fallidos (7 días)</span><strong>{posture.failed7}</strong></Link>
            <Link href="/settings/security?tab=registro" className="kpi kpi-link"><span className="meta">Sesiones abiertas</span><strong>{posture.sessions}</strong></Link>
            <Link href="/settings/security?tab=registro#descargas" className="kpi kpi-link"><span className="meta">Descargas de datos (30 días)</span><strong>{posture.exports30}</strong></Link>
          </section>
          <section className="panel" aria-label="Recomendaciones">
            <h2>Qué revisar</h2>
            {(() => {
              const items: { ok: boolean; node: React.ReactNode }[] = [
                { ok: Boolean(posture.admins <= 3), node: <><strong>{posture.admins} administrador{posture.admins === 1 ? "" : "es"}</strong>
                <span className="meta">{posture.admins <= 3 ? "Bien: cuantos menos, mejor." : "Son muchos: deja como administradores solo a quien lo necesite."} <Link href="/settings/users">Usuarios</Link></span></> },
                { ok: Boolean(posture.stale === 0), node: <><strong>{posture.stale} con acceso sin entrar en 60 días</strong>
                <span className="meta">{posture.stale ? "Si ya no lo usan, dales de baja." : "Nadie con acceso olvidado."} <Link href="/settings/users">Usuarios</Link></span></> },
                { ok: Boolean(providers.length && encryptionConfigured() && posture.sso_users > 0), node: <><strong>Entrar con Google o Microsoft</strong>
                <span className="meta">{providers.length && encryptionConfigured() ? (posture.sso_users ? `${posture.sso_users} de ${posture.users} pueden entrar así.` : "Configurado, pero aún nadie entra así.") : "Sin configurar: es más seguro que una contraseña."} <Link href="/settings/security?tab=reglas">Reglas y acceso</Link></span></> },
                { ok: Boolean(rules.idle_hours), node: <><strong>Cierre por inactividad</strong>
                <span className="meta">{rules.idle_hours ? `Tras ${rules.idle_hours} h sin usarlo hay que volver a entrar.` : "Sin límite: conviene ponerlo si se usa en ordenadores compartidos."}</span></> },
                { ok: Boolean(rules.export_admin_only), node: <><strong>Descargas de datos</strong>
                <span className="meta">{rules.export_admin_only ? "Solo los administradores pueden descargar." : "Cualquiera con acceso puede descargar listados en CSV."}</span></> },
                { ok: Boolean(posture.temp_pass === 0 && posture.locked === 0), node: <><strong>Contraseñas</strong>
                <span className="meta">{posture.temp_pass ? `${posture.temp_pass} con contraseña temporal sin cambiar. ` : ""}{posture.locked ? `${posture.locked} bloqueados ahora. ` : ""}{!posture.temp_pass && !posture.locked ? "Todo en orden." : ""}</span></> },
              ];
              const todo = items.filter((i) => !i.ok), done = items.filter((i) => i.ok);
              return (<>
                {todo.length > 0 && <ul className="check-list">{todo.map((i, n) => <li key={n} className="pending">{i.node}</li>)}</ul>}
                {done.length > 0 && (todo.length === 0
                  ? <ul className="check-list">{done.map((i, n) => <li key={n} className="ok">{i.node}</li>)}</ul>
                  : <details className="check-done"><summary className="meta">Todo en orden: {done.length}</summary>
                      <ul className="check-list">{done.map((i, n) => <li key={n} className="ok">{i.node}</li>)}</ul></details>)}
              </>);
            })()}
          </section>
        </>
      )}

      {tab === "alertas" && (
        <section className="panel" aria-label="Alertas">
          <div className="sign-head">
            <h2>Alertas</h2>
            <nav className="chips" aria-label="Filtrar">
              <Link href="/settings/security?tab=alertas" aria-current={sp.todas !== "1" ? "page" : undefined}>Por revisar</Link>
              <Link href="/settings/security?tab=alertas&todas=1" aria-current={sp.todas === "1" ? "page" : undefined}>Todas</Link>
            </nav>
          </div>
          <p className="meta" style={{ marginTop: 0 }}>Los administradores reciben aviso de las importantes (intentos fallidos seguidos, administradores nuevos, descargas de 500 filas o más, un administrador que entra desde otro dispositivo).</p>
          {alerts.length === 0 ? <p className="muted">Nada que revisar.</p> : (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Cuándo</th><th>Qué</th><th>Tipo</th><th>Revisada</th></tr></thead>
                  <tbody>{alerts.map((a) => (
                    <tr key={a.id}>
                      <td className="nowrap">{dateTime(a.at)}</td>
                      <td><span className={`badge ${a.severity === "high" ? "lost" : a.severity === "warn" ? "warn" : ""}`}>{a.severity === "high" ? "Alta" : a.severity === "warn" ? "Revisar" : "Info"}</span> {a.title}
                        {a.actor_name && <div className="meta">por {a.actor_name}</div>}</td>
                      <td className="meta">{ALERT_TEXT[a.kind] ?? a.kind}</td>
                      <td className="meta">{a.acknowledged_at ? `${dateTime(a.acknowledged_at)}${a.ack_name ? ` · ${a.ack_name}` : ""}` : "—"}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {alerts.some((a) => !a.acknowledged_at) && <ActionForm action={ackAlertsAction} submitLabel="Marcar todas como revisadas" secondary className="form inline" />}
            </>
          )}
        </section>
      )}

      {tab === "reglas" && (
        <section className="panel" aria-label="Reglas">
          <h2>Reglas</h2>
          <ActionForm action={saveRulesAction} submitLabel="Guardar reglas">
            <div className="grid-2">
              <label className="field"><span className="label">Las sesiones duran (días)</span><input name="session_days" type="number" min={1} max={90} defaultValue={rules.session_days} />
                <span className="meta">Después hay que volver a entrar. Se aplica a las sesiones nuevas.</span></label>
              <label className="field"><span className="label">Cerrar la sesión tras (horas sin usarlo)</span><input name="idle_hours" type="number" min={1} max={720} defaultValue={rules.idle_hours ?? ""} placeholder="sin límite" /></label>
            </div>
            <label className="checkbox"><input type="checkbox" name="export_admin_only" defaultChecked={rules.export_admin_only} />Solo los administradores pueden descargar datos (CSV)</label>
            <label className="checkbox"><input type="checkbox" name="alert_new_device" defaultChecked={rules.alert_new_device} />Avisar cuando un administrador entra desde un dispositivo nuevo <span className="meta">(los demás quedan en el registro)</span></label>
          </ActionForm>
        </section>
      )}

      {tab === "registro" && (
      <section className="today-stats" aria-label="Últimos 7 días">
        <Link href="/settings/security?tab=registro" className="today-stat"><span className="label">Entradas (7 días)</span><strong>{stats.ok}</strong></Link>
        <Link href="/settings/security?tab=registro&fallidos=1" className={`today-stat ${stats.bad ? "warn" : ""}`}><span className="label">Intentos fallidos</span><strong>{stats.bad}</strong></Link>
        <span className={`today-stat ${stats.locked ? "bad" : ""}`}><span className="label">Usuarios bloqueados ahora</span><strong>{stats.locked}</strong>
          {stats.locked > 0 && <span className="meta">desbloquéalos en <Link href="/settings/users">Usuarios</Link></span>}</span>
        <span className="today-stat"><span className="label">Sesiones abiertas</span><strong>{sessions.length}</strong></span>
      </section>
      )}

      {tab === "reglas" && (<>

      <section className="panel" aria-label="Entrar con Google o Microsoft">
        <h2>Entrar con Google o Microsoft</h2>
        {providers.length === 0 || !encryptionConfigured() ? (
          <p className="callout">Para mostrar «Continuar con Google / Microsoft» en la entrada hay que configurar la conexión con Google Workspace o Microsoft 365
            (las mismas claves que para conectar el correo, ver Ajustes → Correo). Cuando esté, aparecerán los botones solos.</p>
        ) : (
          <p className="meta" style={{ marginTop: 0 }}>Disponible con {providers.map((k) => PROVIDERS[k].label).join(" y ")}. Cada persona entra con la cuenta de su mismo correo; no le pedimos acceso a nada más.</p>
        )}
        <ActionForm action={saveSsoSettingsAction} submitLabel="Guardar acceso con Google y Microsoft" secondary
                    confirm={sso.passwordLogin ? "Quien no tenga cuenta de Google o Microsoft con su mismo correo dejará de poder entrar desde ya." : undefined}
                    confirmWhen={sso.passwordLogin ? { field: "password_login", value: "off" } : undefined}>
          <label className="field"><span className="label">Alta automática para el dominio de la empresa</span>
            <input name="sso_domain" defaultValue={sso.domain ?? ""} placeholder="p. ej. aikit.io (vacío = solo quien tenga usuario)" />
            <span className="meta">Quien entre con una cuenta de ese dominio y no tenga usuario se da de alta solo con el rol de abajo. Déjalo vacío para que solo entren los que des de alta tú.</span></label>
          <label className="field"><span className="label">Rol de quien se da de alta solo</span>
            <select name="sso_default_role" defaultValue={sso.defaultRole}>
              <option value="member">{ROLE_LABELS.member}</option>
              <option value="viewer">{ROLE_LABELS.viewer}</option>
            </select></label>
          <label className="field"><span className="label">Entrar con contraseña</span>
            <select name="password_login" defaultValue={sso.passwordLogin ? "on" : "off"}>
              <option value="on">Permitido para todos</option>
              <option value="off" disabled={providers.length === 0 || !encryptionConfigured()}>Solo administradores (el resto entra con Google o Microsoft)</option>
            </select>
            <span className="meta">Si la quitas, quien no tenga cuenta de Google o Microsoft con su mismo correo dejará de poder entrar.</span></label>
        </ActionForm>
      </section>

      <section className="panel" aria-label="Correos de acceso">
        <h2>Correos de invitación y de contraseña</h2>
        <p className="meta" style={{ marginTop: 0 }}>
          Las invitaciones salen del buzón del administrador que invita. Los enlaces de «¿Has olvidado tu contraseña?» y los avisos de seguridad salen de este buzón.
        </p>
        {mailboxes.length === 0 ? (
          <p className="callout">Ningún administrador tiene su correo conectado: los enlaces de invitación y de contraseña habrá que copiarlos y enviarlos a mano, y «¿Has olvidado tu contraseña?» no podrá enviar nada.
            Conéctalo en <Link href="/settings/mailbox">Correo, calendario y documentos</Link>.</p>
        ) : (
          <ActionForm action={saveSystemMailAction} submitLabel="Guardar buzón de envío" secondary>
            <label className="field"><span className="label">Enviar desde</span>
              <select name="user_id" defaultValue={mailSetting?.system_mail_user_id ?? ""}>
                <option value="">Automático ({autoSender?.email ?? mailboxes[0].email})</option>
                {mailboxes.map((m) => <option key={m.user_id} value={m.user_id}>{m.email} ({m.name})</option>)}
              </select>
              <span className="meta">Solo buzones de administradores: los enlaces quedan en su carpeta de enviados.</span></label>
          </ActionForm>
        )}
      </section>

      </>)}

      {tab === "registro" && (<>
      <section className="panel" aria-label="Registro de accesos">
        <div className="sign-head">
          <h2>Registro de accesos</h2>
          <nav className="chips" aria-label="Filtrar">
            <Link href="/settings/security?tab=registro" aria-current={!failedOnly ? "page" : undefined}>Todos</Link>
            <Link href="/settings/security?tab=registro&fallidos=1" aria-current={failedOnly ? "page" : undefined}>Solo fallidos</Link>
          </nav>
        </div>
        {events.length === 0 ? <p className="muted">Aún no hay entradas registradas.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Cuándo</th><th>Quién</th><th>Cómo</th><th>Resultado</th><th>Desde</th></tr></thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap">{dateTime(e.at)}</td>
                    <td>{e.user_name ?? <span className="muted">{e.email ?? "—"}</span>}{e.user_name && e.email && <div className="meta">{e.email}</div>}</td>
                    <td>{METHOD_LABEL[e.method] ?? e.method}</td>
                    <td>{e.success ? <span className="badge won">Entró</span> : <span className="badge lost">No entró</span>}{e.reason && <div className="meta">{e.reason}</div>}</td>
                    <td>{device(e.user_agent)}<div className="meta">{e.ip ?? ""}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" aria-label="Sesiones abiertas">
        <h2>Sesiones abiertas</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Persona</th><th>Dispositivo</th><th>Desde</th><th>Última actividad</th><th><span className="sr-only">Acciones</span></th></tr></thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>{s.name} <span className="meta">· {ROLE_LABELS[s.role]}</span></td>
                  <td>{device(s.user_agent)}</td>
                  <td className="nowrap">{dateTime(s.created_at)}</td>
                  <td className="nowrap">{dateTime(s.last_seen_at)}</td>
                  <td className="row-actions"><ActionForm action={endSessionAction.bind(null, s.id)} submitLabel="Cerrar sesión" secondary className="form inline"
                                                          confirm={`${s.name} tendrá que volver a entrar en ese dispositivo.`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-label="Descargas de datos" id="descargas">
        <h2>Descargas de datos</h2>
        {exportsList.length === 0 ? <p className="muted">Nadie ha descargado datos todavía.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Cuándo</th><th>Quién</th><th>Qué</th><th className="num">Filas</th><th>Desde</th></tr></thead>
            <tbody>{exportsList.map((e, i) => (
              <tr key={i}><td className="nowrap">{dateTime(e.at)}</td><td>{e.user_name ?? "—"}</td><td>{e.dataset}</td><td className="num">{e.rows}</td><td className="meta">{e.ip ?? ""}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      </>)}
    </main>
  );
}
