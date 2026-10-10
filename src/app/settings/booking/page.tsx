import Link from "next/link";
import { saveBookingPageAction } from "@/app/actions/booking";
import { ActionForm } from "@/components/ActionForm";
import { activeActivityTypes } from "@/lib/activity-types";
import { requireUser } from "@/lib/auth";
import { myBookingPage, slugify } from "@/lib/booking";
import { publicBase } from "@/lib/email-track";
import { connectionOf } from "@/lib/mailbox";

export const dynamic = "force-dynamic";
export const metadata = { title: "Enlace de reserva" };

export default async function BookingSettingsPage() {
  const me = await requireUser();
  const [page, conn, types] = await Promise.all([myBookingPage(me.id), connectionOf(me.id), activeActivityTypes()]);
  const base = publicBase();
  const url = page && base ? `${base}/book/${page.slug}` : null;
  return (
    <main className="page narrow">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Enlace de reserva</h1>
          <p className="muted" style={{ margin: 0 }}>
            Una página con tus huecos libres para que los contactos elijan cuándo reunirse contigo. La reunión se crea en tu calendario con
            invitación y queda en su deal; si quien reserva no está en el CRM, entra como contacto nuevo con su deal. En las plantillas de
            correo, <code>{"{enlace_reserva}"}</code> pone un enlace personal para el contacto del deal.
          </p>
        </div>
      </div>

      {!conn && <p className="callout">Para ofrecer huecos, conecta tu calendario en <Link href="/settings/mailbox">Ajustes → Correo, calendario y documentos</Link>.</p>}
      {url && page?.is_active && (
        <p className="callout good">Tu página: <a href={url} target="_blank" rel="noreferrer">{url}</a></p>
      )}
      {!base && <p className="callout">Todavía no se puede compartir la página: falta configurar la dirección pública del CRM en el servidor{me.role === "admin" ? <> (<code>APP_URL</code>)</> : ". Avisa a quien lo administra"}.</p>}

      <section className="panel">
        <h2>{page ? "Tu página" : "Crear tu página"}</h2>
        <ActionForm action={saveBookingPageAction} submitLabel="Guardar">
          <div className="grid-2">
            <label className="field"><span className="label">Dirección *</span>
              <input name="slug" required defaultValue={page?.slug ?? slugify(me.name)} pattern="[a-z0-9][a-z0-9\-]{2,40}" />
              <span className="meta">/book/<em>esta-direccion</em></span></label>
            <label className="field"><span className="label">Título *</span><input name="title" required defaultValue={page?.title ?? "Reunión de 30 minutos"} /></label>
            <label className="field"><span className="label">Duración (min) *</span>
              <input name="duration_minutes" type="number" min={10} max={240} step={5} required defaultValue={page?.duration_minutes ?? 30} /></label>
            <label className="field"><span className="label">Tipo de actividad</span>
              <select name="activity_type" defaultValue={page?.activity_type ?? "video_call"}>
                {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select></label>
          </div>
          <label className="field"><span className="label">Texto para quien reserva (opcional)</span>
            <textarea name="description" rows={3} defaultValue={page?.description ?? ""} /></label>
          <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={page ? page.is_active : true} />Página activa</label>
          <p className="meta" style={{ margin: 0 }}>Los días, horas, márgenes y antelación son los de tus preferencias de huecos en Ajustes → Correo, calendario y documentos.</p>
        </ActionForm>
      </section>
    </main>
  );
}
