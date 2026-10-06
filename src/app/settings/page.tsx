import Link from "next/link";

export const metadata = { title: "Ajustes" };

const SECTIONS = [
  { href: "/settings/pipelines", title: "Pipelines y fases", text: "Crea pipelines, ordena sus fases y define cuándo un deal se considera parado y qué sesión toca en cada fase." },
  { href: "/settings/fields", title: "Campos personalizados", text: "Añade tus propios campos a empresas, contactos, leads y deals." },
  { href: "/settings/lost-reasons", title: "Motivos de pérdida", text: "Motivos al perder un deal y en cuántos días volver a contactar." },
  { href: "/settings/api", title: "Conectar formularios", text: "Cómo enviar leads desde la web, webinars, Zapier o Make." },
];

export default function SettingsPage() {
  return (
    <main className="page" style={{ maxWidth: 860 }}>
      <div className="page-head"><h1>Ajustes</h1></div>
      <div className="grid-2">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="panel" style={{ color: "inherit" }}>
            <h2>{s.title}</h2>
            <p className="muted" style={{ margin: 0 }}>{s.text}</p>
          </Link>
        ))}
      </div>
    </main>
  );
}
