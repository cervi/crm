"use client";

import { useState } from "react";
import { EmailEditor, type CustomVar, type EditorContact, type EditorTemplate } from "@/components/EmailEditor";

// Campos de un paso de la secuencia: tipo, espera, y el editor de correo (o
// el asunto y la descripción si es una tarea).

export type StepData = {
  kind: "email" | "manual_email" | "task"; delay_days: number; delay_hours: number; subject: string; body: string;
  task_type: string | null; format: "text" | "html"; thread_reply: boolean; position?: number;
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

export function StepForm({ step, first, types, sequenceId, contacts, templates, customVars, aiReady, label }: Props) {
  const [kind, setKind] = useState<StepData["kind"]>(step?.kind ?? "email");
  const [thread, setThread] = useState(step?.thread_reply ?? false);
  const isEmail = kind !== "task";
  return (
    <>
      <div className="grid-3">
        <label className="field"><span className="label">Tipo de paso</span>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as StepData["kind"])} aria-label={`Tipo de ${label}`}>
            <option value="email">Correo automático</option>
            <option value="manual_email">Correo manual (lo revisas y lo envías tú)</option>
            <option value="task">Tarea (llamada, LinkedIn…)</option>
          </select>
        </label>
        <div className="field"><span className="label">{first ? "Espera tras añadirlo" : "Espera tras el paso anterior"}</span>
          <div className="ee-row">
            <input name="delay_days" type="number" min={0} max={90} required defaultValue={step?.delay_days ?? (first ? 0 : 3)} aria-label="Días de espera" style={{ width: 80 }} /> días
            <input name="delay_hours" type="number" min={0} max={23} defaultValue={step?.delay_hours ?? 0} aria-label="Horas de espera" style={{ width: 70 }} /> h
          </div>
        </div>
        {isEmail ? (
          <label className="checkbox" style={{ alignSelf: "end" }}>
            <input type="checkbox" name="thread_reply" checked={thread} disabled={first} onChange={(e) => setThread(e.target.checked)} />
            Responder en el mismo hilo que el correo anterior
          </label>
        ) : (
          <label className="field"><span className="label">Tipo de tarea</span>
            <select name="task_type" defaultValue={step?.task_type ?? "call"}>
              {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </label>
        )}
      </div>
      {isEmail ? (
        <EmailEditor
          initialSubject={step?.subject ?? ""} initialBody={step?.body ?? DEFAULT_BODY} initialFormat={step?.format ?? "text"}
          sequenceId={sequenceId} contacts={contacts} templates={templates} customVars={customVars} aiReady={aiReady}
          threadReply={thread && !first} firstStep={first} label={label}
        />
      ) : (
        <>
          <label className="field"><span className="label">Qué hay que hacer *</span>
            <input name="subject" required maxLength={300} defaultValue={step?.kind === "task" ? step.subject : "Llamar a {{nombre}}"} aria-label={`Asunto de ${label}`} />
          </label>
          <label className="field"><span className="label">Notas para quien lo haga (admite variables)</span>
            <textarea name="body" rows={4} defaultValue={step?.kind === "task" ? step.body : ""} />
          </label>
        </>
      )}
    </>
  );
}
