import Link from "next/link";
import { PIPELINE_KINDS } from "@/lib/pipelines";
import { notFound } from "next/navigation";
import { getPipeline, listStages } from "@/lib/pipelines";
import { activityTypes } from "@/lib/activity-types";
import { isId } from "@/lib/validation";
import {
  addStageAction, deleteStageAction, moveStageAction, updatePipelineAction, updateStageAction,
} from "@/app/actions/settings";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pipeline" };

async function StageFields({ s }: { s?: { name: string; win_probability: number | null; rotten_after_days: number | null; required_activity_type: string | null } }) {
  return (
    <>
      <label className="field"><span className="label">Nombre *</span><input name="name" required defaultValue={s?.name} /></label>
      <label className="field"><span className="label">Probabilidad de ganar (%)</span>
        <input type="number" name="win_probability" min={0} max={100} defaultValue={s?.win_probability ?? ""} /></label>
      <label className="field"><span className="label">Parado tras (días)</span>
        <input type="number" name="rotten_after_days" min={1} defaultValue={s?.rotten_after_days ?? ""} /></label>
      <label className="field"><span className="label">Sesión requerida</span>
        <select name="required_activity_type" defaultValue={s?.required_activity_type ?? ""}>
          <option value="">Ninguna</option>
          {(await activityTypes()).filter((t) => t.is_active || t.key === s?.required_activity_type)
            .map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
      </label>
    </>
  );
}

export default async function PipelineSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminPage();
  const { id } = await params;
  if (!isId(id)) notFound();
  const [pipeline, stages] = await Promise.all([getPipeline(id), listStages(id)]);
  if (!pipeline) notFound();

  const types = await activityTypes();
  const typeLabel = (k: string | null) => (k ? types.find((t) => t.key === k)?.label ?? k : null);

  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link> / <Link href="/settings/pipelines">Pipelines</Link></div>
      <div className="page-head">
        <div>
          <h1>{pipeline.name}</h1>
          <p className="muted" style={{ margin: 0 }}>{pipeline.description || "Las fases por las que pasa un deal, en orden."}{!pipeline.is_active && " · Inactivo"}</p>
        </div>
        <div className="head-actions">
          <Link href={`/pipelines/${id}`} className="btn secondary">Ver tablero</Link>
          <Drawer label="Editar pipeline" title={`Editar «${pipeline.name}»`}>
            <ActionForm action={updatePipelineAction.bind(null, id)} submitLabel="Guardar cambios">
              <label className="field"><span className="label">Nombre *</span><input name="name" required defaultValue={pipeline.name} /></label>
              <label className="field"><span className="label">Descripción</span><input name="description" defaultValue={pipeline.description ?? ""} /></label>
              <label className="field"><span className="label">Tipo</span>
                <select name="kind" defaultValue={pipeline.kind}>{Object.entries(PIPELINE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={pipeline.is_active} /> Activo</label>
            </ActionForm>
          </Drawer>
          <Drawer label={<><Icon name="plus" />Nueva fase</>} buttonClass="btn" title="Nueva fase" subtitle="Se añade al final; luego puedes moverla.">
            <ActionForm action={addStageAction.bind(null, id)} submitLabel="Añadir fase" resetOnSuccess>
              <StageFields />
            </ActionForm>
          </Drawer>
        </div>
      </div>

      <p className="meta" style={{ margin: "0 0 12px" }}>
        <strong>Parado tras</strong>: el deal se marca en naranja si lleva más días en la fase. <strong>Sesión requerida</strong>: la reunión que debe estar agendada en esa fase; el seguimiento automático la usa para avisar o agendarla.
      </p>
      <div className="table-wrap">
        <table className="stages-table">
          <thead><tr><th className="num">#</th><th>Fase</th><th className="num">Probabilidad</th><th className="num">Parado tras</th><th>Sesión requerida</th><th className="num">Deals</th><th><span className="sr-only">Orden</span></th><th><span className="sr-only">Acciones</span></th></tr></thead>
          <tbody>
            {stages.length === 0 && <tr><td colSpan={8} className="empty-row">Sin fases todavía. Añade la primera con «Nueva fase».</td></tr>}
            {stages.map((s, i) => (
              <tr key={s.id} aria-label={`Fase ${s.name}`}>
                <td className="num stage-pos">{i + 1}</td>
                <td><strong>{s.name}</strong></td>
                <td className="num">{s.win_probability !== null ? `${s.win_probability} %` : <span className="muted">—</span>}</td>
                <td className="num">{s.rotten_after_days ? `${s.rotten_after_days} días` : <span className="muted">—</span>}</td>
                <td>{typeLabel(s.required_activity_type) ?? <span className="muted">Ninguna</span>}</td>
                <td className="num">{s.deals || <span className="muted">0</span>}</td>
                <td className="row-actions">
                  <form action={moveStageAction.bind(null, s.id, "up")}><button className="icon-btn small" disabled={i === 0} aria-label={`Subir ${s.name}`} title="Subir"><Icon name="up" /></button></form>
                  <form action={moveStageAction.bind(null, s.id, "down")}><button className="icon-btn small down" disabled={i === stages.length - 1} aria-label={`Bajar ${s.name}`} title="Bajar"><Icon name="up" /></button></form>
                </td>
                <td className="row-actions">
                  <Drawer label="Editar" title={s.name} subtitle={`Fase ${i + 1} de ${stages.length} · ${s.deals} deal${s.deals === 1 ? "" : "s"}`} buttonTitle={`Editar la fase ${s.name}`}>
                    <section className="drawer-section">
                      <h3>Datos de la fase</h3>
                      <ActionForm action={updateStageAction.bind(null, s.id)} submitLabel="Guardar cambios">
                        <StageFields s={s} />
                      </ActionForm>
                    </section>
                    <section className="drawer-section">
                      <h3>Eliminar la fase</h3>
                      <p className="meta" style={{ margin: 0 }}>{s.deals ? `Tiene ${s.deals} deal${s.deals === 1 ? "" : "s"}: muévelos antes a otra fase.` : "No tiene deals."}</p>
                      <ActionForm action={deleteStageAction.bind(null, s.id)} submitLabel="Eliminar la fase" secondary
                                  confirm={`Se eliminará la fase «${s.name}». No se puede deshacer.`} />
                    </section>
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
