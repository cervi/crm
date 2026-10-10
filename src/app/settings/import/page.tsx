import Link from "next/link";
import { getPipedriveSettings, listImportJobs, runningJob, STEP_LABELS, STEPS } from "@/lib/pipedrive-import";
import { getSettings } from "@/lib/automations";
import { encryptionConfigured } from "@/lib/crypto";
import { dateTime } from "@/lib/format";
import {
  cancelImportAction, connectPipedriveAction, disconnectPipedriveAction, setPipedriveSyncAction, startImportAction,
} from "@/app/actions/import";
import { setPausedAction } from "@/app/actions/automations";
import { ActionForm } from "@/components/ActionForm";
import { ImportProgress } from "@/components/ImportProgress";
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Importar desde Pipedrive" };

const STATUS: Record<string, string> = { running: "En marcha", done: "Terminada", failed: "Falló", cancelled: "Cancelada" };

export default async function ImportPage() {
  await requireAdminPage();
  const [pd, jobs, running, ai] = await Promise.all([getPipedriveSettings(), listImportJobs(5), runningJob(), getSettings()]);
  const last = jobs.find((j) => j.status !== "running");
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Importar desde Pipedrive</h1>
          <p className="muted" style={{ margin: 0 }}>
            Trae todo con su histórico: usuarios, pipelines y fases, campos personalizados, empresas, contactos, leads, deals (con su
            recorrido por fases), actividades, notas y archivos. Se puede repetir sin duplicar nada: cada registro recuerda su id de
            Pipedrive y se actualiza. En una importación manda Pipedrive: sus datos sobrescriben los del CRM.
          </p>
        </div>
      </div>

      {!pd.connected ? (
        <section className="panel">
          <h2>1. Conectar Pipedrive</h2>
          <p className="muted">
            Copia tu token de API en Pipedrive → menú de tu usuario → <strong>Configuración personal → API</strong>, y pégalo aquí.
            Se guarda cifrado y solo se usa para leer.
          </p>
          {!encryptionConfigured() && <p className="callout bad">Falta TOKEN_ENCRYPTION_KEY en el servidor para guardar el token.</p>}
          <ActionForm action={connectPipedriveAction} submitLabel="Conectar" className="form inline">
            <label className="field" style={{ flex: 1 }}><span className="label">Token de API *</span>
              <input name="token" type="password" autoComplete="off" required /></label>
          </ActionForm>
        </section>
      ) : (
        <section className="panel ai-status">
          <div>
            <h2>Conectado a {pd.company}</h2>
            <p className="muted" style={{ margin: 0 }}>
              {last ? `Última importación: ${dateTime(last.finished_at ?? last.started_at)} (${STATUS[last.status]}).` : "Todavía no se ha importado nada."}
            </p>
          </div>
          <div className="head-actions">
            <form action={setPipedriveSyncAction.bind(null, !pd.sync)} className="switch-row">
              <button type="submit" className={pd.sync ? "switch on" : "switch"} aria-pressed={pd.sync} aria-label="Sincronizar con Pipedrive cada hora"><i /></button>
              <span>Sincronizar cada hora {pd.sync ? <span className="meta">(activa)</span> : null}</span>
            </form>
            <ActionForm action={disconnectPipedriveAction} submitLabel="Desconectar Pipedrive" secondary className="form inline" confirm="Se olvida la clave de Pipedrive y se para la sincronización. Lo ya importado se queda." />
          </div>
        </section>
      )}

      {pd.connected && (
        <section className="panel">
          <h2>{running ? "Importación en marcha" : "2. Importar"}</h2>
          {running ? (
            <>
              <ImportProgress labels={STEP_LABELS} steps={[...STEPS]}
                              initial={{ status: running.status, step: running.step, counts: running.counts, error: running.error }} />
              <ActionForm action={cancelImportAction.bind(null, running.id)} submitLabel="Cancelar la importación" secondary className="form inline" confirm="Se para la importación. Lo que ya se ha traído se queda; puedes volver a lanzarla y seguirá donde iba." />
            </>
          ) : (
            <>
              <p className="muted">
                La IA se pone en pausa durante la importación, para que no reaccione de golpe a cientos de deals. Al terminar, revisa
                los datos y la comprobación de abajo, ajusta la autonomía de las reglas y reanúdala.
              </p>
              <ActionForm action={startImportAction} submitLabel={last ? "Volver a importar" : "Importar todo"} className="form inline">
                <label className="checkbox"><input type="checkbox" name="flow" defaultChecked />Recorrido de cada deal por las fases (más lento: una consulta por deal)</label>
                <label className="checkbox"><input type="checkbox" name="files" defaultChecked />Archivos (como enlaces en «Documentos»)</label>
              </ActionForm>
              {pd.sync && <p className="meta">Con la sincronización horaria, además, cada hora se trae lo cambiado en Pipedrive desde la vez anterior.</p>}
            </>
          )}
        </section>
      )}

      {ai.paused && last?.status === "done" && (
        <div className="callout">
          La IA está en pausa desde la importación.{" "}
          <form action={setPausedAction.bind(null, false)} style={{ display: "inline" }}><button className="link" type="submit">Reanudarla</button></form>
          {" "}(revisa antes la autonomía en <Link href="/settings/automations">Automatizaciones e IA</Link>).
        </div>
      )}

      {last && (
        <section className="panel" aria-label="Resultado de la importación">
          <h2>Resultado</h2>
          {last.error && <p className="callout bad">{last.error}</p>}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Qué</th><th className="num">Nuevos</th><th className="num">Actualizados</th><th className="num">Omitidos</th></tr></thead>
              <tbody>
                {Object.entries(last.counts).map(([k, c]) => (
                  <tr key={k}><td>{STEP_LABELS[k] ?? k}</td><td className="num">{c.created ?? 0}</td><td className="num">{c.updated ?? 0}</td><td className="num">{c.skipped ?? 0}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {last.verify && (
            <>
              <h3 style={{ marginTop: 16 }}>Comprobación</h3>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Total</th><th className="num">Pipedrive</th><th className="num">CRM</th><th /></tr></thead>
                  <tbody>
                    {last.verify.map((v) => (
                      <tr key={v.label}><td>{v.label}</td><td className="num">{v.pipedrive}</td><td className="num">{v.crm}</td>
                        <td>{v.pipedrive === v.crm ? <span className="badge won">Cuadra</span> : <span className="badge lost">No cuadra</span>}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {last.warnings.length > 0 && (
            <details style={{ marginTop: 12 }}>
              <summary className="meta">{last.warnings.length} aviso{last.warnings.length === 1 ? "" : "s"}</summary>
              <ul>{last.warnings.map((w) => <li key={w} className="meta">{w}</li>)}</ul>
            </details>
          )}
        </section>
      )}
    </main>
  );
}
