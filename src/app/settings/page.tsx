import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";
import { requireUser } from "@/lib/auth";

export const metadata = { title: "Ajustes" };

const SECTIONS: { href: string; title: string; text: string; icon: IconName; everyone?: boolean }[] = [
  { href: "/settings/users", icon: "persons", title: "Usuarios y permisos", text: "Quién entra al CRM y qué puede hacer: administradores, comerciales y solo lectura." },
  { href: "/settings/mailbox", icon: "inbox", title: "Correo, calendario y documentos", everyone: true, text: "Conecta Microsoft 365 o Google Workspace: enviar desde tu correo, registrar correos y reuniones, ofrecer tus huecos y enlazar documentos." },
  { href: "/settings/assignment", icon: "leads", title: "Reparto de leads y deals", text: "Asignar solos los leads y deals nuevos por origen, etapa, puntuación o importe, por turnos." },
  { href: "/settings/booking", icon: "activities", everyone: true, title: "Enlace de reserva", text: "Tu página pública para que los contactos elijan un hueco de tu calendario." },
  { href: "/settings/templates", icon: "pencil", everyone: true, title: "Plantillas de correo", text: "Textos para escribir más rápido desde los deals, y el seguimiento de aperturas y clics." },
  { href: "/settings/ai", icon: "spark", title: "Modelo de IA", text: "Proveedor, modelo, clave y prompts de los resúmenes (Claude, OpenAI, Grok u otro)." },
  { href: "/settings/automations", icon: "spark", title: "Automatizaciones e IA", text: "Qué puede hacer la IA sola, qué te pregunta antes y qué reglas sigue." },
  { href: "/settings/pipelines", icon: "deals", title: "Pipelines y fases", text: "Crea pipelines, ordena sus fases y define cuándo un deal se considera parado y qué sesión toca en cada fase." },
  { href: "/settings/products", icon: "deals", title: "Productos", text: "Catálogo de productos para los deals y las propuestas." },
  { href: "/settings/activity-types", icon: "activities", title: "Tipos de actividad", text: "Llamadas, demos, tareas… y los vuestros. Cuáles son sesiones con el cliente." },
  { href: "/settings/fields", icon: "settings", title: "Campos personalizados", text: "Añade tus propios campos a empresas, contactos, leads y deals." },
  { href: "/settings/lost-reasons", icon: "x", title: "Motivos de pérdida", text: "Motivos al perder un deal y en cuántos días volver a contactar." },
  { href: "/settings/import", icon: "download", title: "Importar desde Pipedrive", text: "Trae todo el histórico de Pipedrive; repetible y con sincronización horaria mientras convivís." },
  { href: "/import", icon: "download", everyone: true, title: "Importar CSV", text: "Contactos o leads desde Excel, Google Sheets u otra herramienta." },
  { href: "/duplicates", icon: "persons", everyone: true, title: "Duplicados", text: "Contactos y empresas repetidos: fusiónalos en uno sin perder nada." },
  { href: "/trash", icon: "trash", everyone: true, title: "Papelera", text: "Lo borrado en los últimos 30 días: deals, leads, contactos y empresas. Se puede recuperar." },
  { href: "/settings/export", icon: "download", title: "Exportar datos", text: "Descarga en CSV deals, leads, empresas, contactos, actividades y el registro de la IA." },
  { href: "/settings/forms", icon: "leads", title: "Formularios web y chat", text: "Formularios alojados en el CRM para vuestra web, con chat con IA opcional." },
  { href: "/settings/agents", icon: "spark", title: "Agentes externos (MCP)", text: "Conecta Grok Bot u otro agente para que consulte el CRM y proponga acciones con tus permisos." },
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
