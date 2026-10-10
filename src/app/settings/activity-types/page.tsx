import Link from "next/link";
import { activityTypes } from "@/lib/activity-types";
import {
  createActivityTypeAction, deleteActivityTypeAction, moveActivityTypeAction, updateActivityTypeAction,
} from "@/app/actions/activity-types";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tipos de actividad" };

export default async function ActivityTypesPage() {
  await requireAdminPage();
  const types = await activityTypes(true);
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Tipos de actividad</h1>
          <p className="muted" style={{ margin: 0 }}>
            Las actividades que se programan en los deals: llamadas, demos, tareas… y las vuestras (onboarding, kick-off, envío de
            propuesta…). Marca como <strong>sesión con el cliente</strong> las que son reuniones: cuentan como la sesión que pide una
            fase y, al celebrarse, la IA prepara el resumen para el cliente. Puedes usar cualquier tipo en las{" "}
            <Link href="/settings/automations#reglas-personalizadas">reglas personalizadas</Link>.
          </p>
        </div>
      </div>

      <section className="panel">
        <ul className="type-list">
          {types.map((t, i) => (
            <li key={t.key} className={t.is_active ? undefined : "inactive"} aria-label={`Tipo ${t.label}`}>
              <div className="order">
                <form action={moveActivityTypeAction.bind(null, t.key, "up")}><button className="icon-btn small" disabled={i === 0} aria-label={`Subir ${t.label}`}><Icon name="up" /></button></form>
                <form action={moveActivityTypeAction.bind(null, t.key, "down")}><button className="icon-btn small down" disabled={i === types.length - 1} aria-label={`Bajar ${t.label}`}><Icon name="up" /></button></form>
              </div>
              <ActionForm action={updateActivityTypeAction.bind(null, t.key)} submitLabel="Guardar" secondary className="form inline">
                <label className="field"><span className="label">Nombre *</span><input name="label" defaultValue={t.label} required /></label>
                <label className="checkbox"><input type="checkbox" name="is_session" defaultChecked={t.is_session} />Sesión con el cliente</label>
                <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={t.is_active} />Activo</label>
                <span className="meta">{t.usage > 0 ? `En uso (${t.usage})` : "Sin uso"}{t.is_builtin ? " · de serie" : ""}</span>
              </ActionForm>
              {!t.is_builtin && t.usage === 0 && (
                <ActionForm action={deleteActivityTypeAction.bind(null, t.key)} submitLabel="Borrar" pendingLabel="…" danger className="form inline" />
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Nuevo tipo</h2>
        <ActionForm action={createActivityTypeAction} submitLabel="Añadir tipo" resetOnSuccess className="form inline">
          <label className="field"><span className="label">Nombre *</span><input name="label" required placeholder="Onboarding, Kick-off, Envío de propuesta…" /></label>
          <label className="checkbox"><input type="checkbox" name="is_session" />Sesión con el cliente</label>
        </ActionForm>
      </section>
    </main>
  );
}
