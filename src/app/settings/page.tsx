import { SettingsIndex, type SettingsGroup, type SettingsItem } from "@/components/settings/SettingsIndex";
import { requireUser } from "@/lib/auth";

export const metadata = { title: "Ajustes" };

type Item = SettingsItem & { everyone?: boolean };
const GROUPS: (Omit<SettingsGroup, "items"> & { items: Item[] })[] = [
  { key: "tu-cuenta", title: "Tu cuenta", hint: "Lo tuyo: tu correo, tu calendario y cómo escribes.", items: [
    { href: "/account", icon: "user", everyone: true, title: "Mi cuenta", text: "Nombre, contraseña, firma, avisos y resúmenes por correo.", keywords: "contraseña perfil firma notificaciones avisos resumen" },
    { href: "/settings/mailbox", icon: "inbox", everyone: true, title: "Correo, calendario y documentos", text: "Conecta Gmail u Outlook: registra correos y reuniones y envía desde tu cuenta.", keywords: "gmail outlook google microsoft sincronizar buzon drive onedrive ritmo limite" },
    { href: "/settings/booking", icon: "activities", everyone: true, title: "Enlace de reserva", text: "Tu página para que los contactos elijan hueco en tu calendario.", keywords: "calendly agenda reunion huecos" },
    { href: "/settings/templates", icon: "pencil", everyone: true, title: "Plantillas de correo", text: "Textos para escribir más rápido y seguimiento de aperturas.", keywords: "email plantilla texto aperturas clics" },
  ] },
  { key: "equipo", title: "Equipo y accesos", hint: "Quién entra, con qué permisos y cómo se reparte el trabajo.", items: [
    { href: "/settings/users", icon: "persons", title: "Usuarios y permisos", text: "Invitar, roles, dar de baja y recuperar contraseñas.", keywords: "alta baja invitar rol admin comercial contraseña" },
    { href: "/settings/security", icon: "user", title: "Accesos y seguridad", text: "Entrar con Google o Microsoft, registro de accesos y sesiones.", keywords: "sso login sesiones dominio seguridad" },
    { href: "/settings/assignment", icon: "leads", title: "Reparto de leads y deals", text: "Asignar solos los nuevos, por turnos o por reglas.", keywords: "round robin asignar turnos" },
  ] },
  { key: "ventas", title: "Ventas", hint: "Cómo está montado vuestro proceso comercial.", items: [
    { href: "/settings/pipelines", icon: "deals", title: "Pipelines y fases", text: "Fases, cuándo un deal está parado y qué sesión toca en cada una.", keywords: "embudo etapas funnel" },
    { href: "/settings/products", icon: "deals", title: "Productos", text: "Catálogo para los deals y las propuestas.", keywords: "precios catalogo" },
    { href: "/settings/activity-types", icon: "activities", title: "Tipos de actividad", text: "Llamadas, demos, tareas… y las vuestras.", keywords: "actividades llamada demo" },
    { href: "/settings/fields", icon: "settings", title: "Campos personalizados", text: "Campos propios en empresas, contactos, leads y deals.", keywords: "campos custom" },
    { href: "/settings/lost-reasons", icon: "x", title: "Motivos de pérdida", text: "Por qué se pierde un deal y cuándo volver a llamar.", keywords: "perdido motivos" },
  ] },
  { key: "prospeccion", title: "Prospección y outbound", hint: "A quién buscar y cómo llegar a ellos.", items: [
    { href: "/settings/icp", icon: "target", title: "Perfil de cliente ideal", text: "A quién queréis vender; lo usan la cualificación y las campañas.", keywords: "icp cualificar" },
    { href: "/sequences/horarios", icon: "clock", title: "Horarios de envío", text: "Cuándo salen los correos de las secuencias, hora local y festivos.", keywords: "secuencias horario festivos zona horaria" },
    { href: "/settings/signals", icon: "pulse", title: "Señales y avisos", text: "Aperturas, competidores y cómo se calcula la salud de los deals.", keywords: "salud riesgo competidores" },
    { href: "/settings/forms", icon: "leads", title: "Formularios web y chat", text: "Formularios para vuestra web, con chat con IA opcional.", keywords: "web chat formulario" },
  ] },
  { key: "ia", title: "IA y automatización", hint: "Qué hace el CRM solo y con qué modelo.", items: [
    { href: "/settings/ai", icon: "spark", title: "Modelo de IA", text: "Proveedor, modelo, clave y presupuesto.", keywords: "claude openai grok clave api prompts presupuesto" },
    { href: "/settings/autopilot", icon: "rocket", title: "Piloto automático", text: "Siguiente paso, llamadas a quien abre y ganar al firmar.", keywords: "automatico" },
    { href: "/settings/automations", icon: "spark", title: "Automatizaciones", text: "Qué hace la IA sola, qué te pregunta antes y sus reglas.", keywords: "reglas agentes ia" },
    { href: "/settings/agents", icon: "spark", title: "Agentes externos (MCP)", text: "Que otro agente consulte el CRM con tus permisos.", keywords: "mcp grok bot agente" },
  ] },
  { key: "datos", title: "Datos", hint: "Importar, exportar y mantenerlo limpio.", items: [
    { href: "/settings/import", icon: "download", title: "Importar desde Pipedrive", text: "Todo el histórico, repetible y con sincronización horaria.", keywords: "pipedrive migrar" },
    { href: "/import", icon: "download", everyone: true, title: "Importar CSV", text: "Contactos o leads desde Excel o Google Sheets.", keywords: "excel csv sheets" },
    { href: "/settings/export", icon: "download", title: "Exportar datos", text: "Descarga en CSV todo lo del CRM.", keywords: "descargar copia backup" },
    { href: "/duplicates", icon: "persons", everyone: true, title: "Duplicados", text: "Fusiona contactos y empresas repetidos.", keywords: "fusionar repetidos" },
    { href: "/trash", icon: "trash", everyone: true, title: "Papelera", text: "Lo borrado en los últimos 30 días.", keywords: "recuperar borrado" },
    { href: "/settings/api", icon: "plug", title: "API y Zapier", text: "Enviar leads y notas de reuniones desde la web, Zapier o Make.", keywords: "api zapier make webhook integracion" },
  ] },
];

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ denied?: string }> }) {
  const [user, { denied }] = await Promise.all([requireUser(), searchParams]);
  const admin = user.role === "admin";
  const groups: SettingsGroup[] = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => admin || i.everyone).map(({ everyone: _, ...i }) => i) }))
    .filter((g) => g.items.length);
  return (
    <main className="page">
      <div className="page-head"><h1>Ajustes</h1></div>
      {denied && <p className="callout" role="alert">Esa sección de ajustes es solo para administradores.</p>}
      {!admin && <p className="muted">El resto de ajustes los gestiona un administrador.</p>}
      <SettingsIndex groups={groups} />
    </main>
  );
}
