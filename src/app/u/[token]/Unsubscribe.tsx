"use client";

import { useActionState } from "react";
import { unsubscribeAction } from "@/app/actions/outbound";

export function Unsubscribe({ token }: { token: string }) {
  const [state, action, pending] = useActionState(unsubscribeAction.bind(null, token), undefined);
  if (state?.ok) return <p role="status">Hecho: no volverás a recibir nuestros correos comerciales. Perdona las molestias.</p>;
  return (
    <form action={action} className="form">
      <p>¿Quieres dejar de recibir nuestros correos?</p>
      <button type="submit" className="btn" disabled={pending}>{pending ? "Un momento…" : "Darme de baja"}</button>
      {state?.error && <p className="form-error" role="alert">{state.error}</p>}
    </form>
  );
}
