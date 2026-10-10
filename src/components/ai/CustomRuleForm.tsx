"use client";

import { useState } from "react";
import type { ActionState } from "@/lib/errors";
import { ActionForm } from "../ActionForm";

type Option = { value: string; label: string };
type Initial = {
  name?: string;
  trigger?: {
    kind: string; activity_type?: string | null; outcome?: string; days?: number; stage_id?: string;
    filter?: { pipeline_id?: string | null; min_value?: number | null; owner_id?: string | null };
  };
  action?: {
    kind: string; activity_type?: string; subject?: string; due_in_days?: number; note?: string | null; body?: string;
    stage_id?: string; message?: string; content?: string; owner_id?: string; url?: string;
  };
};

const OUTCOMES: Option[] = [
  { value: "any", label: "cualquier resultado" },
  { value: "held", label: "Realizada" },
  { value: "no_show", label: "No se presentó" },
  { value: "rescheduled", label: "Reprogramada" },
  { value: "cancelled", label: "Cancelada" },
];

const TRIGGERS: { group: string; options: Option[] }[] = [
  { group: "Actividades", options: [
    { value: "activity_done", label: "Una actividad se marca como hecha" },
    { value: "activity_overdue", label: "Una actividad no se hace a tiempo" },
  ] },
  { group: "Deals", options: [
    { value: "deal_stage", label: "Un deal entra (o lleva días) en una fase" },
    { value: "deal_created", label: "Se crea un deal" },
    { value: "deal_idle", label: "Un deal lleva días sin movimiento" },
    { value: "deal_won", label: "Se gana un deal" },
    { value: "deal_lost", label: "Se pierde un deal" },
  ] },
  { group: "Contacto", options: [
    { value: "email_opened", label: "Abre un correo" },
    { value: "email_received", label: "Responde un correo" },
    { value: "booked", label: "Reserva una reunión con tu enlace" },
    { value: "proposal_viewed", label: "Abre una propuesta" },
    { value: "proposal_accepted", label: "Acepta una propuesta" },
  ] },
];

const ACTIONS: Option[] = [
  { value: "create_activity", label: "Crea una actividad" },
  { value: "draft_email", label: "Escribe un correo al contacto" },
  { value: "move_stage", label: "Mueve el deal de fase" },
  { value: "assign_owner", label: "Asigna el deal a alguien" },
  { value: "add_note", label: "Deja una nota en el deal" },
  { value: "webhook", label: "Avisa a otra herramienta (webhook)" },
  { value: "notify", label: "Te pide una decisión" },
];

