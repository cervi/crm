"use client";

import { useId, useState } from "react";
import { EntityPicker } from "@/components/EntityPicker";
import { Icon } from "@/components/Icon";

type Candidate = { kind: "deal" | "lead"; id: string; label: string; hint: string | null };
const KINDS = [
  { key: "deal", label: "Un deal" },
  { key: "lead", label: "Un lead" },
  { key: "person", label: "Solo un contacto" },
] as const;

/**
 * Campos de «Asociar la nota»: primero los deals o leads que ya sabemos que
 * encajan (un clic) y, si no es ninguno, una sola elección con su buscador.
 */
export function AssignNoteFields({ candidates, move = false }: { candidates: Candidate[]; move?: boolean }) {
  const [candidate, setCandidate] = useState<string>("");
  const [kind, setKind] = useState<"deal" | "lead" | "person" | "">(candidates.length ? "" : "deal");
  const labelId = useId();
  return (
    <>
      {candidates.length > 0 && (
        <div className="field">
          <span className="label" id={`${labelId}-c`}>Los que encajan con los asistentes</span>
          <div className="choice-list" role="radiogroup" aria-labelledby={`${labelId}-c`}>
            {candidates.map((c) => {
              const v = `${c.kind}:${c.id}`;
              return (
                <label key={v} className="choice-row">
                  <input type="radio" name="candidate" value={v} checked={candidate === v} onChange={() => { setCandidate(v); setKind(""); }} />
                  <span><strong>{c.label}</strong><span className="meta"> · {c.kind === "deal" ? "deal" : "lead"}{c.hint ? ` · ${c.hint}` : ""}</span></span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      <div className="field">
        <span className="label" id={labelId}>{candidates.length ? "O busca otro" : "¿A qué va?"}</span>
        <div className="choice-pills" role="group" aria-labelledby={labelId}>
          {KINDS.map((k) => (
            <button key={k.key} type="button" aria-pressed={kind === k.key} onClick={() => { setKind(k.key); setCandidate(""); }}>
              {kind === k.key && <Icon name="check" />}{k.label}
            </button>
          ))}
        </div>
      </div>
      <input type="hidden" name="kind" value={kind} />
      {kind === "deal" && <EntityPicker key="deal" name="deal_id" type="deals" label="Deal" required placeholder="Busca por título o empresa" />}
      {kind === "lead" && <EntityPicker key="lead" name="lead_id" type="leads" label="Lead" required placeholder="Busca por título, contacto o empresa" />}
      {kind === "person" && <EntityPicker key="person" name="person_id" type="persons" label="Contacto" required placeholder="Busca por nombre o correo" />}
      {(kind === "deal" || kind === "lead") && (
        <EntityPicker key={`p-${kind}`} name="person_id" type="persons" label="Contacto que estuvo (opcional)" placeholder="Busca por nombre o correo" />
      )}
      <p className="meta">{move ? "La reunión y sus notas pasan a donde elijas." : "Los asistentes que aún no estén en el CRM se dan de alta como contactos."}</p>
    </>
  );
}
