import { redirect } from "next/navigation";
import { loginAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { currentUser, safeNext } from "@/lib/auth";
import { needsSetup } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Entrar" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await currentUser()) redirect(safeNext(next));
  if (await needsSetup()) redirect("/setup");
  // Solo en la demo local (npm run demo): el acceso de prueba, a la vista.
  const demo = process.env.NODE_ENV !== "production" ? process.env.DEMO_LOGIN_HINT : undefined;
  return (
    <main className="auth-card">
      <div className="auth-brand"><Icon name="deals" />CRM</div>
      <h1>Entrar</h1>
      <ActionForm action={loginAction} submitLabel="Entrar" pendingLabel="Entrando…">
        <input type="hidden" name="next" value={safeNext(next)} />
        <label className="field"><span className="label">Email *</span>
          <input name="email" type="email" autoComplete="username" required autoFocus /></label>
        <label className="field"><span className="label">Contraseña *</span>
          <input name="password" type="password" autoComplete="current-password" required /></label>
      </ActionForm>
      {demo && <p className="callout good">Demo: entra con <strong>{demo}</strong></p>}
      <p className="meta">¿Olvidaste la contraseña? Pide a un administrador que te ponga una nueva.</p>
    </main>
  );
}
