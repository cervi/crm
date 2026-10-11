import Link from "next/link";
import {
  anonymizeUserAction, cancelInviteAction, inviteUserAction, offboardUserAction, reactivateUserAction, resendInviteAction,
  resetPasswordAction, sendResetLinkAction, setUserSsoAction, signOutUserAction, updateUserAction,
} from "@/app/actions/auth";
import { METHOD_LABEL } from "@/lib/login-log";
import { PROVIDERS } from "@/lib/integrations";
import { encryptionConfigured } from "@/lib/crypto";
import { ActionForm } from "@/components/ActionForm";
import { Avatar } from "@/components/Avatar";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { ROLE_LABELS, requireAdminPage } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { AUDIT_TEXT, needsReceiver, offboardPreview, systemSender, userHistory, type OffboardPreview } from "@/lib/user-lifecycle";
import { listAllUsers, type AdminUserRow } from "@/lib/users";

export const dynamic = "force-dynamic";
export const metadata = { title: "Usuarios y permisos" };

const ROLE_TEXT = {
  admin: "Todo, incluidos los ajustes, la IA, la importación y los usuarios.",
  member: "Deals, leads, contactos, actividades, correo y la bandeja de la IA. Su propia cuenta de correo.",
  viewer: "Ve todo pero no puede cambiar nada.",
} as const;

const TABS = [
  { key: "activos", label: "Con acceso" },
  { key: "invitados", label: "Invitaciones" },
  { key: "baja", label: "Dados de baja" },
] as const;
type Tab = (typeof TABS)[number]["key"];

