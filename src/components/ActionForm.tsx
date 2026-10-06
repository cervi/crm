"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";
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
};

/**
 * Formulario que envía una acción de servidor y muestra su error, si lo hay.
 * Se envía con onSubmit (no con `action`) porque React 19 vacía los campos
 * tras cada envío con `action`, y así se perdería lo escrito al haber un error.
 */
export function ActionForm({ action, children, submitLabel, pendingLabel, className, resetOnSuccess, danger, good, secondary }: Props) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [, startTransition] = useTransition();
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (resetOnSuccess && state?.ok) ref.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <form
      ref={ref}
      className={className ?? "form"}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      {children}
      {state?.error && <p className="form-error" role="alert">{state.error}</p>}
      <div className="form-actions">
        <button type="submit" disabled={pending} className={danger ? "btn danger" : good ? "btn good" : secondary ? "btn secondary" : "btn"}>
          {pending ? (pendingLabel ?? "Guardando…") : submitLabel}
        </button>
      </div>
    </form>
  );
}
