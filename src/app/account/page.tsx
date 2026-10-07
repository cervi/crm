import { changePasswordAction, signOutOthersAction, updateProfileAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { RichTextField } from "@/components/RichTextField";
import { saveSignatureAction } from "@/app/actions/email-editor";
import { ROLE_LABELS, requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mi cuenta" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ change?: string }> }) {
  const [user, { change }] = await Promise.all([requireUser(), searchParams]);
  const sessions = await sql<{ created_at: Date; last_seen_at: Date; user_agent: string | null }[]>`
    SELECT created_at, last_seen_at, user_agent FROM sessions WHERE user_id = ${user.id} AND expires_at > now() ORDER BY last_seen_at DESC`;
  const [sig] = await sql<{ email_signature: string | null }[]>`SELECT email_signature FROM users WHERE id = ${user.id}`;
  return (
    <main className="page" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <div>
          <h1>Mi cuenta</h1>
          <p className="muted" style={{ margin: 0 }}>{user.email} · {ROLE_LABELS[user.role]}</p>
        </div>
      </div>

      {(change || user.must_change_password) && (
        <p className="callout" role="alert">Estás usando una contraseña temporal: elige una nueva para continuar.</p>
      )}

      <section className="panel">
        <h2>Contraseña</h2>
        <ActionForm action={changePasswordAction} submitLabel="Cambiar contraseña" resetOnSuccess>
          <label className="field"><span className="label">Contraseña actual</span>
            <input name="current" type="password" required autoComplete="current-password" /></label>
          <div className="grid-2">
            <label className="field"><span className="label">Nueva contraseña</span>
              <input name="password" type="password" required minLength={10} autoComplete="new-password" /></label>
            <label className="field"><span className="label">Repítela</span>
              <input name="repeat" type="password" required minLength={10} autoComplete="new-password" /></label>
          </div>
          <p className="meta" style={{ margin: 0 }}>Al menos 10 caracteres. Al cambiarla se cierran tus sesiones en otros dispositivos.</p>
        </ActionForm>
      </section>

      {!user.must_change_password && (
        <>
          <section className="panel">
            <h2>Tus datos</h2>
            <ActionForm action={updateProfileAction} submitLabel="Guardar" secondary className="form inline">
              <label className="field"><span className="label">Nombre</span><input name="name" required defaultValue={user.name} /></label>
            </ActionForm>
            <p className="meta">El email y el rol los cambia un administrador.</p>
          </section>

          <section className="panel" aria-label="Firma">
            <h2>Firma de tus correos</h2>
            <ActionForm action={saveSignatureAction} submitLabel="Guardar firma" secondary>
              <RichTextField name="signature" initial={sig?.email_signature ?? ""} label="Firma" />
              <p className="meta" style={{ margin: 0 }}>Se añade al final de los correos de las secuencias (si la secuencia lo tiene activado). Admite variables como {"{{remitente}}"}.</p>
            </ActionForm>
          </section>

          <section className="panel">
            <h2>Sesiones abiertas</h2>
            <ul className="plain-list">
              {sessions.map((s, i) => (
                <li key={i}>
                  <strong>{browserName(s.user_agent)}</strong>{" "}
                  <span className="meta">· desde el {dateTime(s.created_at)} · última actividad {dateTime(s.last_seen_at)}</span>
                </li>
              ))}
            </ul>
            {sessions.length > 1 && (
              <ActionForm action={signOutOthersAction} submitLabel="Cerrar las demás sesiones" secondary />
            )}
          </section>
        </>
      )}
    </main>
  );
}

function browserName(ua: string | null): string {
  if (!ua) return "Navegador";
  const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${b} en ${os}` : b;
}
