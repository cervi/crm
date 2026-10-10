import Link from "next/link";
import { deleteTemplateAction, saveTemplateAction, setEmailTrackingAction } from "@/app/actions/mailbox";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { publicBase } from "@/lib/email-track";
import { listTemplates, type Template } from "@/lib/emails";

export const dynamic = "force-dynamic";
export const metadata = { title: "Plantillas de correo" };

const VARS = [["{nombre}", "nombre del contacto"], ["{deal}", "título del deal"], ["{empresa}", "empresa"],
              ["{responsable}", "responsable del deal"], ["{huecos}", "tus próximos huecos libres del calendario"],
              ["{enlace_reserva}", "enlace personal a tu página de reservas"]];

function TemplateFields({ t, admin }: { t?: Template; admin: boolean }) {
  return (
    <>
      <label className="field"><span className="label">Nombre *</span><input name="name" required maxLength={100} defaultValue={t?.name} /></label>
      <label className="field"><span className="label">Asunto</span><input name="subject" maxLength={300} defaultValue={t?.subject} /></label>
      <label className="field"><span className="label">Texto *</span><textarea name="body" rows={8} required defaultValue={t?.body} /></label>
      {admin && <label className="checkbox"><input type="checkbox" name="shared" defaultChecked={t ? t.shared : false} />Compartida con el equipo</label>}
    </>
  );
}

export default async function TemplatesPage() {
  const me = await requireUser();
  const admin = me.role === "admin";
  const [templates, [settings]] = await Promise.all([
    listTemplates(me.id), sql<{ email_tracking: boolean }[]>`SELECT email_tracking FROM app_settings LIMIT 1`,
  ]);
  const tracking = settings?.email_tracking ?? true;
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Plantillas de correo</h1>
          <p className="muted" style={{ margin: 0 }}>Textos que se eligen al escribir un correo desde un deal o un contacto.</p>
        </div>
        <div className="head-actions">
          <Drawer label={<><Icon name="plus" />Nueva plantilla</>} buttonClass="btn" title="Nueva plantilla"
                  subtitle={<>Variables: {VARS.map(([v, d], i) => <span key={v} title={d}><code>{v}</code>{i < VARS.length - 1 ? " " : ""}</span>)}</>}>
            <ActionForm action={saveTemplateAction.bind(null, null)} submitLabel="Crear plantilla" resetOnSuccess>
              <TemplateFields admin={admin} />
            </ActionForm>
          </Drawer>
        </div>
      </div>

      {admin && (
        <section className="settings-inline" aria-label="Seguimiento de aperturas y clics">
          <form action={setEmailTrackingAction.bind(null, !tracking)} className="switch-row">
            <button type="submit" className={tracking ? "switch on" : "switch"} aria-pressed={tracking} aria-label="Seguimiento de aperturas y clics por defecto"><i /></button>
            <span><strong>Seguimiento de aperturas y clics</strong> {tracking ? "activado" : "desactivado"} por defecto</span>
          </form>
          <p className="meta">Los correos llevan un píxel invisible y los enlaces pasan por el CRM para saber si se abren y se pulsan. Se puede quitar en cada correo.
            {!publicBase() && <> <strong className="tone-bad">Ahora mismo no funciona:</strong> falta configurar la dirección pública del CRM (<code>APP_URL</code>).</>}</p>
        </section>
      )}

      {templates.length === 0 ? (
        <div className="empty-state"><strong>Aún no hay plantillas.</strong><span className="meta">Crea la primera con «Nueva plantilla» y tenla a mano al escribir.</span></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Plantilla</th><th>Asunto</th><th>Quién la ve</th><th><span className="sr-only">Acciones</span></th></tr></thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} aria-label={`Plantilla ${t.name}`}>
                  <td><strong>{t.name}</strong><div className="meta template-snippet">{t.body.slice(0, 90)}{t.body.length > 90 ? "…" : ""}</div></td>
                  <td>{t.subject || <span className="muted">—</span>}</td>
                  <td>{t.shared ? "Todo el equipo" : "Solo tú"}</td>
                  <td className="row-actions">
                    <Drawer label={(t.mine || (t.shared && admin)) ? "Editar" : "Ver"} title={t.name} buttonTitle={`${(t.mine || (t.shared && admin)) ? "Editar" : "Ver"} la plantilla ${t.name}`}>
                      {(t.mine || (t.shared && admin)) ? (
                        <>
                          <section className="drawer-section">
                            <ActionForm action={saveTemplateAction.bind(null, t.id)} submitLabel="Guardar cambios">
                              <TemplateFields t={t} admin={admin} />
                            </ActionForm>
                          </section>
                          <section className="drawer-section">
                            <h3>Borrar</h3>
                            <ActionForm action={deleteTemplateAction.bind(null, t.id)} submitLabel="Borrar plantilla" secondary confirm="Se borra la plantilla. Los correos ya enviados no cambian." />
                          </section>
                        </>
                      ) : <p className="note-body" style={{ margin: 0 }}>{t.body}</p>}
                    </Drawer>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
