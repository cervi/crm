import Link from "next/link";
import { revokeAgentKeyAction } from "@/app/actions/agents";
import { listAgentKeys } from "@/lib/agents";
import { requireAdminPage } from "@/lib/auth";
import { publicBase } from "@/lib/email-track";
import { dateTime } from "@/lib/format";
import { NewKey } from "./NewKey";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agentes externos (MCP)" };

export default async function AgentsPage() {
  await requireAdminPage();
  const keys = await listAgentKeys();
  const endpoint = `${publicBase() ?? "https://<vuestro-crm>"}/api/v1/mcp`;
  return (
    <main className="page" style={{ maxWidth: 900 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Agentes externos (MCP)</h1>
          <p className="muted" style={{ margin: 0 }}>
            Conecta Grok Bot u otro agente con soporte MCP para que consulte el CRM (buscar, ver deals, el pipeline, la bandeja) y proponga
            acciones (tareas, notas, mover de fase, correos, cambios en deals). Lo que propone respeta los permisos de «Agentes externos» en{" "}
            <Link href="/settings/automations">Automatizaciones</Link>: con «Sola» se hace al momento y con «Preguntar» queda en la bandeja.
          </p>
        </div>
      </div>

      <section className="panel">
        <h2>Cómo conectarlo</h2>
        <ol className="steps">
          <li>Crea una clave aquí abajo para el agente.</li>
          <li>En el agente, añade un servidor MCP remoto con la dirección <code>{endpoint}</code> y la cabecera <code>Authorization: Bearer &lt;clave&gt;</code>.
            {" "}En la API de xAI (Grok), es una herramienta de tipo <code>mcp</code> con <code>server_url</code> y <code>authorization</code>.</li>
          <li>Prueba con «busca el deal de Paco y dime cuál es el siguiente paso».</li>
        </ol>
      </section>

      <section className="panel">
        <h2>Nueva clave</h2>
        <NewKey endpoint={endpoint} />
      </section>

      {keys.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 18 }}>
          <table>
            <thead><tr><th>Agente</th><th>Clave</th><th>Permisos</th><th>Último uso</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td><strong>{k.name}</strong><div className="meta">creada {dateTime(k.created_at)}{k.creator ? ` por ${k.creator}` : ""}</div></td>
                  <td><code>{k.prefix}…</code></td>
                  <td>{k.can_write ? "Consulta y propone" : "Solo consulta"}</td>
                  <td>{k.revoked_at ? <span className="badge lost">Revocada</span> : k.last_used_at ? dateTime(k.last_used_at) : "nunca"}</td>
                  <td>{!k.revoked_at && <form action={revokeAgentKeyAction.bind(null, k.id)}><button type="submit" className="btn secondary small">Revocar</button></form>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