function StageSelect({ name, value, stages }: { name: string; value?: string; stages: { pipeline: string; options: Option[] }[] }) {
  return (
    <select name={name} defaultValue={value ?? ""} required>
      <option value="" disabled>Elige una fase</option>
      {stages.map((p) => (
        <optgroup key={p.pipeline} label={p.pipeline}>
          {p.options.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * Formulario de una regla personalizada: «Cuando [algo pasa] (y el deal cumple
 * [condiciones]) → la IA [hace algo]».
 */
export function CustomRuleForm({ action, types, stages, pipelines = [], users = [], initial, submitLabel, withAutonomy }: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  types: Option[];
  stages: { pipeline: string; options: Option[] }[];
  pipelines?: Option[];
  users?: Option[];
  initial?: Initial;
  submitLabel: string;
  withAutonomy?: boolean;
}) {
  const [trigger, setTrigger] = useState(initial?.trigger?.kind ?? "activity_done");
  const [kind, setKind] = useState(initial?.action?.kind ?? "create_activity");
  const a: NonNullable<Initial["action"]> = initial?.action ?? { kind: "" };
  const t = initial?.trigger;
  const f = t?.filter ?? {};
  const isEmail = kind === "draft_email";
  const isActivity = trigger === "activity_done" || trigger === "activity_overdue";
  const daysLabel = trigger === "activity_overdue" ? "Días después de su fecha"
    : trigger === "deal_stage" ? "Días en la fase (0 = al entrar)"
    : trigger === "deal_created" ? "Días después (0 = al crearlo)"
    : trigger === "deal_idle" ? "Días sin movimiento" : null;
  return (
    <ActionForm action={action} submitLabel={submitLabel} resetOnSuccess={!initial}>
      <label className="field"><span className="label">Nombre de la regla *</span>
        <input name="name" required defaultValue={initial?.name ?? ""} placeholder="Tras la demo, enviar la propuesta" />
      </label>

      <fieldset className="fieldset rule-when">
        <legend>Cuando</legend>
        <div className="grid-3">
          <label className="field"><span className="label">Pasa esto</span>
            <select name="trigger_kind" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              {TRIGGERS.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          {isActivity && (
            <label className="field"><span className="label">Tipo de actividad</span>
              <select name="trigger_type" defaultValue={t?.activity_type ?? ""}>
                <option value="">Cualquiera</option>
                {types.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          {trigger === "activity_done" && (
            <label className="field"><span className="label">Con resultado</span>
              <select name="trigger_outcome" defaultValue={t?.outcome ?? "any"}>
                {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          )}
          {trigger === "deal_stage" && (
            <label className="field"><span className="label">Fase</span><StageSelect name="trigger_stage" value={t?.stage_id} stages={stages} /></label>
          )}
          {daysLabel && (
            <label className="field"><span className="label">{daysLabel}</span>
              <input type="number" name="trigger_days" min={trigger === "deal_idle" ? 1 : 0} max={365}
                     defaultValue={t?.days ?? (trigger === "deal_idle" ? 7 : trigger === "activity_overdue" ? 1 : 0)} />
            </label>
          )}
        </div>
        <details className="rule-conditions" open={Boolean(f.pipeline_id || f.min_value != null || f.owner_id)}>
          <summary className="meta">Solo para algunos deals (opcional)</summary>
          <div className="grid-3">
            <label className="field"><span className="label">Pipeline</span>
              <select name="filter_pipeline" defaultValue={f.pipeline_id ?? ""}>
                <option value="">Cualquiera</option>
                {pipelines.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="field"><span className="label">Importe desde (€)</span>
              <input type="number" name="filter_min_value" min={0} step="any" defaultValue={f.min_value ?? ""} />
            </label>
            <label className="field"><span className="label">Responsable</span>
              <select name="filter_owner" defaultValue={f.owner_id ?? ""}>
                <option value="">Cualquiera</option>
                {users.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>
        </details>
      </fieldset>

      <fieldset className="fieldset rule-then">
        <legend>Entonces la IA</legend>
        <label className="field"><span className="label">Acción</span>
          <select name="action_kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {ACTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {kind === "create_activity" && (
          <div className="grid-3">
            <label className="field"><span className="label">Tipo *</span>
              <select name="action_type" defaultValue={a.activity_type ?? "task"} required>
                {types.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="field"><span className="label">Asunto *</span>
              <input name="action_subject" required defaultValue={a.subject ?? ""} placeholder="Enviar la propuesta a {nombre}" />
            </label>
            <label className="field"><span className="label">Para dentro de (días)</span>
              <input type="number" name="action_due_days" min={0} max={365} defaultValue={a.due_in_days ?? 1} />
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}><span className="label">Descripción (opcional)</span>
              <textarea name="action_note" rows={2} defaultValue={a.note ?? ""} />
            </label>
          </div>
        )}
        {isEmail && (
          <>
            <label className="field"><span className="label">Asunto *</span>
              <input name="action_email_subject" required defaultValue={a.subject ?? ""} placeholder="Siguientes pasos: {deal}" />
            </label>
            <label className="field"><span className="label">Texto *</span>
              <textarea name="action_email_body" rows={6} required defaultValue={a.body ?? "Hola {nombre},\n\n\n\nUn saludo,\n{responsable}"} />
            </label>
          </>
        )}
        {kind === "move_stage" && (
          <label className="field"><span className="label">A la fase</span>
            <StageSelect name="action_stage" value={a.stage_id} stages={stages} />
            <span className="meta">Solo se aplica a los deals de ese pipeline.</span>
          </label>
        )}
        {kind === "assign_owner" && (
          <label className="field"><span className="label">Nuevo responsable *</span>
            <select name="action_owner" defaultValue={a.owner_id ?? ""} required>
              <option value="" disabled>Elige a la persona</option>
              {users.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}
        {kind === "add_note" && (
          <label className="field"><span className="label">Texto de la nota *</span>
            <textarea name="action_note_content" rows={3} required defaultValue={a.content ?? ""} placeholder="Revisar con {responsable}: {deal} está en «{fase}»." />
          </label>
        )}
        {kind === "webhook" && (
          <label className="field"><span className="label">Dirección del webhook *</span>
            <input name="action_url" type="url" required defaultValue={a.url ?? ""} placeholder="https://hooks.zapier.com/…" />
            <span className="meta">Recibe un POST con JSON: el evento, la regla y los datos del deal (título, importe, fase, empresa, responsable, contacto y enlace).</span>
          </label>
        )}
        {kind === "notify" && (
          <label className="field"><span className="label">Mensaje *</span>
            <input name="action_message" required defaultValue={a.message ?? ""} placeholder="«{actividad}» no se ha hecho: ¿qué hacemos con {deal}?" />
          </label>
        )}
        <p className="meta" style={{ margin: 0 }}>
          Puedes usar {"{deal}"}, {"{nombre}"} (del contacto), {"{empresa}"}, {"{fase}"}, {"{responsable}"}
          {isActivity && <>, {"{actividad}"} (asunto de la actividad que la dispara) y {"{tipo}"}</>}
          {isEmail && <>, y en el correo {"{huecos}"} (tus próximos huecos libres)</>}.
        </p>
      </fieldset>

      {withAutonomy && (
        <label className="field" style={{ maxWidth: 320 }}><span className="label">Autonomía al empezar</span>
          <select name="autonomy" defaultValue="ask">
            <option value="ask">Preguntar (propone en la bandeja)</option>
            <option value="auto">Sola (lo hace y queda en el registro)</option>
            <option value="off">Desactivada</option>
          </select>
        </label>
      )}
    </ActionForm>
  );
}
