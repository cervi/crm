import { ActionForm } from "./ActionForm";
import { DEAL_TYPE_LABEL, ORIGIN_LABEL } from "@/lib/deal-types";
import { CustomFieldInputs } from "./CustomFieldInputs";
import { EntityPicker } from "./EntityPicker";
import { OwnerSelect } from "./forms";
import { PipelineStageSelect } from "./PipelineStageSelect";
import type { ActionState } from "@/lib/errors";
import type { FieldDefinition } from "@/lib/custom-fields";
import type { Deal } from "@/lib/deals";
import type { UserRow } from "@/lib/users";

type Option = { id: string; label: string } | null;

export function DealForm({ action, deal, defs, users, pipelines, stages, submitLabel, defaults }: {
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
  deal?: Deal | null;
  defs: FieldDefinition[];
  users: UserRow[];
  pipelines: { id: string; name: string }[];
  stages: { id: string; pipeline_id: string; name: string }[];
  submitLabel: string;
  defaults?: { pipelineId?: string | null; organization?: Option; person?: Option; ownerId?: string | null };
}) {
  return (
    <ActionForm action={action} submitLabel={submitLabel}>
      <div className="grid-2">
        <label className="field span-2"><span className="label">Título *</span>
          <input name="title" required defaultValue={deal?.title ?? ""} placeholder="Empresa — producto o servicio" /></label>
        <EntityPicker name="organization_id" type="organizations" label="Empresa"
                      initial={deal?.organization_id ? { id: deal.organization_id, label: deal.organization_name ?? "" } : defaults?.organization} />
        {!deal && <EntityPicker name="person_id" type="persons" label="Contacto principal" initial={defaults?.person} />}
        <PipelineStageSelect pipelines={pipelines} stages={stages}
                             pipelineId={deal?.pipeline_id ?? defaults?.pipelineId} stageId={deal?.stage_id} />
        <label className="field"><span className="label">Importe</span>
          <input type="number" name="value" min={0} step="0.01" defaultValue={deal?.value ?? ""} /></label>
        <label className="field"><span className="label">Moneda</span>
          <input name="currency" maxLength={3} defaultValue={deal?.currency ?? "EUR"} /></label>
        <label className="field"><span className="label">Cierre previsto</span>
          <input type="date" name="expected_close_date" defaultValue={deal?.expected_close_date ?? ""} /></label>
        <OwnerSelect users={users} value={deal ? deal.owner_id : defaults?.ownerId} />
        <label className="field"><span className="label">Origen</span>
          <input name="source" defaultValue={deal?.source ?? ""} placeholder="webinar, formulario demo, referido…" /></label>
        {deal && (
          <>
            <label className="field"><span className="label">Tipo de deal</span>
              <select name="deal_type" defaultValue={deal.deal_type}>
                {Object.entries(DEAL_TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
            <label className="field"><span className="label">Lo trajo</span>
              <select name="origin" defaultValue={deal.origin}>
                {Object.entries(ORIGIN_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
          </>
        )}
      </div>
      <CustomFieldInputs defs={defs} values={deal?.custom} users={users} />
    </ActionForm>
  );
}
