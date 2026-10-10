import Link from "next/link";
import { deleteTemplateAction, saveTemplateAction, setEmailTrackingAction } from "@/app/actions/mailbox";
import { ActionForm } from "@/components/ActionForm";
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
      <div className="grid-2">
        <label className="field"><span className="label">Nombre</span><input name="name" required maxLength={100} defaultValue={t?.name} /></label>
        <label className="field"><span className="label">Asunto</span><input name="subject" maxLength={300} defaultValue={t?.subject} /></label>
      </div>
      <label className="field"><span className="label">Texto</span><textarea name="body" rows={8} required defaultValue={t?.body} /></label>
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
          <p className="muted" style={{ margin: 0 }}>
            Textos que se eligen al escribir un correo desde un deal. Puedes usar{" "}
            {VARS.map(([v, d], i) => <span key={v}><code>{v}</code> ({d}){i < VARS.length - 1 ? ", " : "."}</span>)}
          </p>
        </div>
      </div>

      {admin && (
        <section className="panel">
          <h2>Seguimiento de aperturas y clics</h2>
          <p className="muted">
            Por defecto, los correos a contactos llevan un píxel invisible y los enlaces pasan por el CRM para saber si se abren y se pulsan.
            Cada correo se puede enviar sin seguimiento desmarcando la casilla.
            {!publicBase() && <> <strong>Ahora mismo no funciona:</strong> falta <code>APP_URL</code> con la dirección pública del CRM.</>}
          </p>
          <form action={setEmailTrackingAction.bind(null, !tracking)}>
            <button type="submit" className="btn secondary small">{tracking ? "Desactivar por defecto" : "Activar por defecto"}</button>
            <span className="meta" style={{ marginLeft: 8 }}>Ahora: {tracking ? "activado" : "desactivado"}</span>
          </form>
        </section>
      )}

      <div className="rules">
        {templates.map((t) => (
          <article key={t.id} className="panel" aria-label={`Plantilla ${t.name}`}>
            <div className="rule-head">
              <div>
                <h3 style={{ margin: 0 }}>{t.name}</h3>
                <p className="meta" style={{ margin: 0 }}>{t.shared ? "Compartida con el equipo" : "Solo tuya"}{t.subject && <> · Asunto: {t.subject}</>}</p>
              </div>
            </div>
            {(t.mine || (t.shared && admin)) ? (
              <details>
                <summary className="meta">Editar</summary>
                <ActionForm action={saveTemplateAction.bind(null, t.id)} submitLabel="Guardar" secondary>
                  <TemplateFields t={t} admin={admin} />
                </ActionForm>
                <ActionForm action={deleteTemplateAction.bind(null, t.id)} submitLabel="Borrar plantilla" secondary className="form inline" confirm="Se borra la plantilla. Los correos ya enviados no cambian." />
              </details>
            ) : <p className="note-body" style={{ margin: 0 }}>{t.body}</p>}
          </article>
        ))}
      </div>

      <section className="panel" style={{ marginTop: 18 }}>
        <h2>Nueva plantilla</h2>
        <ActionForm action={saveTemplateAction.bind(null, null)} submitLabel="Crear plantilla" resetOnSuccess>
          <TemplateFields admin={admin} />
        </ActionForm>
      </section>
    </main>
  );
}
