"use client";

import { useState } from "react";
import { docLinkAction } from "@/app/actions/library";

/** Copia un enlace con seguimiento del documento (para un contacto/deal o genérico). */
export function ShareDocButton({ libraryId, fileId, dealId, personId, label = "Copiar enlace con seguimiento", className = "btn secondary small" }: {
  libraryId?: string; fileId?: string; dealId?: string | null; personId?: string | null; label?: string; className?: string;
}) {
  const [state, setState] = useState<{ busy?: boolean; done?: boolean; error?: string }>({});
  return (
    <>
      <button type="button" className={className} disabled={state.busy} title="Cada vez que alguien lo abra con este enlace, quedará registrado"
              onClick={async () => {
                setState({ busy: true });
                const r = await docLinkAction({ libraryId, fileId, dealId, personId });
                if (r.error || !r.url) { setState({ error: r.error ?? "No se pudo crear el enlace." }); return; }
                try { await navigator.clipboard.writeText(r.url); setState({ done: true }); } catch { window.prompt("Copia el enlace:", r.url); setState({}); }
                setTimeout(() => setState({}), 2500);
              }}>
        {state.done ? "Enlace copiado" : label}
      </button>
      {state.error && <span className="meta tone-bad" role="alert"> {state.error}</span>}
    </>
  );
}
