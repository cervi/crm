"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import type { ActionState } from "@/lib/errors";

type Props = {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  children?: React.ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  className?: string;
  /** Vacía el formulario tras guardar (útil en formularios de "añadir"). */
  resetOnSuccess?: boolean;
  danger?: boolean;
  good?: boolean;
  secondary?: boolean;
  /** Pide confirmación en el propio formulario explicando la consecuencia (acciones difíciles de deshacer). */
  confirm?: string;
};

/**
 * Formulario que envía una acción de servidor y muestra su error, si lo hay.
 * Se envía con onSubmit (no con `action`) porque React 19 vacía los campos
 * tras cada envío con `action`, y así se perdería lo escrito al haber un error.
 */
export function ActionForm({ action, children, submitLabel, pendingLabel, className, resetOnSuccess, danger, good, secondary, confirm }: Props) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);
  const [armed, setArmed] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
    // Confirmación visible de que se ha guardado, aunque la acción no traiga mensaje.
    if (state?.ok && !state.message) {
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 2500);
      return () => clearTimeout(t);
    }
  }, [state, resetOnSuccess]);

  return (
    <form
      ref={ref}
      className={className ?? "form"}
      onSubmit={(e) => {
        e.preventDefault();
        if (confirm && !armed) { setArmed(true); return; }
        setArmed(false);
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      {children}
      {state?.error && <p className="form-error" role="alert">{state.error}</p>}
      {state?.ok && state.message && <p className="form-ok" role="status">{state.message}</p>}
      {armed && <p className="form-confirm" role="alert">{confirm}</p>}
      <div className="form-actions">
        <button type="submit" disabled={pending} className={armed ? "btn danger" : danger ? "btn danger" : good ? "btn good" : secondary ? "btn secondary" : "btn"}>
          {pending ? (pendingLabel ?? "Guardando…") : armed ? `Sí, ${submitLabel.charAt(0).toLowerCase()}${submitLabel.slice(1)}` : submitLabel}
        </button>
        {armed && <button type="button" className="btn secondary" onClick={() => setArmed(false)}>Cancelar</button>}
        {saved && !pending && <span className="form-saved" role="status">✓ Hecho</span>}
      </div>
    </form>
  );
}
