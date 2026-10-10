"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * Panel lateral para editar algo sin salir de la página (una fila de una
 * tabla, una cuenta…). Se abre con su botón, se cierra con Esc, la X o
 * pulsando fuera, y mantiene el foco dentro mientras está abierto.
 */
export function Drawer({ label, title, subtitle, children, buttonClass = "btn secondary small", buttonTitle, defaultOpen = false }: {
  label: ReactNode; title: string; subtitle?: ReactNode; children: ReactNode; buttonClass?: string; buttonTitle?: string; defaultOpen?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <>
      <button type="button" className={buttonClass} onClick={() => setOpen(true)} title={buttonTitle} aria-label={buttonTitle} aria-haspopup="dialog">{label}</button>
      <dialog ref={ref} className="drawer" aria-label={title} onClose={() => setOpen(false)}
              onClick={(e) => { if (e.target === ref.current) setOpen(false); }}>
        {open && (
          <div className="drawer-inner">
            <header className="drawer-head">
              <div>
                <h2>{title}</h2>
                {subtitle && <p className="meta">{subtitle}</p>}
              </div>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar" title="Cerrar"><Icon name="x" /></button>
            </header>
            <div className="drawer-body">{children}</div>
          </div>
        )}
      </dialog>
    </>
  );
}
