import Link from "next/link";
import { listLostReasons } from "@/lib/deals";
import { createLostReasonAction, updateLostReasonAction } from "@/app/actions/settings";
import { ActionForm } from "@/components/ActionForm";
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Motivos de pérdida" };

export default async function LostReasonsPage() {
  await requireAdminPage();
  const reasons = await listLostReasons(true);
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><h1>Motivos de pérdida</h1></div>
      <p className="muted">Si un motivo tiene días de seguimiento, al perder un deal por ese motivo se crea una tarea para volver a contactar en esa fecha.</p>
      <div className="stack">
        <ul className="items">
          {reasons.map((r) => (
            <li key={r.id} className={r.is_active ? "item" : "item done"}>
              <ActionForm action={updateLostReasonAction.bind(null, r.id)} submitLabel="Guardar" secondary className="form inline">
                <label className="field" style={{ flex: 1 }}><span className="label">Motivo *</span><input name="label" required defaultValue={r.label} /></label>
                <label className="field" style={{ width: 160 }}><span className="label">Seguimiento (días)</span>
                  <input type="number" name="followup_days" min={1} defaultValue={r.followup_days ?? ""} /></label>
                <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={r.is_active} /> Activo</label>
              </ActionForm>
            </li>
          ))}
        </ul>
        <section className="panel">
          <h2>Nuevo motivo</h2>
          <ActionForm action={createLostReasonAction} submitLabel="Añadir" className="form inline" resetOnSuccess>
            <label className="field" style={{ flex: 1 }}><span className="label">Motivo *</span><input name="label" required /></label>
            <label className="field" style={{ width: 160 }}><span className="label">Seguimiento (días)</span><input type="number" name="followup_days" min={1} /></label>
          </ActionForm>
        </section>
      </div>
    </main>
  );
}
