import Link from "next/link";
import { deleteScheduleAction, saveScheduleAction } from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { WEEKDAYS, describeSchedule, listSchedules, type SendSchedule } from "@/lib/send-schedule";

export const dynamic = "force-dynamic";
export const metadata = { title: "Horarios de envío" };

const ZONES = ["Europe/Madrid", "Atlantic/Canary", "Europe/Lisbon", "Europe/London", "Europe/Paris", "America/Mexico_City", "America/Bogota", "America/Lima",
  "America/Santiago", "America/Argentina/Buenos_Aires", "America/New_York", "America/Sao_Paulo", "UTC"];

function ScheduleFields({ s }: { s?: SendSchedule }) {
  return (
    <>
      <label className="field"><span className="label">Nombre *</span><input name="name" required maxLength={80} defaultValue={s?.name ?? ""} placeholder="Horario laboral (España)" /></label>
      <div className="schedule-days" role="group" aria-label="Franjas por día">
        <span className="label">Franjas de envío <span className="meta">(hasta dos por día; vacío = ese día no se envía)</span></span>
        {WEEKDAYS.map((d, i) => {
          const b = s?.blocks[String(i + 1)] ?? (s ? [] : i < 4 ? [["09:00", "18:00"]] : i === 4 ? [["09:00", "15:00"]] : []);
          return (
            <div key={d} className="schedule-day">
              <strong>{d}</strong>
              {[0, 1].map((n) => (
                <span key={n} className="ee-row">
                  <input type="time" name={`from_${i + 1}`} defaultValue={b[n]?.[0] ?? ""} aria-label={`${d}: desde (franja ${n + 1})`} />–
                  <input type="time" name={`to_${i + 1}`} defaultValue={b[n]?.[1] ?? ""} aria-label={`${d}: hasta (franja ${n + 1})`} />
                </span>
              ))}
              <span />
            </div>
          );
        })}
      </div>
      <div className="grid-2">
        <label className="field"><span className="label">Zona horaria</span>
          <select name="timezone" defaultValue={s?.timezone ?? "Europe/Madrid"}>{ZONES.map((z) => <option key={z} value={z}>{z}</option>)}</select></label>
        <label className="field"><span className="label">Festivos propios (además de los nacionales)</span>
          <input name="holidays" defaultValue={(s?.holidays ?? []).join(", ")} placeholder="2026-12-24, 2026-12-31" /></label>
      </div>
      <label className="checkbox"><input type="checkbox" name="use_contact_tz" defaultChecked={s?.use_contact_tz ?? true} />En la hora local de cada contacto (por el país de su empresa; si no se sabe, la de arriba)</label>
      <label className="checkbox"><input type="checkbox" name="skip_holidays" defaultChecked={s?.skip_holidays ?? true} />No enviar en festivos nacionales de España</label>
      <label className="checkbox"><input type="checkbox" name="is_default" defaultChecked={s?.is_default ?? false} />Usarlo por defecto en las secuencias nuevas</label>
    </>
  );
}

export default async function SchedulesPage() {
  const user = await requireUser();
  const [schedules, uses] = await Promise.all([
    listSchedules(),
    sql<{ schedule_id: string; n: number }[]>`SELECT schedule_id, count(*)::int AS n FROM sequences WHERE schedule_id IS NOT NULL AND archived_at IS NULL GROUP BY 1`,
  ]);
  const canEdit = user.role !== "viewer";
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/sequences">Secuencias</Link></div>
      <div className="page-head">
        <div>
          <h1>Horarios de envío</h1>
          <p className="muted" style={{ margin: 0 }}>Cuándo pueden salir los correos automáticos de las secuencias. Las tareas se crean aunque sea fuera de horario.</p>
        </div>
        {canEdit && (
          <Drawer label={<><Icon name="plus" />Nuevo horario</>} buttonClass="btn" title="Nuevo horario de envío">
            <ActionForm action={saveScheduleAction.bind(null, null)} submitLabel="Crear horario" resetOnSuccess><ScheduleFields /></ActionForm>
          </Drawer>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Horario</th><th>Cuándo</th><th className="num">Secuencias</th><th><span className="sr-only">Acciones</span></th></tr></thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong>{s.is_default && <span className="badge" style={{ marginLeft: 6 }}>Por defecto</span>}</td>
                <td className="meta">{describeSchedule(s)}</td>
                <td className="num">{uses.find((u) => u.schedule_id === s.id)?.n ?? 0}</td>
                <td className="row-actions">
                  {canEdit && (
                    <Drawer label="Editar" buttonClass="btn secondary small" title={s.name}>
                      <ActionForm action={saveScheduleAction.bind(null, s.id)} submitLabel="Guardar"><ScheduleFields s={s} /></ActionForm>
                      {!s.is_default && (
                        <ActionForm action={deleteScheduleAction.bind(null, s.id)} submitLabel="Borrar horario" danger className="form inline"
                                    confirm="Las secuencias que lo usan pasarán al horario por defecto." />
                      )}
                    </Drawer>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="meta">Además del horario, cada buzón tiene su ritmo (máximo por hora, por día y margen entre correos) en <Link href="/settings/mailbox">Correo, calendario y documentos</Link>.</p>
    </main>
  );
}
