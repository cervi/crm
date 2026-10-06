import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";
import { requireUser } from "@/lib/auth";

export const metadata = { title: "Ajustes" };

const SECTIONS: { href: string; title: string; text: string; icon: IconName; everyone?: boolean }[] = [
  { href: "/settings/users", icon: "persons", title: "Usuarios y permisos", text: "Quién entra al CRM y qué puede hacer: administradores, comerciales y solo lectura." },
  { href: "/settings/mailbox", icon: "inbox", title: "Correo, calendario y documentos", everyone: true, text: "Conecta Microsoft 365 o Google Workspace: enviar desde tu correo, registrar correos y reuniones, ofrecer tus huecos y enlazar documentos." },
  { href: "/settings/templates", icon: "pencil", everyone: true, title: "Plantillas de correo", text: "Textos para escribir más rápido desde los deals, y el seguimiento de aperturas y clics." },
  { href: "/settings/ai", icon: "spark", title: "Modelo de IA", text: "Proveedor, modelo, clave y prompts de los resúmenes (Claude, OpenAI, Grok u otro)." },
  { href: "/settings/automations", icon: "spark", title: "Automatizaciones e IA", text: "Qué puede hacer la IA sola, qué te pregunta antes y qué reglas sigue." },
  { href: "/settings/pipelines", icon: "deals", title: "Pipelines y fases", text: "Crea pipelines, ordena sus fases y define cuándo un deal se considera parado y qué sesión toca en cada fase." },
  { href: "/settings/activity-types", icon: "activities", title: "Tipos de actividad", text: "Llamadas, demos, tareas… y los vuestros. Cuáles son sesiones con el cliente." },
  { href: "/settings/fields", icon: "settings", title: "Campos personalizados", text: "Añade tus propios campos a empresas, contactos, leads y deals." },
  { href: "/settings/lost-reasons", icon: "x", title: "Motivos de pérdida", text: "Motivos al perder un deal y en cuántos días volver a contactar." },
  { href: "/settings/import", icon: "download", title: "Importar desde Pipedrive", text: "Trae todo el histórico de Pipedrive; repetible y con sincronización horaria mientras convivís." },
  { href: "/settings/export", icon: "download", title: "Exportar datos", text: "Descarga en CSV deals, leads, empresas, contactos, actividades y el registro de la IA." },
  { href: "/settings/api", icon: "plug", title: "Conectar formularios", text: "Cómo enviar leads desde la web, webinars, Zapier o Make." },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const [user, { denied }] = await Promise.all([requireUser(), searchParams]);
  const admin = user.role === "admin";
  return (
    <main className="page" style={{ maxWidth: 860 }}>
      <div className="page-head"><h1>Ajustes</h1></div>
      {denied && <p className="callout" role="alert">Esa sección de ajustes es solo para administradores.</p>}
      {!admin && <p className="muted">Los demás ajustes los gestiona un administrador. Tu contraseña y tu nombre están en <Link href="/account">Mi cuenta</Link>.</p>}
      <div className="grid-2">
        {SECTIONS.filter((s) => admin || s.everyone).map((s) => (
          <Link key={s.href} href={s.href} className="panel settings-card" style={{ color: "inherit" }}>
            <h2><Icon name={s.icon} />{s.title}</h2>
            <p className="muted" style={{ margin: 0 }}>{s.text}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
