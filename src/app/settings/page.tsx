import Link from "next/link";
import { Icon, type IconName } from "@/components/Icon";

export const metadata = { title: "Ajustes" };

const SECTIONS: { href: string; title: string; text: string; icon: IconName }[] = [
  { href: "/settings/mailbox", icon: "inbox", title: "Correo, calendario y documentos", text: "Conecta Microsoft 365 o Google Workspace: enviar desde tu correo, registrar correos y reuniones, ofrecer tus huecos y enlazar documentos." },
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

export default function SettingsPage() {
  return (
    <main className="page" style={{ maxWidth: 860 }}>
      <div className="page-head"><h1>Ajustes</h1></div>
      <div className="grid-2">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="panel settings-card" style={{ color: "inherit" }}>
            <h2><Icon name={s.icon} />{s.title}</h2>
            <p className="muted" style={{ margin: 0 }}>{s.text}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
