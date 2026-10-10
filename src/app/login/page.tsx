import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { currentUser, safeNext } from "@/lib/auth";
import { encryptionConfigured } from "@/lib/crypto";
import { PROVIDERS } from "@/lib/integrations";
import { needsSetup } from "@/lib/session";
import { getSsoSettings } from "@/lib/sso";

export const dynamic = "force-dynamic";
export const metadata = { title: "Entrar" };

const GoogleMark = () => (
  <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
    <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
    <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
    <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
  </svg>
);
const MicrosoftMark = () => (
  <svg viewBox="0 0 23 23" width="16" height="16" aria-hidden="true">
    <path fill="#f35325" d="M1 1h10v10H1z" /><path fill="#81bc06" d="M12 1h10v10H12z" /><path fill="#05a6f0" d="M1 12h10v10H1z" /><path fill="#ffba08" d="M12 12h10v10H12z" />
  </svg>
);

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  if (await currentUser()) redirect(safeNext(next));
  if (await needsSetup()) redirect("/setup");
  // Solo en la demo local (npm run demo): el acceso de prueba, a la vista.
  const demo = process.env.NODE_ENV !== "production" ? process.env.DEMO_LOGIN_HINT : undefined;
  const sso = await getSsoSettings();
  const providers = encryptionConfigured() ? (["google", "microsoft"] as const).filter((k) => PROVIDERS[k].configured()) : [];
  const q = next ? `?${new URLSearchParams({ next: safeNext(next) })}` : "";
  return (
    <div className="login">
      <aside className="login-side" aria-hidden="true">
        <div className="auth-brand light"><Icon name="deals" />CRM</div>
        <div>
          <h2>Tu día de ventas, ordenado.</h2>
          <ul>
            <li><Icon name="check" />Lo que toca hoy y los deals que piden atención</li>
            <li><Icon name="check" />La IA prepara correos, reuniones y siguientes pasos</li>
            <li><Icon name="check" />Contratos firmados y documentos con seguimiento</li>
          </ul>
        </div>
        <p className="meta">Si tienes problemas para entrar, habla con un administrador de tu empresa.</p>
      </aside>
      <main className="auth-card login-card">
        <div className="auth-brand"><Icon name="deals" />CRM</div>
        <div>
          <h1>Entrar</h1>
          <p className="meta">Bienvenido de nuevo.</p>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {providers.length > 0 && (
          <div className="sso-buttons">
            {providers.map((k) => (
              <a key={k} className="btn secondary sso-btn" href={`/api/integrations/${k}/login${q}`}>
                {k === "google" ? <GoogleMark /> : <MicrosoftMark />}Continuar con {k === "google" ? "Google" : "Microsoft"}
              </a>
            ))}
            {sso.passwordLogin && <div className="or"><span>o con tu contraseña</span></div>}
          </div>
        )}
        {(sso.passwordLogin || providers.length === 0) ? (
          <ActionForm action={loginAction} submitLabel="Entrar" pendingLabel="Entrando…">
            <input type="hidden" name="next" value={safeNext(next)} />
            <label className="field"><span className="label">Email</span>
              <input name="email" type="email" autoComplete="username" required autoFocus={providers.length === 0} /></label>
            <label className="field"><span className="label">Contraseña</span>
              <input name="password" type="password" autoComplete="current-password" required /></label>
          </ActionForm>
        ) : (
          <details className="admin-login"><summary className="meta">Soy administrador y quiero entrar con contraseña</summary>
            <ActionForm action={loginAction} submitLabel="Entrar" pendingLabel="Entrando…" secondary>
              <input type="hidden" name="next" value={safeNext(next)} />
              <label className="field"><span className="label">Email</span><input name="email" type="email" autoComplete="username" required /></label>
              <label className="field"><span className="label">Contraseña</span><input name="password" type="password" autoComplete="current-password" required /></label>
            </ActionForm>
          </details>
        )}
        {demo && <p className="callout good">Demo: entra con <strong>{demo}</strong></p>}
        <p className="meta">¿Olvidaste la contraseña? {providers.length ? "Entra con tu cuenta de Google o Microsoft, o pide" : "Pide"} a un administrador que te ponga una nueva.</p>
      </main>
    </div>
  );
}
