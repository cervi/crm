"use client";

import { useState } from "react";

/**
 * Borrador de correo editable. Hasta tener buzón conectado se envía desde tu
 * correo («Abrir en el correo» o «Copiar») y luego se marca como enviado.
 */
export function EmailDraftFields({ to, subject, body }: { to: string; subject: string; body: string }) {
  const [v, setV] = useState({ to, subject, body });
  const [copied, setCopied] = useState(false);
  const mailto = `mailto:${encodeURIComponent(v.to)}?subject=${encodeURIComponent(v.subject)}&body=${encodeURIComponent(v.body)}`;
  return (
    <div className="email-draft">
      <label className="field"><span className="label">Para</span>
        <input name="to" type="email" required value={v.to} onChange={(e) => setV({ ...v, to: e.target.value })} />
      </label>
      <label className="field"><span className="label">Asunto</span>
        <input name="subject" required value={v.subject} onChange={(e) => setV({ ...v, subject: e.target.value })} />
      </label>
      <label className="field"><span className="label">Texto</span>
        <textarea name="body" rows={7} required value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} />
      </label>
      <div className="email-draft-tools">
        <a className="btn secondary small" href={mailto}>Abrir en el correo</a>
        <button type="button" className="btn secondary small" onClick={async () => {
          try {
            await navigator.clipboard.writeText(`${v.subject}\n\n${v.body}`);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch { /* sin permiso para el portapapeles */ }
        }}>{copied ? "Copiado" : "Copiar texto"}</button>
        <span className="meta">Envíalo desde tu correo y márcalo como enviado: quedará en la historia del deal.</span>
      </div>
    </div>
  );
}
