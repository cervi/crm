import Link from "next/link";
import { endSessionAction, saveSsoSettingsAction, saveSystemMailAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { requireAdminPage, ROLE_LABELS } from "@/lib/auth";
import { encryptionConfigured } from "@/lib/crypto";
import { sql } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { PROVIDERS } from "@/lib/integrations";
import { listLoginEvents, METHOD_LABEL } from "@/lib/login-log";
import { getSsoSettings } from "@/lib/sso";
import { systemSender } from "@/lib/user-lifecycle";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accesos y seguridad" };

const device = (ua: string | null) => {
  if (!ua) return "—";
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  return [br, os].filter(Boolean).join(" · ");
};

export default async function SecurityPage({ searchParams }: { searchParams: Promise<{ fallidos?: string }> }) {
  await requireAdminPage();
  const sp = await searchParams;
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
          <h1>Accesos y seguridad</h1>
          <p className="muted" style={{ margin: 0 }}>Cómo se entra al CRM, quién ha entrado y desde dónde.</p>
        </div>
      </div>

      <section className="today-stats" aria-label="Últimos 7 días">
        <Link href="/settings/security" className="today-stat"><span className="label">Entradas (7 días)</span><strong>{stats.ok}</strong></Link>
        <Link href="/settings/security?fallidos=1" className={`today-stat ${stats.bad ? "warn" : ""}`}><span className="label">Intentos fallidos</span><strong>{stats.bad}</strong></Link>
        <span className={`today-stat ${stats.locked ? "bad" : ""}`}><span className="label">Usuarios bloqueados ahora</span><strong>{stats.locked}</strong>
          {stats.locked > 0 && <span className="meta">desbloquéalos en <Link href="/settings/users">Usuarios</Link></span>}</span>
        <span className="today-stat"><span className="label">Sesiones abiertas</span><strong>{sessions.length}</strong></span>
      </section>

      <section className="panel" aria-label="Entrar con Google o Microsoft">
        <h2>Entrar con Google o Microsoft</h2>
        {providers.length === 0 || !encryptionConfigured() ? (
          <p className="callout">Para mostrar «Continuar con Google / Microsoft» en la entrada hay que configurar la conexión con Google Workspace o Microsoft 365
            (las mismas claves que para conectar el correo, ver Ajustes → Correo). Cuando esté, aparecerán los botones solos.</p>
        ) : (
          <p className="meta" style={{ marginTop: 0 }}>Disponible con {providers.map((k) => PROVIDERS[k].label).join(" y ")}. Cada persona entra con la cuenta de su mismo correo; no le pedimos acceso a nada más.</p>
        )}
        <ActionForm action={saveSsoSettingsAction} submitLabel="Guardar">
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
          <ActionForm action={saveSystemMailAction} submitLabel="Guardar">
            <label className="field"><span className="label">Enviar desde</span>
              <select name="user_id" defaultValue={mailSetting?.system_mail_user_id ?? ""}>
                <option value="">Automático ({autoSender?.email ?? mailboxes[0].email})</option>
                {mailboxes.map((m) => <option key={m.user_id} value={m.user_id}>{m.email} ({m.name})</option>)}
              </select>
              <span className="meta">Solo buzones de administradores: los enlaces quedan en su carpeta de enviados.</span></label>
          </ActionForm>
        )}
      </section>

      <section className="panel" aria-label="Registro de accesos">
        <div className="sign-head">
          <h2>Registro de accesos</h2>
          <nav className="chips" aria-label="Filtrar">
            <Link href="/settings/security" aria-current={!failedOnly ? "page" : undefined}>Todos</Link>
            <Link href="/settings/security?fallidos=1" aria-current={failedOnly ? "page" : undefined}>Solo fallidos</Link>
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
    </main>
  );
}
