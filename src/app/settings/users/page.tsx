import Link from "next/link";
import { createUserAction, resetPasswordAction, signOutUserAction, updateUserAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { Avatar } from "@/components/Avatar";
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
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Usuarios y permisos</h1>
          <p className="muted" style={{ margin: 0 }}>Quién entra al CRM y qué puede hacer. Lo que cada uno cambia queda a su nombre en la historia.</p>
        </div>
      </div>

      <section className="panel">
        <h2>Roles</h2>
        <ul className="plain-list">
          {(Object.keys(ROLE_TEXT) as (keyof typeof ROLE_TEXT)[]).map((r) => (
            <li key={r}><strong>{ROLE_LABELS[r]}</strong> <span className="muted">— {ROLE_TEXT[r]}</span></li>
          ))}
        </ul>
      </section>

      <h2 className="section-title" style={{ marginTop: 22 }}>Equipo</h2>
      <div className="rules">
        {users.map((u) => (
          <article key={u.id} className="panel mailbox" aria-label={`Usuario ${u.name}`}>
            <div className="rule-head">
              <div className="mailbox-who">
                <Avatar name={u.name} />
                <div>
                  <h3>{u.name}{u.id === me.id && <span className="meta"> (tú)</span>}</h3>
                  <p className="meta" style={{ margin: 0 }}>
                    {u.email ?? "sin email"} · {ROLE_LABELS[u.role]}
                    {!u.is_active && <> · <span className="badge lost">Desactivado</span></>}
                    {u.is_active && !u.has_password && <> · <span className="badge">Sin acceso</span></>}
                    {u.locked && <> · <span className="badge lost">Bloqueado por intentos fallidos</span></>}
                    {u.must_change_password && u.has_password && <> · contraseña temporal</>}
                    {" "}· Última entrada: {u.last_login_at ? dateTime(u.last_login_at) : "nunca"}
                    {u.open_deals > 0 && <> · {u.open_deals} deal{u.open_deals === 1 ? "" : "s"} abierto{u.open_deals === 1 ? "" : "s"}</>}
                  </p>
                </div>
              </div>
            </div>
            <details>
              <summary className="meta">Editar</summary>
              <ActionForm action={updateUserAction.bind(null, u.id)} submitLabel="Guardar" secondary className="form inline">
                <label className="field"><span className="label">Nombre</span><input name="name" required defaultValue={u.name} /></label>
                <label className="field"><span className="label">Email</span><input name="email" type="email" required defaultValue={u.email ?? ""} /></label>
                <RoleSelect value={u.role} />
                <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={u.is_active} />Activo</label>
              </ActionForm>
              <ActionForm action={resetPasswordAction.bind(null, u.id)} submitLabel={u.has_password ? "Poner contraseña temporal" : "Dar acceso"} secondary resetOnSuccess className="form inline">
                <label className="field"><span className="label">{u.has_password ? "Contraseña temporal" : "Contraseña inicial"}</span>
                  <input name="password" type="text" required minLength={10} autoComplete="off" /></label>
                <span className="meta">Pásasela por un canal seguro: tendrá que cambiarla al entrar. Desbloquea la cuenta y cierra sus sesiones.</span>
              </ActionForm>
              {u.sessions > 0 && u.id !== me.id && (
                <ActionForm action={signOutUserAction.bind(null, u.id)} submitLabel={`Cerrar sus sesiones (${u.sessions})`} secondary className="form inline" />
              )}
            </details>
          </article>
        ))}
      </div>

      <section className="panel" style={{ marginTop: 22 }}>
        <h2>Dar acceso a alguien</h2>
        <ActionForm action={createUserAction} submitLabel="Crear usuario" resetOnSuccess>
          <div className="grid-2">
            <label className="field"><span className="label">Nombre</span><input name="name" required /></label>
            <label className="field"><span className="label">Email</span><input name="email" type="email" required /></label>
            <RoleSelect />
            <label className="field"><span className="label">Contraseña inicial</span>
              <input name="password" type="text" required minLength={10} autoComplete="off" /></label>
          </div>
          <p className="meta" style={{ margin: 0 }}>Tendrá que cambiarla la primera vez que entre. Si ya existía (por ejemplo, traído de Pipedrive), se le da acceso conservando sus deals.</p>
        </ActionForm>
      </section>
    </main>
  );
}
