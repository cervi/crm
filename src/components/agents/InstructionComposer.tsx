"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createInstructionAction, interpretInstructionAction } from "@/app/actions/stage-agents";
import type { Autonomy, Plan } from "@/lib/stage-agents";

/**
 * Escribir una instrucción para la IA en lenguaje natural, ver cómo la ha
 * entendido (cuándo → si → qué hace) y activarla con su autonomía.
 */
export function InstructionComposer({ scope, where, examples, aiReady }: {
  scope: { pipelineId: string | null; stageId: string | null }; where: string; examples: string[]; aiReady: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [autonomy, setAutonomy] = useState<Autonomy>("ask");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const interpret = () => {
    setError(null); setDone(null);
    start(async () => {
      const r = await interpretInstructionAction(scope, text);
      if (r.error) { setError(r.error); setPlan(null); } else setPlan(r.plan ?? null);
    });
  };
  const activate = () => {
    setError(null);
    start(async () => {
      const r = await createInstructionAction(scope, text, autonomy);
      if (r.error) { setError(r.error); return; }
      setDone(autonomy === "auto" ? "Activada: la IA lo hará sola y lo verás en el registro." : "Activada: la IA te propondrá cada acción en la bandeja para que la apruebes.");
      setText(""); setPlan(null);
      router.refresh();
    });
  };

  return (
    <div className="instr-composer">
      <label className="field">
        <span className="label">¿Qué quieres que haga la IA con los deals {where}?</span>
        <textarea rows={3} value={text} maxLength={2000} aria-label={`Instrucción ${where}`}
                  onChange={(e) => { setText(e.target.value); setPlan(null); }}
                  placeholder={examples[0] ? `Por ejemplo: ${examples[0]}` : "Escribe lo que quieres que haga, como se lo dirías a alguien del equipo."} />
      </label>
      {!text && examples.length > 0 && (
        <div className="chips instr-examples" aria-label="Ejemplos">
          {examples.map((e) => <button key={e} type="button" onClick={() => setText(e)}>{e}</button>)}
        </div>
      )}
      {!aiReady && <p className="meta" style={{ margin: 0 }}>Sin IA configurada solo se entienden instrucciones sencillas y no se pueden usar condiciones («si…»). <a href="/settings/ai">Configurar la IA</a></p>}
      {!plan && (
        <div><button type="button" className="btn small" disabled={pending || text.trim().length < 3} onClick={interpret}>{pending ? "Pensando…" : "Ver cómo lo va a hacer"}</button></div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {done && <p className="form-ok" role="status">{done}</p>}
      {plan && (
        <div className="instr-plan" aria-label="Cómo lo ha entendido">
          {plan.summary && <p style={{ margin: 0 }}><strong>Lo he entendido así:</strong> {plan.summary}</p>}
          <ol className="instr-rules">
            {plan.rules.map((r, i) => <li key={i}><strong>{r.name}.</strong> {r.description}</li>)}
          </ol>
          {plan.doubts.length > 0 && <div className="ee-warn">{plan.doubts.map((d) => <div key={d}>Duda: {d}</div>)}</div>}
          <fieldset className="instr-autonomy">
            <legend className="label">¿Cómo quieres que actúe?</legend>
            <label className="radio-row"><input type="radio" name="autonomy" checked={autonomy === "ask"} onChange={() => setAutonomy("ask")} />Preguntarme antes de cada acción (recomendado al principio)</label>
            <label className="radio-row"><input type="radio" name="autonomy" checked={autonomy === "auto"} onChange={() => setAutonomy("auto")} />Hacerlo sola (lo verás en el registro y podrás deshacerlo)</label>
          </fieldset>
          <div className="ee-row">
            <button type="button" className="btn small" disabled={pending} onClick={activate}>{pending ? "Activando…" : "Activar"}</button>
            <button type="button" className="btn small secondary" disabled={pending} onClick={() => setPlan(null)}>Cambiar el texto</button>
          </div>
        </div>
      )}
    </div>
  );
}
