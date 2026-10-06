import Link from "next/link";
import { headers } from "next/headers";
import { listConnections, availableSlots, type Connection } from "@/lib/mailbox";
import { microsoftConfigured, redirectUri } from "@/lib/microsoft";
import { encryptionConfigured } from "@/lib/crypto";
import { formatSlots } from "@/lib/slots";
import { listUsers } from "@/lib/users";
import { dateTime } from "@/lib/format";
import { disconnectMailboxAction, syncMailboxAction, updateMailboxSettingsAction } from "@/app/actions/mailbox";
import { ActionForm } from "@/components/ActionForm";
import { Avatar } from "@/components/Avatar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Correo y calendario" };

const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

async function SlotsPreview({ conn }: { conn: Connection }) {
  try {
    const slots = await availableSlots(conn);
    return slots.length
      ? <pre className="slots-preview">{formatSlots(slots, conn.scheduling.timezone)}</pre>
      : <p className="muted">No hay huecos libres con estas preferencias en los próximos {conn.scheduling.horizon_days} días.</p>;
  } catch (err) {
    return <p className="tone-bad">{err instanceof Error ? err.message : "No se pudo leer el calendario."}</p>;
  }
}

export default async function MailboxSettingsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string }> }) {
  const sp = await searchParams;
  const [users, connections] = await Promise.all([listUsers(), listConnections()]);
  const humans = users.filter((u) => u.kind === "human");
  const ready = microsoftConfigured() && encryptionConfigured();
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;

  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Correo y calendario</h1>
          <p className="muted" style={{ margin: 0 }}>
            Conecta tu Outlook (Microsoft 365): los correos del CRM saldrán desde tu buzón y quedarán en «Enviados», los correos
            y reuniones con tus contactos se registrarán solos en sus deals, y la IA podrá ofrecer tus huecos libres.
          </p>
        </div>
      </div>

      {sp.connected && <p className="callout good">Correo conectado: {sp.connected}.</p>}
      {sp.error && <p className="callout bad" role="alert">{sp.error}</p>}

      {!ready && (
        <section className="panel">
          <h2>Falta configurar la conexión con Microsoft</h2>
          <p className="muted">Se hace una vez (lo hace quien administra Microsoft 365 en la empresa):</p>
          <ol className="steps">
            <li>En <strong>portal.azure.com → Microsoft Entra ID → Registros de aplicaciones → Nuevo registro</strong>, crea «CRM» (cuentas de esta organización).</li>
            <li>URI de redirección, tipo <strong>Web</strong>: <code>{redirectUri(origin)}</code></li>
            <li>En <strong>Permisos de API → Microsoft Graph → Delegados</strong>, añade: <code>Mail.Read</code>, <code>Mail.Send</code>, <code>Calendars.ReadWrite</code>, <code>MailboxSettings.Read</code>, <code>User.Read</code>, <code>offline_access</code>. Si te lo pide, «Conceder consentimiento de administrador».</li>
            <li>En <strong>Certificados y secretos</strong>, crea un secreto de cliente.</li>
            <li>Configura en el servidor del CRM: <code>MS_CLIENT_ID</code> (Id. de aplicación), <code>MS_CLIENT_SECRET</code>, <code>MS_TENANT_ID</code> (Id. de directorio), <code>APP_URL</code> y <code>TOKEN_ENCRYPTION_KEY</code> (una clave aleatoria de 32 caracteres o más).</li>
          </ol>
          <p className="meta">
            Ahora mismo falta: {[!process.env.MS_CLIENT_ID && "MS_CLIENT_ID", !process.env.MS_CLIENT_SECRET && "MS_CLIENT_SECRET",
              !encryptionConfigured() && "TOKEN_ENCRYPTION_KEY"].filter(Boolean).join(", ")}.
          </p>
        </section>
      )}

      <div className="rules">
        {humans.map((u) => {
          const conn = connections.find((c) => c.user_id === u.id);
          return (
            <article key={u.id} className="panel mailbox" aria-label={`Correo de ${u.name}`}>
              <div className="rule-head">
                <div className="mailbox-who">
                  <Avatar name={u.name} />
                  <div>
                    <h3>{u.name}</h3>
                    {conn ? (
                      <p className="meta" style={{ margin: 0 }}>
                        {conn.email} · <span className={`badge ${conn.status === "active" ? "won" : "lost"}`}>{conn.status === "active" ? "Conectado" : "Hay que reconectar"}</span>
                        {" "}· Última sincronización: {conn.mail_synced_at || conn.calendar_synced_at ? dateTime(conn.calendar_synced_at ?? conn.mail_synced_at) : "todavía no"}
                      </p>
                    ) : <p className="meta" style={{ margin: 0 }}>Sin correo conectado</p>}
                  </div>
                </div>
                <div className="head-actions">
                  {conn && conn.status === "active" && (
                    <ActionForm action={syncMailboxAction.bind(null, u.id)} submitLabel="Sincronizar ahora" pendingLabel="Sincronizando…" secondary className="form inline" />
                  )}
                  {ready && (!conn || conn.status !== "active") && (
                    <a className="btn" href={`/api/integrations/microsoft/connect?user=${u.id}`}>{conn ? "Reconectar Outlook" : "Conectar Outlook"}</a>
                  )}
                  {conn && (
                    <ActionForm action={disconnectMailboxAction.bind(null, u.id)} submitLabel="Desconectar" pendingLabel="…" secondary className="form inline" />
                  )}
                </div>
              </div>
              {conn?.last_error && <p className="callout bad" style={{ margin: "12px 0 0" }}>{conn.last_error}</p>}

              {conn && (
                <div className="mailbox-body">
                  <ActionForm action={updateMailboxSettingsAction.bind(null, u.id)} submitLabel="Guardar preferencias" secondary>
                    <fieldset className="fieldset">
                      <legend>Huecos que se ofrecen</legend>
                      <div className="field">
                        <span className="label">Días</span>
                        <div className="day-picks">
                          {WEEKDAYS.map((d, i) => (
                            <label key={d} className="checkbox">
                              <input type="checkbox" name={`day_${i + 1}`} defaultChecked={conn.scheduling.days.includes(i + 1)} />{d}
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="grid-4">
                        <label className="field"><span className="label">Desde</span><input type="time" name="start" defaultValue={conn.scheduling.start} /></label>
                        <label className="field"><span className="label">Hasta</span><input type="time" name="end" defaultValue={conn.scheduling.end} /></label>
                        <label className="field"><span className="label">Duración (min)</span><input type="number" name="duration" min={10} max={240} defaultValue={conn.scheduling.duration} /></label>
                        <label className="field"><span className="label">Margen entre reuniones (min)</span><input type="number" name="buffer" min={0} max={120} defaultValue={conn.scheduling.buffer} /></label>
                        <label className="field"><span className="label">Antelación mínima (horas)</span><input type="number" name="notice_hours" min={0} defaultValue={conn.scheduling.notice_hours} /></label>
                        <label className="field"><span className="label">Mirar los próximos (días)</span><input type="number" name="horizon_days" min={1} max={60} defaultValue={conn.scheduling.horizon_days} /></label>
                        <label className="field"><span className="label">Huecos a ofrecer</span><input type="number" name="count" min={1} max={10} defaultValue={conn.scheduling.count} /></label>
                        <label className="field"><span className="label">Máximo por día</span><input type="number" name="per_day" min={1} max={10} defaultValue={conn.scheduling.per_day} /></label>
                      </div>
                      <label className="field"><span className="label">Zona horaria</span><input name="timezone" defaultValue={conn.scheduling.timezone} placeholder="Europe/Madrid" /></label>
                    </fieldset>
                    <div className="day-picks">
                      <label className="checkbox"><input type="checkbox" name="sync_mail" defaultChecked={conn.sync_mail} />Registrar los correos con contactos del CRM</label>
                      <label className="checkbox"><input type="checkbox" name="sync_calendar" defaultChecked={conn.sync_calendar} />Registrar las reuniones con contactos del CRM</label>
                    </div>
                  </ActionForm>
                  {conn.status === "active" && (
                    <div>
                      <h3>Tus próximos huecos</h3>
                      <p className="meta">Así aparecerán en los correos con <code>{"{huecos}"}</code>.</p>
                      <SlotsPreview conn={conn} />
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}
