"use client";

import { useState } from "react";

/** Copiar el enlace personal de un firmante (para mandárselo por otro canal). */
export function CopyLink({ url }: { url: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn secondary small" title="Su enlace personal: mándaselo por otro canal si no encuentra el correo"
            onClick={async () => { try { await navigator.clipboard.writeText(url); setDone(true); setTimeout(() => setDone(false), 2000); } catch { window.prompt("Copia el enlace:", url); } }}>
      {done ? "Copiado" : "Copiar enlace"}
    </button>
  );
}
