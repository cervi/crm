import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { ROLE_LABELS } from "@/lib/auth";
import type { SessionUser } from "@/lib/session";
import { connectionOf } from "@/lib/mailbox";

// Secciones de «Mi cuenta». Correo y reserva viven en sus propias rutas, pero
// se ven dentro del mismo marco para que el menú lateral no se pierda.
export const ACCOUNT_SECTIONS = [
  { key: "perfil", label: "Perfil y firma", icon: "user", href: "/account?tab=perfil" },
  { key: "preferencias", label: "Preferencias", icon: "system", href: "/account?tab=preferencias" },
  { key: "seguridad", label: "Contraseña y dispositivos", icon: "lock", href: "/account?tab=seguridad" },
  { key: "avisos", label: "Avisos y resúmenes", icon: "bell", href: "/account?tab=avisos" },
  { key: "correo", label: "Correo y calendario", icon: "inbox", href: "/settings/mailbox" },
  { key: "reserva", label: "Enlace de reserva", icon: "activities", href: "/settings/booking" },
] as const;
export type AccountSection = (typeof ACCOUNT_SECTIONS)[number]["key"];

export async function AccountShell({ user, active, hideNav, wide, children }: {
  user: Pick<SessionUser, "id" | "name" | "email" | "role">; active: AccountSection; hideNav?: boolean; wide?: boolean; children: React.ReactNode;
}) {
  const conn = await connectionOf(user.id).catch(() => null);
  const hasMail = conn?.status === "active";
  return (
    <main className="page">
      <div className="page-head account-head">
        <Avatar name={user.name} size="lg" />
        <div>
          <h1>{user.name}</h1>
          <p className="muted" style={{ margin: 0 }}>{user.email} · {ROLE_LABELS[user.role]}
            {" · "}{hasMail ? <>correo conectado ({conn!.email})</> : active === "correo" ? "correo sin conectar" : <Link href="/settings/mailbox">conecta tu correo</Link>}</p>
        </div>
      </div>
      <div className="settings-index">
        {!hideNav && (
          <aside className="settings-nav" aria-label="Secciones de tu cuenta">
            <nav>
              {ACCOUNT_SECTIONS.map((s) => (
                <Link key={s.key} href={s.href} aria-current={active === s.key ? "page" : undefined}><Icon name={s.icon} />{s.label}</Link>
              ))}
            </nav>
          </aside>
        )}
        <div className={`account-body${wide ? " wide" : ""}`}>{children}</div>
      </div>
    </main>
  );
}