function RoleSelect({ value }: { value?: string }) {
  return (
    <label className="field"><span className="label">Rol</span>
      <select name="role" defaultValue={value ?? "member"}>
        {(Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
      </select>
    </label>
  );
}

// Aún no ha entrado nunca y no tiene contraseña: está invitado (o pendiente de invitar).
const pending = (u: AdminUserRow) => u.is_active && !u.has_password && !u.last_login_at;
const tabOf = (u: AdminUserRow): Tab => (!u.is_active ? "baja" : pending(u) ? "invitados" : "activos");
const until = (d: Date) => {
  const h = Math.round((new Date(d).getTime() - Date.now()) / 3600000);
  return h <= 0 ? "caducada" : h < 48 ? `caduca en ${h} h` : `caduca en ${Math.round(h / 24)} días`;
};

function PreviewList({ p }: { p: OffboardPreview }) {
  const items = [
    [p.deals, "deal abierto", "deals abiertos"], [p.leads, "lead abierto", "leads abiertos"], [p.activities, "actividad pendiente", "actividades pendientes"],
    [p.persons, "contacto", "contactos"], [p.organizations, "empresa", "empresas"], [p.campaigns, "campaña", "campañas"],
    [p.enrollments, "contacto en secuencias", "contactos en secuencias"], [p.outbound, "buzón de outbound", "buzones de outbound"],
    [p.rules, "regla de reparto", "reglas de reparto"],
  ].filter(([n]) => Number(n) > 0) as [number, string, string][];
  return items.length
    ? <ul className="plain-list">{items.map(([n, one, many]) => <li key={one}><strong>{n}</strong> {n === 1 ? one : many}</li>)}</ul>
    : <p className="meta" style={{ margin: 0 }}>No lleva deals, leads ni tareas abiertas.</p>;
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ ver?: string }> }) {
  const [me, sp] = await Promise.all([requireAdminPage(), searchParams]);
  const users = await listAllUsers();
  const ssoReady = encryptionConfigured() && (PROVIDERS.google.configured() || PROVIDERS.microsoft.configured());
  const sender = await systemSender(me.id);
  const counts = { activos: 0, invitados: 0, baja: 0 } as Record<Tab, number>;
  for (const u of users) counts[tabOf(u)]++;
  const view: Tab = TABS.find((t) => t.key === sp.ver)?.key ?? "activos";
  const shown = users.filter((u) => tabOf(u) === view)
    .sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name)));
  const [previews, histories] = await Promise.all([
    Promise.all(shown.map((u) => (u.is_active && u.id !== me.id ? offboardPreview(u.id) : Promise.resolve(null)))),
    Promise.all(shown.map((u) => userHistory(u.id, 12))),
  ]);
  const owners = users.filter((u) => u.is_active && u.role !== "viewer" && (u.has_password || u.sso_enabled));

  const access = (u: AdminUserRow) =>
    u.anonymized_at ? { label: "Datos borrados", cls: "", hint: "Sus datos personales se borraron. Su historia queda como «Usuario eliminado»." }
    : !u.is_active ? { label: "De baja", cls: "", hint: "No puede entrar. Su historia se conserva." }
    : u.locked ? { label: "Bloqueado", cls: "lost", hint: "Envíale un enlace para cambiar la contraseña." }
    : pending(u) && u.invite_expires_at && new Date(u.invite_expires_at) > new Date() ? { label: "Invitación enviada", cls: "", hint: "Aún no ha creado su contraseña." }
    : pending(u) && u.invited_at ? { label: "Invitación caducada", cls: "warn", hint: "Reenvíale la invitación." }
    : pending(u) ? { label: "Sin invitar", cls: "", hint: "Existe (por ejemplo, traído de Pipedrive) pero aún no puede entrar." }
    : !u.has_password && u.sso_enabled ? { label: "Con Google/Microsoft", cls: "", hint: "" }
    : u.must_change_password ? { label: "Contraseña temporal", cls: "warn", hint: "Tendrá que cambiarla al entrar." }
    : { label: "Activo", cls: "", hint: "" };

  const senderText = sender
    ? sender.user_id === me.id ? `Le llegará un correo desde tu buzón (${sender.email}).` : `Le llegará un correo desde ${sender.email}.`
    : "No hay ningún buzón conectado: te daremos el enlace para que se lo envíes tú.";

  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Usuarios y permisos</h1>
          <p className="muted" style={{ margin: 0 }}>Quién entra al CRM y qué puede hacer. <Link href="/settings/security">Registro de accesos</Link></p>
        </div>
        <div className="head-actions">
          <Drawer label={<><Icon name="plus" />Invitar a alguien</>} buttonClass="btn" title="Invitar a alguien"
                  subtitle="Recibe un enlace para crear su propia contraseña. Nadie más la conoce.">
            <ActionForm action={inviteUserAction} submitLabel="Dar acceso" pendingLabel="Enviando…" resetOnSuccess>
              <label className="field"><span className="label">Nombre *</span><input name="name" required autoComplete="off" /></label>
              <label className="field"><span className="label">Email *</span><input name="email" type="email" required autoComplete="off" /></label>
              <RoleSelect />
              {ssoReady && <label className="checkbox"><input type="checkbox" name="sso" defaultChecked /> También puede entrar con su cuenta de Google o Microsoft</label>}
              <p className="meta" style={{ margin: 0 }}>{senderText} El enlace caduca en 7 días. Si ya existía (por ejemplo, traído de Pipedrive), conserva sus deals.</p>
              <details className="drawer-more">
                <summary className="meta">Prefiero ponerle yo una contraseña inicial (sin correo)</summary>
                <label className="field"><span className="label">Contraseña inicial</span>
                  <input name="password" type="text" minLength={10} autoComplete="off" />
                  <span className="meta">Mínimo 10 caracteres. Pásasela por un canal seguro: tendrá que cambiarla al entrar. Si la escribes, no se envía invitación.</span></label>
              </details>
            </ActionForm>
          </Drawer>
        </div>
      </div>

      <ul className="role-legend" aria-label="Qué puede hacer cada rol">
        {(Object.keys(ROLE_TEXT) as (keyof typeof ROLE_TEXT)[]).map((r) => (
          <li key={r}><strong>{ROLE_LABELS[r]}</strong><span>{ROLE_TEXT[r]}</span></li>
        ))}
      </ul>

      <nav className="tabs" aria-label="Usuarios">
        {TABS.map((t) => (
          <Link key={t.key} href={`/settings/users?ver=${t.key}`} aria-current={view === t.key ? "page" : undefined}>
            {t.label}{counts[t.key] ? <span className={t.key === "invitados" ? "count" : "count neutral"}>{counts[t.key]}</span> : null}
          </Link>
        ))}
      </nav>

      {shown.length === 0 ? (
        <section className="panel empty">
          {view === "invitados" ? <p>No hay invitaciones pendientes.</p> : view === "baja" ? <p>Nadie dado de baja.</p> : <p>Nadie con acceso todavía.</p>}
        </section>
      ) : (
        <div className="table-wrap">
          <table className="users-table">
            <thead><tr><th>Persona</th><th>Rol</th><th>Acceso</th><th>{view === "baja" ? "Baja" : view === "invitados" ? "Invitación" : "Última entrada"}</th>
              {view === "activos" && <th className="num">Deals abiertos</th>}<th><span className="sr-only">Acciones</span></th></tr></thead>
            <tbody>
              {shown.map((u, idx) => {
                const a = access(u);
                const preview = previews[idx];
                const history = histories[idx];
                const self = u.id === me.id;
                return (
                  <tr key={u.id} className={u.is_active ? undefined : "row-muted"}>
                    <td>
                      <span className="cell-main"><Avatar name={u.name} size="sm" />
                        <span><strong>{u.name}</strong>{self && <span className="meta"> (tú)</span>}<div className="meta">{u.email ?? "sin email"}</div></span>
                      </span>
                    </td>
                    <td>{ROLE_LABELS[u.role]}</td>
                    <td><span className={`badge ${a.cls}`}>{a.label}</span>{a.hint && view !== "baja" && <div className="meta">{a.hint}</div>}</td>
                    <td className="nowrap">
                      {view === "baja" ? (u.deactivated_at ? <>{dateTime(u.deactivated_at)}{u.deactivated_by_name && <div className="meta">por {u.deactivated_by_name}</div>}</> : <span className="muted">—</span>)
                        : view === "invitados" ? (u.invited_at ? <>{dateTime(u.invited_at)}{u.invite_expires_at && <div className="meta">{until(u.invite_expires_at)}</div>}</> : <span className="muted">Sin invitar</span>)
                        : u.last_login_at ? <>{dateTime(u.last_login_at)}{u.last_login_method && <div className="meta">con {METHOD_LABEL[u.last_login_method]?.toLowerCase() ?? u.last_login_method}</div>}</> : <span className="muted">Nunca</span>}
                      {view === "activos" && u.failed_logins > 0 && <div className="meta tone-bad">{u.failed_logins} intento{u.failed_logins === 1 ? "" : "s"} fallido{u.failed_logins === 1 ? "" : "s"}</div>}
                    </td>
                    {view === "activos" && <td className="num">{u.open_deals || <span className="muted">—</span>}</td>}
                    <td className="row-actions">
                      {pending(u) && (
                        <ActionForm action={resendInviteAction.bind(null, u.id)} className="form inline" secondary
                                    submitLabel={u.invited_at ? "Reenviar invitación" : "Invitar"} pendingLabel="Enviando…" />
                      )}
                      <Drawer label="Gestionar" buttonClass="btn secondary" title={u.name} subtitle={`${u.email ?? "sin email"} · ${ROLE_LABELS[u.role]} · ${a.label}`} buttonTitle={`Gestionar a ${u.name}`}>
                        {u.is_active ? (
                          <>
                            <section className="drawer-section">
                              <h3>Datos y rol</h3>
                              <ActionForm action={updateUserAction.bind(null, u.id)} submitLabel="Guardar cambios" secondary={pending(u)}>
                                <label className="field"><span className="label">Nombre *</span><input name="name" required defaultValue={u.name} /></label>
                                <label className="field"><span className="label">Email *</span><input name="email" type="email" required defaultValue={u.email ?? ""} /></label>
                                <RoleSelect value={u.role} />
                              </ActionForm>
                            </section>

                            <section className="drawer-section">
                              <h3>{pending(u) ? "Invitación" : "Contraseña"}</h3>
                              {pending(u) ? (
                                <>
                                  <p className="meta" style={{ margin: 0 }}>
                                    {u.invite_expires_at && new Date(u.invite_expires_at) > new Date()
                                      ? `Invitación enviada el ${dateTime(u.invited_at!)}${u.invite_sent_from ? ` desde ${u.invite_sent_from}` : " (sin correo: enlace para copiar)"}; ${until(u.invite_expires_at)}.`
                                      : u.invited_at ? "La invitación caducó. Reenvíala para que reciba un enlace nuevo." : "Todavía no le has invitado."}
                                  </p>
                                  <ActionForm action={resendInviteAction.bind(null, u.id)} submitLabel={u.invited_at ? "Reenviar invitación" : "Enviar invitación"} pendingLabel="Enviando…" />
                                  {u.invited_at && <ActionForm action={cancelInviteAction.bind(null, u.id)} submitLabel="Cancelar la invitación" secondary className="form inline"
                                                               confirm="El enlace dejará de servir. Seguirá en la lista, sin acceso; para quitarle del todo, dale de baja." />}
                                </>
                              ) : (
                                <>
                                  <p className="meta" style={{ margin: 0 }}>{u.has_password ? "Si la ha olvidado o se ha bloqueado, envíale un enlace para que ponga una nueva." : "Entra con Google o Microsoft. Si quiere también una contraseña, envíale un enlace para crearla."} El enlace caduca en 24 horas.</p>
                                  <ActionForm action={sendResetLinkAction.bind(null, u.id)} submitLabel="Enviar enlace para cambiar la contraseña" pendingLabel="Enviando…" secondary />
                                </>
                              )}
                              <details className="drawer-more">
                                <summary className="meta">{u.has_password ? "Ponerle yo una contraseña temporal" : "Ponerle yo una contraseña inicial"}</summary>
                                <ActionForm action={resetPasswordAction.bind(null, u.id)} submitLabel={u.has_password ? "Poner contraseña temporal" : "Dar acceso"} secondary resetOnSuccess>
                                  <label className="field"><span className="label">Contraseña *</span>
                                    <input name="password" type="text" required minLength={10} autoComplete="off" />
                                    <span className="meta">Mínimo 10 caracteres. Tendrá que cambiarla al entrar y se cierran sus sesiones.</span></label>
                                </ActionForm>
                              </details>
                            </section>

                            <section className="drawer-section">
                              <h3>Google o Microsoft</h3>
                              {!ssoReady ? (
                                <p className="meta" style={{ margin: 0 }}>Primero hay que configurar la conexión en <Link href="/settings/security">Accesos y seguridad</Link>.</p>
                              ) : (
                                <>
                                  <p className="meta" style={{ margin: 0 }}>{u.sso_enabled
                                    ? `Puede entrar con la cuenta de Google o Microsoft de ${u.email ?? "su correo"}${u.has_password ? " (y también con su contraseña)" : ""}.`
                                    : `Deja que entre con la cuenta de Google o Microsoft de ${u.email ?? "su correo"}, sin contraseña.`}</p>
                                  <ActionForm action={setUserSsoAction.bind(null, u.id, !u.sso_enabled)} secondary className="form inline"
                                              submitLabel={u.sso_enabled ? "Quitar la entrada con Google/Microsoft" : "Permitir entrar con Google/Microsoft"}
                                              confirm={u.sso_enabled && !u.has_password ? "Sin contraseña ni Google/Microsoft no podrá entrar." : undefined} />
                                </>
                              )}
                            </section>

                            {u.sessions > 0 && !self && (
                              <section className="drawer-section">
                                <h3>Sesiones abiertas</h3>
                                <p className="meta" style={{ margin: 0 }}>Tiene {u.sessions} sesión{u.sessions === 1 ? "" : "es"} abierta{u.sessions === 1 ? "" : "s"}. Ciérralas si ha perdido un dispositivo.</p>
                                <ActionForm action={signOutUserAction.bind(null, u.id)} submitLabel="Cerrar sus sesiones" secondary />
                              </section>
                            )}

                            {!self && preview && (
                              <section className="drawer-section danger-zone">
                                <h3>Dar de baja</h3>
                                <p className="meta" style={{ margin: 0 }}>Deja de poder entrar al momento y se cierran sus sesiones. Su historia (correos, notas, deals ganados) se conserva a su nombre.</p>
                                <PreviewList p={preview} />
                                {preview.mailbox && <p className="meta" style={{ margin: 0 }}>Se desconecta su correo ({preview.mailbox}){preview.booking ? " y se desactiva su página de reservas" : ""}.</p>}
                                {preview.solo_rules > 0 && <p className="meta" style={{ margin: 0 }}>Si no eliges a nadie, {preview.solo_rules === 1 ? "la regla de reparto en la que solo está se desactivará" : `las ${preview.solo_rules} reglas de reparto en las que solo está se desactivarán`}.</p>}
                                <ActionForm action={offboardUserAction.bind(null, u.id)} submitLabel="Dar de baja" danger
                                            confirm={`${u.name} no podrá entrar.${needsReceiver(preview) ? " Todo lo de la lista pasará a la persona elegida." : ""} Puedes reactivarle más adelante, pero lo traspasado no vuelve solo.`}>
                                  <label className="field"><span className="label">Pasar lo que lleva a{needsReceiver(preview) ? " *" : ""}</span>
                                    <select name="to" defaultValue="" required={needsReceiver(preview)}>
                                      <option value="">{needsReceiver(preview) ? "Elige a quién" : "— Nadie —"}</option>
                                      {owners.filter((o) => o.id !== u.id).map((o) => <option key={o.id} value={o.id}>{o.name}{o.id === me.id ? " (tú)" : ""}</option>)}
                                    </select>
                                    <span className="meta">Deals y leads abiertos, actividades pendientes, contactos, empresas, campañas y secuencias.</span></label>
                                </ActionForm>
                              </section>
                            )}
                          </>
                        ) : (
                          <>
                            {!u.anonymized_at && (
                              <section className="drawer-section">
                                <h3>Reactivar</h3>
                                <p className="meta" style={{ margin: 0 }}>Vuelve a poder entrar con su contraseña de antes. Lo que se traspasó al darle de baja sigue donde está, y tendrá que volver a conectar su correo.</p>
                                <ActionForm action={reactivateUserAction.bind(null, u.id)} submitLabel="Reactivar" />
                              </section>
                            )}
                            {!u.anonymized_at && (
                              <section className="drawer-section danger-zone">
                                <h3>Borrar sus datos personales</h3>
                                <p className="meta" style={{ margin: 0 }}>Por si lo pide (RGPD). Se borran su nombre, su correo y sus accesos; sus deals y su historia quedan a nombre de «Usuario eliminado». No se puede deshacer.</p>
                                <ActionForm action={anonymizeUserAction.bind(null, u.id)} submitLabel="Borrar datos personales" danger
                                            confirm={`Se borran para siempre el nombre y el correo de ${u.name}. No se puede deshacer.`} />
                              </section>
                            )}
                          </>
                        )}

                        {history.length > 0 && (
                          <section className="drawer-section">
                            <h3>Historial</h3>
                            <ol className="audit-list">
                              {history.map((h) => (
                                <li key={h.id}>
                                  <span className="meta nowrap">{dateTime(h.at)}</span>
                                  <span>{AUDIT_TEXT[h.action] ?? h.action}
                                    {h.action === "role_changed" ? ` (${ROLE_LABELS[h.detail.from as keyof typeof ROLE_LABELS] ?? ""} → ${ROLE_LABELS[h.detail.to as keyof typeof ROLE_LABELS] ?? ""})` : ""}
                                    {h.action === "deactivated" && h.detail.to_name ? ` · traspasado a ${h.detail.to_name}` : ""}
                                    {h.actor_name && h.actor_id !== u.id ? <span className="meta"> · {h.actor_name}</span> : null}</span>
                                </li>
                              ))}
                            </ol>
                          </section>
                        )}
                      </Drawer>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
