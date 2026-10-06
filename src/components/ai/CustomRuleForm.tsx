"use client";

import { useState } from "react";
import type { ActionState } from "@/lib/errors";
import { ActionForm } from "../ActionForm";

type Option = { value: string; label: string };
type Initial = {
  name?: string;
  trigger?: { kind: string; activity_type: string | null; outcome?: string; days?: number };
  action?: { kind: string; activity_type?: string; subject?: string; due_in_days?: number; note?: string | null; body?: string; stage_id?: string; message?: string };
};

const OUTCOMES: Option[] = [
  { value: "any", label: "cualquier resultado" },
  { value: "held", label: "Realizada" },
  { value: "no_show", label: "No se presentó" },
  { value: "rescheduled", label: "Reprogramada" },
  { value: "cancelled", label: "Cancelada" },
];

/**
 * Formulario de una regla personalizada: «Cuando [actividad] [se hace / no se
 * hace] → [crear actividad / correo / mover de fase / pedir decisión]».
 */
export function CustomRuleForm({ action, types, stages, initial, submitLabel, withAutonomy }: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  types: Option[];
  stages: { pipeline: string; options: Option[] }[];
  initial?: Initial;
  submitLabel: string;
  withAutonomy?: boolean;
}) {
  const [trigger, setTrigger] = useState(initial?.trigger?.kind ?? "activity_done");
  const [kind, setKind] = useState(initial?.action?.kind ?? "create_activity");
  const a = initial?.action ?? {};
  const isEmail = kind === "draft_email";
  return (
    <ActionForm action={action} submitLabel={submitLabel} resetOnSuccess={!initial}>
      <label className="field"><span className="label">Nombre de la regla</span>
        <input name="name" required defaultValue={initial?.name ?? ""} placeholder="Tras la demo, enviar la propuesta" />
      </label>

      <fieldset className="fieldset rule-when">
        <legend>Cuando</legend>
        <div className="grid-3">
          <label className="field"><span className="label">Una actividad de tipo</span>
            <select name="trigger_type" defaultValue={initial?.trigger?.activity_type ?? ""}>
              <option value="">Cualquiera</option>
              {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </label>
          <label className="field"><span className="label">…de un deal</span>
            <select name="trigger_kind" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              <option value="activity_done">se marca como hecha</option>
              <option value="activity_overdue">no se hace a tiempo</option>
            </select>
          </label>
          {trigger === "activity_done" ? (
            <label className="field"><span className="label">Con resultado</span>
              <select name="trigger_outcome" defaultValue={initial?.trigger?.outcome ?? "any"}>
                {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          ) : (
            <label className="field"><span className="label">Días después de su fecha</span>
              <input type="number" name="trigger_days" min={0} max={90} defaultValue={initial?.trigger?.days ?? 1} />
            </label>
          )}
        </div>
      </fieldset>

      <fieldset className="fieldset rule-then">
        <legend>Entonces la IA</legend>
        <label className="field"><span className="label">Acción</span>
          <select name="action_kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="create_activity">Crea una actividad</option>
            <option value="draft_email">Escribe un correo al contacto</option>
            <option value="move_stage">Mueve el deal de fase</option>
            <option value="notify">Te pide una decisión</option>
          </select>
        </label>
        {kind === "create_activity" && (
          <div className="grid-3">
            <label className="field"><span className="label">Tipo</span>
              <select name="action_type" defaultValue={a.activity_type ?? "task"} required>
                {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            <label className="field"><span className="label">Asunto</span>
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
            <label className="field"><span className="label">Asunto</span>
              <input name="action_email_subject" required defaultValue={a.subject ?? ""} placeholder="Siguientes pasos: {deal}" />
            </label>
            <label className="field"><span className="label">Texto</span>
              <textarea name="action_email_body" rows={6} required defaultValue={a.body ?? "Hola {nombre},\n\n\n\nUn saludo,\n{responsable}"} />
            </label>
          </>
        )}
        {kind === "move_stage" && (
          <label className="field"><span className="label">A la fase</span>
            <select name="action_stage" defaultValue={a.stage_id ?? ""} required>
              <option value="" disabled>Elige una fase</option>
              {stages.map((p) => (
                <optgroup key={p.pipeline} label={p.pipeline}>
                  {p.options.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </optgroup>
              ))}
            </select>
            <span className="meta">Solo se aplica a los deals de ese pipeline.</span>
          </label>
        )}
        {kind === "notify" && (
          <label className="field"><span className="label">Mensaje</span>
            <input name="action_message" required defaultValue={a.message ?? ""} placeholder="«{actividad}» no se ha hecho: ¿qué hacemos con {deal}?" />
          </label>
        )}
        <p className="meta" style={{ margin: 0 }}>
          Puedes usar {"{deal}"}, {"{nombre}"} (del contacto), {"{responsable}"}, {"{actividad}"} (asunto de la actividad que la dispara)
          y {"{tipo}"}{isEmail && <>, y en el correo {"{huecos}"} (tus próximos huecos libres)</>}.
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
