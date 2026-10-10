import Link from "next/link";
import { createUserAction, resetPasswordAction, signOutUserAction, updateUserAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { Avatar } from "@/components/Avatar";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { ROLE_LABELS, requireAdminPage } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { listAllUsers } from "@/lib/users";

export const dynamic = "force-dynamic";
export const metadata = { title: "Usuarios y permisos" };

const ROLE_TEXT = {
  admin: "Todo, incluidos los ajustes, la IA, la importación y los usuarios.",
  member: "Deals, leads, contactos, actividades, correo y la bandeja de la IA. Su propia cuenta de correo.",
  viewer: "Ve todo pero no puede cambiar nada.",
} as const;

function RoleSelect({ value }: { value?: string }) {
  return (
    <label className="field"><span className="label">Rol</span>
      <select name="role" defaultValue={value ?? "member"}>
        {(Object.keys(ROLE_LABELS) as (keyof typeof ROLE_LABELS)[]).map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
      </select>
    </label>
  );
}

export default async function UsersPage() {
  const me = await requireAdminPage();
  const users = await listAllUsers();
  const access = (u: (typeof users)[number]) =>
    !u.is_active ? { label: "Desactivado", cls: "", hint: "No puede entrar. Sus deals y su historia se conservan." }
    : u.locked ? { label: "Bloqueado", cls: "lost", hint: "Demasiados intentos fallidos. Ponle una contraseña temporal para desbloquearlo." }
    : !u.has_password ? { label: "Sin acceso", cls: "", hint: "Existe (por ejemplo, traído de Pipedrive) pero aún no puede entrar. Dale acceso con una contraseña inicial." }
    : u.must_change_password ? { label: "Contraseña temporal", cls: "warn", hint: "Tendrá que cambiarla al entrar." }
    : { label: "Activo", cls: "won", hint: "Puede entrar." };
  const sorted = [...users].sort((a, b) => (a.id === me.id ? -1 : b.id === me.id ? 1 : Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name)));

  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Usuarios y permisos</h1>
          <p className="muted" style={{ margin: 0 }}>Quién entra al CRM y qué puede hacer. Lo que cada uno cambia queda a su nombre en la historia.</p>
        </div>
        <div className="head-actions">
          <Drawer label={<><Icon name="plus" />Dar acceso a alguien</>} buttonClass="btn" title="Dar acceso a alguien"
                  subtitle="Tendrá que cambiar la contraseña la primera vez que entre.">
            <ActionForm action={createUserAction} submitLabel="Crear usuario" resetOnSuccess>
              <label className="field"><span className="label">Nombre *</span><input name="name" required /></label>
              <label className="field"><span className="label">Email *</span><input name="email" type="email" required /></label>
              <RoleSelect />
              <label className="field"><span className="label">Contraseña inicial *</span>
                <input name="password" type="text" required minLength={10} autoComplete="off" />
                <span className="meta">Mínimo 10 caracteres. Pásasela por un canal seguro.</span></label>
              <p className="meta" style={{ margin: 0 }}>Si ya existía (por ejemplo, traído de Pipedrive), se le da acceso conservando sus deals.</p>
            </ActionForm>
          </Drawer>
        </div>
      </div>

      <ul className="role-legend" aria-label="Qué puede hacer cada rol">
        {(Object.keys(ROLE_TEXT) as (keyof typeof ROLE_TEXT)[]).map((r) => (
          <li key={r}><strong>{ROLE_LABELS[r]}</strong><span>{ROLE_TEXT[r]}</span></li>
        ))}
      </ul>

      <div className="table-wrap">
        <table className="users-table">
          <thead><tr><th>Persona</th><th>Rol</th><th>Acceso</th><th>Última entrada</th><th className="num">Deals abiertos</th><th><span className="sr-only">Acciones</span></th></tr></thead>
          <tbody>
            {sorted.map((u) => {
              const a = access(u);
              return (
                <tr key={u.id} className={u.is_active ? undefined : "row-muted"}>
                  <td>
                    <span className="cell-main"><Avatar name={u.name} size="sm" />
                      <span><strong>{u.name}</strong>{u.id === me.id && <span className="meta"> (tú)</span>}<div className="meta">{u.email ?? "sin email"}</div></span>
                    </span>
                  </td>
                  <td>{ROLE_LABELS[u.role]}</td>
                  <td><span className={`badge ${a.cls}`} title={a.hint}>{a.label}</span></td>
                  <td className="nowrap">{u.last_login_at ? dateTime(u.last_login_at) : <span className="muted">Nunca</span>}</td>
                  <td className="num">{u.open_deals || <span className="muted">—</span>}</td>
                  <td className="row-actions">
                    <Drawer label="Editar" title={u.name} subtitle={`${u.email ?? "sin email"} · ${ROLE_LABELS[u.role]}`} buttonTitle={`Editar a ${u.name}`}>
                      <section className="drawer-section">
                        <h3>Datos y rol</h3>
                        <ActionForm action={updateUserAction.bind(null, u.id)} submitLabel="Guardar cambios">
                          <label className="field"><span className="label">Nombre *</span><input name="name" required defaultValue={u.name} /></label>
                          <label className="field"><span className="label">Email *</span><input name="email" type="email" required defaultValue={u.email ?? ""} /></label>
                          <RoleSelect value={u.role} />
                          <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={u.is_active} disabled={u.id === me.id} />Puede entrar al CRM (activo)</label>
                          {u.id === me.id && <input type="hidden" name="is_active" value="on" />}
                        </ActionForm>
                      </section>
                      <section className="drawer-section">
                        <h3>{u.has_password ? "Contraseña" : "Dar acceso"}</h3>
                        <p className="meta" style={{ marginTop: 0 }}>{u.has_password ? "Pon una contraseña temporal si la ha olvidado o está bloqueado: tendrá que cambiarla al entrar y se cierran sus sesiones." : "Ponle una contraseña inicial para que pueda entrar. Tendrá que cambiarla al entrar."}</p>
                        <ActionForm action={resetPasswordAction.bind(null, u.id)} submitLabel={u.has_password ? "Poner contraseña temporal" : "Dar acceso"} secondary resetOnSuccess>
                          <label className="field"><span className="label">{u.has_password ? "Contraseña temporal *" : "Contraseña inicial *"}</span>
                            <input name="password" type="text" required minLength={10} autoComplete="off" /></label>
                        </ActionForm>
                      </section>
                      {u.sessions > 0 && u.id !== me.id && (
                        <section className="drawer-section">
                          <h3>Sesiones abiertas</h3>
                          <p className="meta" style={{ marginTop: 0 }}>Tiene {u.sessions} sesión{u.sessions === 1 ? "" : "es"} abierta{u.sessions === 1 ? "" : "s"}. Ciérralas si ha perdido un dispositivo.</p>
                          <ActionForm action={signOutUserAction.bind(null, u.id)} submitLabel="Cerrar sus sesiones" secondary />
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
    </main>
  );
}
