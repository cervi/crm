import { redirect } from "next/navigation";
import { setupAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { needsSetup } from "@/lib/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Puesta en marcha" };

/** Primer administrador: solo mientras nadie tenga contraseña. */
export default async function SetupPage() {
  if (!(await needsSetup())) redirect("/login");
  const production = process.env.NODE_ENV === "production";
  return (
    <main className="auth-card">
      <div className="auth-brand"><Icon name="deals" />CRM</div>
      <h1>Puesta en marcha</h1>
      <p>Crea el primer usuario administrador. Después podrás dar acceso al resto del equipo desde Ajustes → Usuarios y permisos.</p>
      <ActionForm action={setupAction} submitLabel="Crear administrador y entrar" pendingLabel="Creando…">
        {production && (
          <label className="field"><span className="label">Código de puesta en marcha *</span>
            <input name="code" required autoComplete="off" />
            <span className="meta">El valor de SETUP_CODE en el servidor: así nadie más puede adelantarse.</span></label>
        )}
        <label className="field"><span className="label">Tu nombre *</span><input name="name" required autoComplete="name" /></label>
        <label className="field"><span className="label">Email *</span><input name="email" type="email" required autoComplete="username" /></label>
        <label className="field"><span className="label">Contraseña *</span>
          <input name="password" type="password" required minLength={10} autoComplete="new-password" />
          <span className="meta">Al menos 10 caracteres.</span></label>
        <label className="field"><span className="label">Repite la contraseña *</span>
          <input name="repeat" type="password" required minLength={10} autoComplete="new-password" /></label>
      </ActionForm>
    </main>
  );
}
