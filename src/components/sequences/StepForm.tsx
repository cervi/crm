"use client";

import { useState } from "react";
import { EmailEditor, type CustomVar, type EditorContact, type EditorTemplate } from "@/components/EmailEditor";
import { Icon } from "@/components/Icon";
import { PRIORITIES, STEP_KINDS, isEmailKind, type StepKind } from "@/lib/step-kinds";

// Campos de un paso de la secuencia: tipo (correo, llamada, LinkedIn, tarea),
// espera, prioridad y el editor de correo o el título e instrucciones de la tarea.

export type StepData = {
  kind: StepKind; delay_days: number; delay_hours: number; subject: string; body: string;
  task_type: string | null; format: "text" | "html"; thread_reply: boolean; position?: number; priority?: "high" | "medium" | "low";
};

type Props = {
  step?: StepData;
  first: boolean;
  types: { key: string; label: string }[];
  sequenceId: string;
  contacts: EditorContact[];
  templates: EditorTemplate[];
  customVars: CustomVar[];
  aiReady: boolean;
  label: string;
};

const DEFAULT_BODY = "Hola {{nombre}},\n\n\n\n¿Te encaja que lo hablemos 15 minutos esta semana?\n\nUn saludo,\n{{remitente_nombre}}";
const GROUPS: { label: string; kinds: StepKind[] }[] = [
  { label: "Correo", kinds: ["email", "manual_email"] },
  { label: "Teléfono", kinds: ["call"] },
  { label: "LinkedIn", kinds: ["linkedin_connect", "linkedin_message", "linkedin_view", "linkedin_interact"] },
  { label: "Otros", kinds: ["action_item"] },
];
const HELP: Partial<Record<StepKind, string>> = {
  email: "Sale solo dentro del horario de envío, desde el buzón asignado al contacto.",
  manual_email: "Se prepara el borrador con los datos del contacto; lo revisas y lo envías tú desde Tareas.",
  call: "Te aparece en Tareas con su teléfono. La secuencia espera a que la marques hecha (si contesta, termina).",
  linkedin_connect: "Te aparece en Tareas con su perfil de LinkedIn. La secuencia espera a que la hagas.",
  linkedin_message: "Te aparece en Tareas con su perfil de LinkedIn. La secuencia espera a que la hagas.",
  linkedin_view: "Ver su perfil (deja rastro y calienta el contacto). La secuencia espera a que la hagas.",
  linkedin_interact: "Reaccionar o comentar una publicación suya. La secuencia espera a que la hagas.",
  action_item: "Cualquier otra cosa (enviar un regalo, una nota a mano…). La secuencia espera a que la hagas.",
};

export function StepForm({ step, first, types, sequenceId, contacts, templates, customVars, aiReady, label }: Props) {
  const [kind, setKind] = useState<StepKind>(step?.kind ?? "email");
  const [thread, setThread] = useState(step?.thread_reply ?? false);
  const isEmail = isEmailKind(kind);
  const sameKind = step && step.kind === kind;
  return (
    <>
      <div className="field">
        <span className="label">Tipo de paso</span>
        <input type="hidden" name="kind" value={kind} />
        <div className="step-kinds" role="radiogroup" aria-label={`Tipo de ${label}`}>
          {GROUPS.map((g) => (
            <div key={g.label} className="step-kind-group">
              <span className="meta">{g.label}</span>
              {g.kinds.map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>
                  <Icon name={STEP_KINDS[k].icon} />{STEP_KINDS[k].label.replace(/^LinkedIn: /, "")}
                </button>
              ))}
            </div>
          ))}
          {step?.kind === "task" && (
            <div className="step-kind-group"><span className="meta">Antiguo</span>
              <button type="button" role="radio" aria-checked={kind === "task"} className={kind === "task" ? "on" : undefined} onClick={() => setKind("task")}>
                <Icon name="check" />Tarea de otro tipo</button></div>
          )}
        </div>
        {HELP[kind] && <span className="meta">{HELP[kind]}</span>}
      </div>
      <div className="grid-3">
        <div className="field"><span className="label">{first ? "Espera tras añadir al contacto" : "Espera tras el paso anterior"}</span>
          <div className="ee-row">
            <input name="delay_days" type="number" min={0} max={90} required defaultValue={step?.delay_days ?? (first ? 0 : 3)} aria-label="Días de espera" style={{ width: 80 }} /> días
            <input name="delay_hours" type="number" min={0} max={23} defaultValue={step?.delay_hours ?? 0} aria-label="Horas de espera" style={{ width: 70 }} /> h
          </div>
        </div>
        <label className="field"><span className="label">Prioridad</span>
          <select name="priority" defaultValue={step?.priority ?? (kind === "call" ? "high" : "medium")}>
            {(Object.keys(PRIORITIES) as (keyof typeof PRIORITIES)[]).map((p) => <option key={p} value={p}>{PRIORITIES[p]}</option>)}
          </select>
        </label>
        {isEmail ? (
          <label className="checkbox" style={{ alignSelf: "end" }}>
            <input type="checkbox" name="thread_reply" checked={thread} disabled={first} onChange={(e) => setThread(e.target.checked)} />
            En el mismo hilo que el correo anterior
          </label>
        ) : kind === "task" ? (
          <label className="field"><span className="label">Tipo de tarea</span>
            <select name="task_type" defaultValue={step?.task_type ?? "task"}>
              {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
        ) : <span />}
      </div>
      {isEmail ? (
        <EmailEditor
          initialSubject={step?.subject ?? ""} initialBody={step?.body ?? DEFAULT_BODY} initialFormat={step?.format ?? "text"}
          sequenceId={sequenceId} contacts={contacts} templates={templates} customVars={customVars} aiReady={aiReady}
          threadReply={thread && !first} firstStep={first} label={label}
        />
      ) : (
        <>
          <label className="field"><span className="label">Título de la tarea</span>
            <input key={`t-${kind}`} name="subject" maxLength={300} defaultValue={sameKind ? step.subject : STEP_KINDS[kind].title}
                   placeholder={STEP_KINDS[kind].title || "Qué hay que hacer"} aria-label={`Título de ${label}`} />
            <span className="meta">Admite variables como {"{{nombre_completo}}"} o {"{{empresa}}"}.</span>
          </label>
          <label className="field"><span className="label">{kind === "call" ? "Guion o notas para la llamada" : kind === "linkedin_message" || kind === "linkedin_connect" ? "Texto sugerido para el mensaje" : "Instrucciones"}</span>
            <textarea key={`b-${kind}`} name="body" rows={4} defaultValue={sameKind ? step.body : ""} />
          </label>
        </>
      )}
    </>
  );
}
