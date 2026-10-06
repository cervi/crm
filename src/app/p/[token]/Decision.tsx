"use client";

import { useActionState, useState, useTransition } from "react";
import { decideProposalAction, type DecideState } from "@/app/actions/products";

export function Decision({ token }: { token: string }) {
  const [state, action, pending] = useActionState<DecideState, FormData>(decideProposalAction.bind(null, token), undefined);
  const [, start] = useTransition();
  const [decision, setDecision] = useState<"accept" | "decline">("accept");
  if (state?.done === "accepted") return <p className="callout good" role="status">¡Propuesta aceptada! Te escribimos enseguida con los siguientes pasos.</p>;
  if (state?.done === "declined") return <p className="callout" role="status">Gracias por responder. Lo tendremos en cuenta.</p>;
  return (
    <form className="proposal-decision" onSubmit={(e) => {
      e.preventDefault();
      // El botón pulsado (aceptar o rechazar) va en los datos del formulario.
      const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      setDecision(submitter?.value === "decline" ? "decline" : "accept");
      const d = new FormData(e.currentTarget, submitter);
      start(() => action(d));
    }}>
      <label className="field"><span className="label">Tu nombre</span><input name="name" required autoComplete="name" /></label>
      <label className="field"><span className="label">Comentario (opcional)</span><textarea name="note" rows={2} /></label>
      {state?.error && <p className="form-error" role="alert">{state.error}</p>}
      <div className="form-actions">
        <button type="submit" name="decision" value="accept" className="btn good" disabled={pending}>{pending && decision === "accept" ? "Enviando…" : "Aceptar la propuesta"}</button>
        <button type="submit" name="decision" value="decline" className="btn secondary" disabled={pending}>No, gracias</button>
      </div>
    </form>
  );
}
