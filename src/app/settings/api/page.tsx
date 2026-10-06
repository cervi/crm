import Link from "next/link";
import { headers } from "next/headers";
import { requireAdminPage } from "@/lib/auth";

export const metadata = { title: "Conectar formularios" };

export default async function ApiDocsPage() {
  await requireAdminPage();
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  const configured = (process.env.INBOUND_API_KEYS ?? "").split(",").some((k) => k.trim().length >= 16);
  const example = `curl -X POST ${origin}/api/v1/leads \\
  -H "Authorization: Bearer TU_CLAVE" \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "ana@empresa.com",
    "first_name": "Ana",
    "last_name": "García",
    "company": "Empresa S.L.",
    "source": "webinar",
    "source_detail": "Webinar: automatizar la captación",
    "funnel_stage": "mofu",
    "tags": ["webinar"],
    "consent": true
  }'`;

  return (
    <main className="page" style={{ maxWidth: 860 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><h1>Conectar formularios</h1></div>

      <section className="panel stack">
        <p>
          Cualquier formulario (web, blog, herramienta de webinars, Zapier, Make…) puede enviar sus datos a
          esta dirección. El CRM busca el contacto por email y la empresa por dominio para no duplicar,
          reutiliza su lead abierto y registra de dónde viene.
        </p>
        <p><code>POST {origin}/api/v1/leads</code></p>
        {configured
          ? <p className="callout good">La API está activa.</p>
          : <p className="callout">La API todavía no está activa: hay que definir la variable <code>INBOUND_API_KEYS</code> (una o varias claves de al menos 16 caracteres, separadas por comas).</p>}

        <h2>Autenticación</h2>
        <p>Envía la clave en la cabecera <code>Authorization: Bearer TU_CLAVE</code> (o <code>X-Api-Key</code>). No la pongas en el HTML de una web pública: usa Zapier, Make o tu backend como intermediario.</p>

        <h2>Campos</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Campo</th><th>Obligatorio</th><th>Descripción</th></tr></thead>
            <tbody>
              <tr><td><code>email</code></td><td>Sí</td><td>Identifica al contacto (deduplicación).</td></tr>
              <tr><td><code>source</code></td><td>Sí</td><td>Origen: webinar, ebook, blog, formulario-demo…</td></tr>
              <tr><td><code>source_detail</code></td><td></td><td>Contenido concreto (nombre del webinar, del ebook…).</td></tr>
              <tr><td><code>first_name</code>, <code>last_name</code> o <code>full_name</code></td><td></td><td>Nombre del contacto.</td></tr>
              <tr><td><code>phone</code>, <code>job_title</code></td><td></td><td>Teléfono y cargo.</td></tr>
              <tr><td><code>company</code>, <code>domain</code></td><td></td><td>Empresa. Si no se envía dominio se usa el del email (salvo Gmail, Outlook…).</td></tr>
              <tr><td><code>funnel_stage</code></td><td></td><td><code>tofu</code>, <code>mofu</code> o <code>bofu</code>. Solo sube, nunca baja.</td></tr>
              <tr><td><code>tags</code></td><td></td><td>Lista de etiquetas (o texto separado por comas).</td></tr>
              <tr><td><code>consent</code></td><td></td><td><code>true</code> si acepta comunicaciones comerciales.</td></tr>
              <tr><td><code>intent</code></td><td></td><td><code>demo_request</code> para solicitudes de demo o presupuesto: crea el deal en el pipeline Inbound y una tarea para contactar.</td></tr>
              <tr><td><code>message</code></td><td></td><td>Texto libre del formulario; se guarda como nota.</td></tr>
              <tr><td><code>pipeline_id</code>, <code>value</code></td><td></td><td>Pipeline e importe del deal (solo con <code>demo_request</code>).</td></tr>
            </tbody>
          </table>
        </div>

        <h2>Ejemplo</h2>
        <pre>{example}</pre>
        <p className="meta">Respuesta: <code>201</code> con los identificadores de contacto, empresa, lead y deal, e indicando qué se ha creado nuevo.</p>
      </section>
    </main>
  );
}
