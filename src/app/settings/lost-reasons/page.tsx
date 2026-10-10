import Link from "next/link";
import { listLostReasons } from "@/lib/deals";
import { createLostReasonAction, updateLostReasonAction } from "@/app/actions/settings";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Motivos de pérdida" };

export default async function LostReasonsPage() {
  await requireAdminPage();
  const reasons = await listLostReasons(true);
  const fields = (r?: (typeof reasons)[number]) => (
    <>
      <label className="field"><span className="label">Motivo *</span><input name="label" required defaultValue={r?.label ?? ""} /></label>
      <label className="field"><span className="label">Volver a contactar a los (días)</span>
        <input type="number" name="followup_days" min={1} defaultValue={r?.followup_days ?? ""} placeholder="sin seguimiento" />
        <span className="meta">Al perder un deal por este motivo, se crea una tarea para volver a contactar en esa fecha.</span></label>
      {r && <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={r.is_active} /> Activo (se puede elegir al perder un deal)</label>}
    </>
  );
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Motivos de pérdida</h1>
          <p className="muted" style={{ margin: 0 }}>Lo que se elige al marcar un deal como perdido. Sirven para los informes y, con seguimiento, para no olvidar volver a intentarlo.</p>
        </div>
        <div className="head-actions">
          <Drawer label={<><Icon name="plus" />Nuevo motivo</>} buttonClass="btn" title="Nuevo motivo">
            <ActionForm action={createLostReasonAction} submitLabel="Añadir motivo" resetOnSuccess>{fields()}</ActionForm>
          </Drawer>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Motivo</th><th>Seguimiento</th><th>Estado</th><th><span className="sr-only">Acciones</span></th></tr></thead>
          <tbody>
            {reasons.length === 0 && <tr><td colSpan={4} className="empty-row">Aún no hay motivos. Añade el primero con «Nuevo motivo».</td></tr>}
            {reasons.map((r) => (
              <tr key={r.id} className={r.is_active ? undefined : "row-muted"}>
                <td><strong>{r.label}</strong></td>
                <td>{r.followup_days ? `Volver a contactar a los ${r.followup_days} días` : <span className="muted">Sin seguimiento</span>}</td>
                <td>{r.is_active ? <span className="badge won">Activo</span> : <span className="badge">Inactivo</span>}</td>
                <td className="row-actions">
                  <Drawer label="Editar" title={r.label} buttonTitle={`Editar ${r.label}`}>
                    <ActionForm action={updateLostReasonAction.bind(null, r.id)} submitLabel="Guardar cambios">{fields(r)}</ActionForm>
                  </Drawer>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
