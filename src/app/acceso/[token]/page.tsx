import Link from "next/link";
import { completeTokenAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { encryptionConfigured } from "@/lib/crypto";
import { PROVIDERS } from "@/lib/integrations";
import { tokenInfo } from "@/lib/user-lifecycle";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tu contraseña", robots: { index: false } };

const REASON = {
  invalid: { title: "Este enlace no es válido", text: "Puede que esté incompleto. Ábrelo de nuevo desde el correo o pide otro." },
  expired: { title: "Este enlace ha caducado", text: "Por seguridad, los enlaces caducan. Pide otro y úsalo cuanto antes." },
  used: { title: "Este enlace ya se ha usado", text: "Cada enlace sirve una sola vez. Si ya creaste tu contraseña, entra con ella." },
  inactive: { title: "Tu usuario está desactivado", text: "Habla con un administrador de tu empresa." },
} as const;

/** Crear la contraseña (invitación) o poner una nueva (enlace de recuperación). */
export default async function AccessPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const info = await tokenInfo(token);
  if (!info.ok) {
    const r = REASON[info.reason];
    return (
      <main className="auth-card">
        <div className="auth-brand"><Icon name="deals" />CRM</div>
        <h1>{r.title}</h1>
        <p>{r.text}</p>
        <div className="form-actions">
          {info.reason !== "inactive" && <Link className="btn" href="/login/recuperar">Pedir un enlace nuevo</Link>}
          <Link className="btn secondary" href="/login">Ir a entrar</Link>
        </div>
      </main>
    );
  }
  const invite = info.purpose === "invite";
  const providers = encryptionConfigured() ? (["google", "microsoft"] as const).filter((k) => PROVIDERS[k].configured()) : [];
  return (
    <main className="auth-card">
      <div className="auth-brand"><Icon name="deals" />CRM</div>
      <div>
        <h1>{invite ? `Hola, ${info.name.split(" ")[0]}` : "Pon una contraseña nueva"}</h1>
        <p className="meta" style={{ margin: 0 }}>
          {invite ? <>{info.inviter ? `${info.inviter} te ha dado acceso.` : "Ya tienes acceso."} Crea tu contraseña para entrar.</> : <>Para {info.email}.</>}
        </p>
      </div>
      {invite && info.sso && providers.length > 0 && (
        <div className="sso-buttons">
          {providers.map((k) => (
            <a key={k} className="btn secondary sso-btn" href={`/api/integrations/${k}/login`}>Entrar con {k === "google" ? "Google" : "Microsoft"} ({info.email})</a>
          ))}
          <div className="or"><span>o crea una contraseña</span></div>
        </div>
      )}
      <ActionForm action={completeTokenAction.bind(null, token)} submitLabel={invite ? "Crear contraseña y entrar" : "Guardar y entrar"} pendingLabel="Guardando…">
        <input type="email" name="username" value={info.email} autoComplete="username" readOnly hidden />
        <label className="field"><span className="label">Contraseña nueva</span>
          <input name="password" type="password" required minLength={10} autoComplete="new-password" autoFocus />
          <span className="meta">Al menos 10 caracteres. Una frase corta que recuerdes funciona bien.</span></label>
        <label className="field"><span className="label">Repítela</span>
          <input name="repeat" type="password" required minLength={10} autoComplete="new-password" /></label>
      </ActionForm>
      {!invite && <p className="meta">Al guardarla se cierran tus sesiones abiertas en otros dispositivos.</p>}
    </main>
  );
}
