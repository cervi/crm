import Link from "next/link";
import { forgotPasswordAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recuperar la contraseña" };

export default function ForgotPasswordPage() {
  return (
    <main className="auth-card">
      <div className="auth-brand"><Icon name="deals" />CRM</div>
      <div>
        <h1>¿Has olvidado tu contraseña?</h1>
        <p className="meta" style={{ margin: 0 }}>Escribe el correo con el que entras y te enviaremos un enlace para poner una nueva.</p>
      </div>
      <ActionForm action={forgotPasswordAction} submitLabel="Enviarme el enlace" pendingLabel="Enviando…">
        <label className="field"><span className="label">Email</span>
          <input name="email" type="email" autoComplete="username" required autoFocus /></label>
      </ActionForm>
      <p className="meta">Si no te llega en unos minutos, pide a un administrador de tu empresa que te envíe el enlace. <Link href="/login">Volver a entrar</Link></p>
    </main>
  );
}
