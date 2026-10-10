import Link from "next/link";
import { headers } from "next/headers";
import { listConnections, listOutboundMailboxes, availableSlots, providerOf, warmupLimit, type Connection } from "@/lib/mailbox";
import { disconnectOutboundAction, updateMailboxAction } from "@/app/actions/outbound";
import { sql } from "@/lib/db";
import { PROVIDER_LIST, PROVIDERS, redirectUri, type Provider } from "@/lib/integrations";
import { encryptionConfigured } from "@/lib/crypto";
import { formatSlots } from "@/lib/slots";
import { listUsers } from "@/lib/users";
import { requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { disconnectMailboxAction, syncMailboxAction, updateMailboxSettingsAction } from "@/app/actions/mailbox";
import { ActionForm } from "@/components/ActionForm";
import { RichTextField } from "@/components/RichTextField";
import { saveMailboxSignatureAction, saveSignatureAction } from "@/app/actions/email-editor";
import { Avatar } from "@/components/Avatar";

export const dynamic = "force-dynamic";
export const metadata = { title: "Correo, calendario y documentos" };

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

/** Pasos para activar cada proveedor (los hace una vez quien administra la cuenta de la empresa). */
function SetupSteps({ provider, redirect }: { provider: Provider; redirect: string }) {
  if (provider.key === "microsoft") {
    return (
      <ol className="steps">
        <li>En <strong>portal.azure.com → Microsoft Entra ID → Registros de aplicaciones → Nuevo registro</strong>, crea «CRM» (cuentas de esta organización).</li>
        <li>URI de redirección, tipo <strong>Web</strong>: <code>{redirect}</code></li>
        <li>En <strong>Permisos de API → Microsoft Graph → Delegados</strong>, añade <code>Mail.Read</code>, <code>Mail.Send</code>, <code>Calendars.ReadWrite</code>, <code>MailboxSettings.Read</code>, <code>Files.Read.All</code>, <code>User.Read</code> y <code>offline_access</code>. Si lo pide, «Conceder consentimiento de administrador».</li>
        <li>En <strong>Certificados y secretos</strong>, crea un secreto de cliente.</li>
        <li>En el servidor del CRM: <code>MS_CLIENT_ID</code> (Id. de aplicación), <code>MS_CLIENT_SECRET</code> y <code>MS_TENANT_ID</code> (Id. de directorio).</li>
      </ol>
    );
  }
  return (
    <ol className="steps">
      <li>En <strong>console.cloud.google.com</strong>, crea un proyecto y habilita <strong>Gmail API</strong>, <strong>Google Calendar API</strong> y <strong>Google Drive API</strong>.</li>
      <li>En <strong>Pantalla de consentimiento de OAuth</strong>, elige tipo <strong>Interno</strong> (solo cuentas de vuestro Google Workspace; así no hace falta que Google revise la app).</li>
      <li>En <strong>Credenciales → Crear credenciales → ID de cliente de OAuth</strong>, tipo <strong>Aplicación web</strong>, con este URI de redireccionamiento autorizado: <code>{redirect}</code></li>
      <li>Permisos que pedirá el CRM: enviar y leer correo de Gmail, ver y crear eventos del calendario, leer su zona horaria y ver los nombres de los archivos de Drive.</li>
      <li>En el servidor del CRM: <code>GOOGLE_CLIENT_ID</code> y <code>GOOGLE_CLIENT_SECRET</code>.</li>
    </ol>
  );
}

export default async function MailboxSettingsPage({ searchParams }: { searchParams: Promise<{ connected?: string; error?: string; outbound?: string }> }) {
  const [sp, me] = await Promise.all([searchParams, requireUser()]);
  const [users, connections, outbound] = await Promise.all([listUsers(), listConnections(), listOutboundMailboxes()]);
  const health = outbound.length ? await sql<{ mailbox_id: string; sent_today: number; sent_7d: number; bounced_7d: number }[]>`
    SELECT mailbox_id, count(*) FILTER (WHERE sent_at >= date_trunc('day', now()))::int AS sent_today,
           count(*)::int AS sent_7d, count(*) FILTER (WHERE bounced)::int AS bounced_7d
    FROM emails WHERE direction = 'out' AND mailbox_id = ANY(${outbound.map((m) => m.id)}::uuid[]) AND sent_at > now() - interval '7 days'
    GROUP BY mailbox_id` : [];
  // Cada uno ve su cuenta; un administrador, las de todo el equipo.
  const humans = users.filter((u) => u.kind === "human" && (me.role === "admin" || u.id === me.id));
  const sigs = new Map((await sql<{ id: string; email_signature: string | null }[]>`SELECT id, email_signature FROM users WHERE id = ANY(${humans.map((u) => u.id)}::uuid[])`)
    .map((r) => [r.id, r.email_signature ?? ""]));
  const encryption = encryptionConfigured();
  const available = PROVIDER_LIST.filter((p) => p.configured() && encryption);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;

  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Correo, calendario y documentos</h1>
          <p className="muted" style={{ margin: 0 }}>
            Cada persona puede conectar su cuenta de <strong>Microsoft 365</strong> (Outlook, calendario y OneDrive) o de{" "}
            <strong>Google Workspace</strong> (Gmail, Google Calendar y Drive). Con ella, los correos del CRM salen desde su buzón,
            los correos y reuniones con contactos se registran solos, la IA ofrece sus huecos libres y se enlazan documentos a los deals.
          </p>
        </div>
      </div>

      {sp.connected && <p className="callout good">{sp.outbound ? "Buzón de outbound conectado" : "Cuenta conectada"}: {sp.connected}.</p>}
      {sp.error && <p className="callout bad" role="alert">{sp.error}</p>}

      <section className="panel">
        <h2>Proveedores</h2>
        <ul className="provider-list">
          {PROVIDER_LIST.map((p) => {
            const missing = [...p.missingEnv(), ...(encryption ? [] : ["TOKEN_ENCRYPTION_KEY"])];
            return (
              <li key={p.key}>
                <div className="provider-row">
                  <strong>{p.label}</strong>
                  <span className="meta">{p.mail} · {p.calendar} · {p.drive}</span>
                  <span className={`badge ${missing.length ? "" : "won"}`}>{missing.length ? "Sin activar" : "Activo"}</span>
                </div>
                <details>
                  <summary className="meta">Cómo activarlo{missing.length > 0 && ` (falta: ${missing.join(", ")})`}</summary>
                  <SetupSteps provider={p} redirect={redirectUri(p.key, origin)} />
                  {!encryption && <p className="meta">Además, <code>TOKEN_ENCRYPTION_KEY</code>: una clave aleatoria de 32 caracteres o más para cifrar los accesos guardados. Y <code>APP_URL</code> con la dirección pública del CRM.</p>}
                </details>
              </li>
            );
          })}
        </ul>
      </section>

      <h2 className="section-title" style={{ marginTop: 22 }}>{me.role === "admin" ? "Cuentas del equipo" : "Tu cuenta"}</h2>
      <div className="rules">
        {humans.map((u) => {
          const conn = connections.find((c) => c.user_id === u.id);
          const p = conn ? providerOf(conn) : null;
          return (
            <article key={u.id} className="panel mailbox" aria-label={`Cuenta de ${u.name}`}>
              <div className="rule-head">
                <div className="mailbox-who">
                  <Avatar name={u.name} />
                  <div>
                    <h3>{u.name}</h3>
                    {conn && p ? (
                      <p className="meta" style={{ margin: 0 }}>
                        {p.label} · {conn.email} · <span className={`badge ${conn.status === "active" ? "won" : "lost"}`}>{conn.status === "active" ? "Conectada" : "Hay que reconectar"}</span>
                        {" "}· Última sincronización: {conn.mail_synced_at || conn.calendar_synced_at ? dateTime(conn.calendar_synced_at ?? conn.mail_synced_at) : "todavía no"}
                      </p>
                    ) : <p className="meta" style={{ margin: 0 }}>Sin cuenta conectada</p>}
                  </div>
                </div>
                <div className="head-actions">
                  {conn && conn.status === "active" && (
                    <ActionForm action={syncMailboxAction.bind(null, u.id)} submitLabel="Sincronizar ahora" pendingLabel="Sincronizando…" secondary className="form inline" />
                  )}
                  {conn && conn.status !== "active" && PROVIDERS[conn.provider].configured() && encryption && (
                    <a className="btn" href={`/api/integrations/${conn.provider}/connect?user=${u.id}`}>Reconectar {PROVIDERS[conn.provider].label}</a>
                  )}
                  {!conn && available.map((ap) => (
                    <a key={ap.key} className="btn secondary" href={`/api/integrations/${ap.key}/connect?user=${u.id}`}>Conectar {ap.label}</a>
                  ))}
                  {!conn && available.length === 0 && <span className="meta">Activa un proveedor para poder conectar</span>}
                  {conn && (
                    <ActionForm action={disconnectMailboxAction.bind(null, u.id)} submitLabel="Desconectar" pendingLabel="…" secondary className="form inline" />
                  )}
                </div>
              </div>
              {conn?.last_error && <p className="callout bad" style={{ margin: "12px 0 0" }}>{conn.last_error}</p>}

              <details className="ee-variant" open={!sigs.get(u.id) && u.id === me.id}>
                <summary className="meta">{sigs.get(u.id) ? "Firma de los correos ✓" : "Firma de los correos (sin firma todavía)"}</summary>
                <ActionForm action={saveSignatureAction.bind(null, u.id)} submitLabel="Guardar firma" secondary>
                  <RichTextField name="signature" initial={sigs.get(u.id) ?? ""} label={`Firma de ${u.name}`}
                                 hint="Va al final de los correos que salen de esta cuenta: desde la ficha del deal, las secuencias y los agentes. Admite variables como {{remitente}} y {{remitente_email}}. Puedes pegar la que ya usas en Outlook o Gmail." />
                </ActionForm>
              </details>
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

      {me.role === "admin" && (
        <section className="panel" style={{ marginTop: 22 }} aria-label="Buzones de outbound">
          <h2>Buzones de outbound</h2>
          <p className="muted">
            Para las campañas, usad buzones de <strong>dominios secundarios</strong> (p. ej. <code>aikit-mail.com</code>), nunca el principal: si una campaña
            rebota o la marcan como spam, vuestro dominio de siempre no se resiente. Cada buzón empieza enviando 10 correos al día y sube 5 cada día hasta su
            límite (calentamiento); si rebota más del 5 % en una semana, se pausa solo y te avisa.
          </p>
          {outbound.map((m) => {
            const h = health.find((x) => x.mailbox_id === m.id);
            const rate = h && h.sent_7d ? Math.round((h.bounced_7d / h.sent_7d) * 1000) / 10 : 0;
            return (
              <div key={m.id} className="mailbox-row">
                <div className="provider-row">
                  <strong>{m.email}</strong>
                  <span className="meta">{providerOf(m).label} · de {m.user_name} · hoy {h?.sent_today ?? 0} de {warmupLimit(m)} · 7 días: {h?.sent_7d ?? 0} enviados, {rate} % rebotes</span>
                  <span className={`badge ${m.paused || m.status !== "active" ? "lost" : "won"}`}>{m.status !== "active" ? "Reconectar" : m.paused ? "En pausa" : "Activo"}</span>
                </div>
                {m.paused_reason && m.paused && <p className="meta tone-bad" style={{ margin: 0 }}>{m.paused_reason}</p>}
                <ActionForm action={updateMailboxAction.bind(null, m.id)} submitLabel="Guardar" secondary className="form inline">
                  <label className="field"><span className="label">Límite diario</span><input name="daily_limit" type="number" min={1} max={500} defaultValue={m.daily_limit} style={{ width: 90 }} /></label>
                  <label className="field"><span className="label">Calentamiento desde</span><input name="warmup_start" type="date" defaultValue={m.warmup_start} /></label>
                  <label className="checkbox"><input type="checkbox" name="paused" defaultChecked={m.paused} />En pausa</label>
                </ActionForm>
                <details>
                  <summary className="meta">{m.signature ? "Firma propia de este buzón ✓" : `Firma: la de ${m.user_name}${m.user_signature ? "" : " (no tiene)"} · poner una propia`}</summary>
                  <ActionForm action={saveMailboxSignatureAction.bind(null, m.id)} submitLabel="Guardar firma del buzón" secondary>
                    <RichTextField name="signature" initial={m.signature ?? ""} label={`Firma de ${m.email}`}
                                   hint="Con dominios secundarios conviene una firma coherente con el buzón (nombre, web). Vacía, se usa la de la persona." />
                  </ActionForm>
                </details>
                <form action={disconnectOutboundAction.bind(null, m.id)}><button type="submit" className="link-btn meta">Desconectar</button></form>
              </div>
            );
          })}
          <div className="head-actions" style={{ marginTop: 10 }}>
            {available.map((p) => (
              <a key={p.key} className="btn secondary" href={`/api/integrations/${p.key}/connect?user=${me.id}&purpose=outbound`}>Conectar un buzón de {p.label}</a>
            ))}
            {available.length === 0 && <span className="meta">Activa antes Microsoft 365 o Google Workspace (arriba).</span>}
          </div>
        </section>
      )}
    </main>
  );
}
