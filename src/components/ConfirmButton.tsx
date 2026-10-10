"use client";

import { useState } from "react";

/**
 * Botón de envío que pide confirmación en el sitio (sin ventanas del navegador)
 * antes de una acción difícil de deshacer. Se usa dentro de un <form action=…>.
 */
export function ConfirmButton({ label, confirm, className = "btn secondary small", ariaLabel }: { label: string; confirm: string; className?: string; ariaLabel?: string }) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return <button type="button" className={className} aria-label={ariaLabel} onClick={() => setArmed(true)}>{label}</button>;
  }
  return (
    <span className="confirm-inline" role="alert">
      <span>{confirm}</span>
      <button type="submit" className="btn danger small">Sí, {label.charAt(0).toLowerCase()}{label.slice(1)}</button>
      <button type="button" className="btn secondary small" onClick={() => setArmed(false)}>Cancelar</button>
    </span>
  );
}
