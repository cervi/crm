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
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pipeline" };

async function StageFields({ s }: { s?: { name: string; win_probability: number | null; rotten_after_days: number | null; required_activity_type: string | null } }) {
  return (
    <>
      <label className="field" style={{ flex: 2 }}><span className="label">Nombre</span><input name="name" required defaultValue={s?.name} /></label>
      <label className="field" style={{ width: 110 }}><span className="label">Probab. %</span>
        <input type="number" name="win_probability" min={0} max={100} defaultValue={s?.win_probability ?? ""} /></label>
      <label className="field" style={{ width: 130 }}><span className="label">Parado tras (días)</span>
        <input type="number" name="rotten_after_days" min={1} defaultValue={s?.rotten_after_days ?? ""} /></label>
      <label className="field" style={{ width: 170 }}><span className="label">Sesión requerida</span>
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

  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link> / <Link href="/settings/pipelines">Pipelines</Link></div>
      <div className="page-head">
        <h1>{pipeline.name}</h1><span className="spacer" />
        <Link href={`/pipelines/${id}`} className="btn secondary">Ver tablero</Link>
      </div>

      <div className="stack">
        <section className="panel">
          <h2>Datos del pipeline</h2>
          <ActionForm action={updatePipelineAction.bind(null, id)} submitLabel="Guardar" className="form inline">
            <label className="field" style={{ flex: 1 }}><span className="label">Nombre</span><input name="name" required defaultValue={pipeline.name} /></label>
            <label className="field" style={{ flex: 2 }}><span className="label">Descripción</span><input name="description" defaultValue={pipeline.description ?? ""} /></label>
            <label className="field"><span className="label">Tipo</span>
              <select name="kind" defaultValue={pipeline.kind}>{Object.entries(PIPELINE_KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={pipeline.is_active} /> Activo</label>
          </ActionForm>
        </section>

        <section className="panel stack">
          <h2>Fases</h2>
          <p className="meta" style={{ marginTop: -8 }}>
            «Parado tras» marca el deal en naranja cuando lleva más días en la fase. «Sesión requerida» es la reunión que
            debe estar agendada en esa fase; el seguimiento automático la usará para avisar o agendarla.
          </p>
          <ul className="items">
            {stages.map((s, i) => (
              <li key={s.id} className="item">
                <div className="item-head" style={{ marginBottom: 6 }}>
                  <strong>{i + 1}. {s.name}</strong>
                  <span className="meta">{s.deals} deal{s.deals === 1 ? "" : "s"}</span>
                  <span className="spacer" />
                  <form action={moveStageAction.bind(null, s.id, "up")}><button className="link" disabled={i === 0} aria-label={`Subir ${s.name}`}>↑ Subir</button></form>
                  <form action={moveStageAction.bind(null, s.id, "down")}><button className="link" disabled={i === stages.length - 1} aria-label={`Bajar ${s.name}`}>↓ Bajar</button></form>
                </div>
                <ActionForm action={updateStageAction.bind(null, s.id)} submitLabel="Guardar" className="form inline">
                  <StageFields s={s} />
                </ActionForm>
                <details style={{ marginTop: 6 }}>
                  <summary className="meta">Eliminar fase</summary>
                  <ActionForm action={deleteStageAction.bind(null, s.id)} submitLabel="Eliminar definitivamente" danger className="form inline" />
                </details>
              </li>
            ))}
          </ul>
          <h3>Añadir fase</h3>
          <ActionForm action={addStageAction.bind(null, id)} submitLabel="Añadir" className="form inline" resetOnSuccess>
            <StageFields />
          </ActionForm>
        </section>
      </div>
    </main>
  );
}
