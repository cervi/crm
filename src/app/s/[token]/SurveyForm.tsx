"use client";

import { useActionState } from "react";
import { answerSurveyAction } from "@/app/actions/accounts";

export function SurveyForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(answerSurveyAction.bind(null, token), undefined);
  if (state?.ok) return <p role="status">¡Gracias! Nos ayuda mucho.</p>;
  return (
    <form action={action} className="form">
      <fieldset className="field">
        <legend>Del 0 al 10, ¿cómo de probable es que nos recomiendes a un colega?</legend>
        <div className="nps">
          {Array.from({ length: 11 }, (_, i) => (
            <label key={i}><input type="radio" name="score" value={i} required /><span>{i}</span></label>
          ))}
        </div>
      </fieldset>
      <label className="field"><span className="label">¿Algo que debamos mejorar? (opcional)</span><textarea name="comment" rows={3} /></label>
      <button type="submit" className="btn" disabled={pending}>{pending ? "Enviando…" : "Enviar"}</button>
      {state?.error && <p className="form-error" role="alert">{state.error}</p>}
    </form>
  );
}
