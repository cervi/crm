"use client";

import { useActionState, useState, useTransition } from "react";
import { createAgentKeyAction, type KeyState } from "@/app/actions/agents";

/** Alta de una clave: se muestra una sola vez. */
export function NewKey({ endpoint }: { endpoint: string }) {
  const [state, action, pending] = useActionState<KeyState, FormData>(createAgentKeyAction, undefined);
  const [, start] = useTransition();
  const [copied, setCopied] = useState(false);
  if (state?.key) {
    return (
      <div className="callout good" role="status">
        <p style={{ margin: "0 0 8px" }}><strong>Clave creada. Cópiala ahora: no se volverá a mostrar.</strong></p>
        <code className="key-box">{state.key}</code>
        <button type="button" className="btn small secondary" style={{ marginLeft: 8 }} onClick={async () => {
          try { await navigator.clipboard.writeText(state.key!); setCopied(true); } catch { /* sin permiso */ }
        }}>{copied ? "Copiada" : "Copiar"}</button>
        <p className="meta" style={{ margin: "8px 0 0" }}>Servidor MCP: <code>{endpoint}</code> · cabecera <code>Authorization: Bearer &lt;clave&gt;</code></p>
      </div>
    );
  }
  return (
    <form className="form inline" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); start(() => action(d)); }}>
      <label className="field"><span className="label">Nombre del agente *</span><input name="name" required placeholder="Grok Bot" /></label>
      <label className="checkbox"><input type="checkbox" name="can_write" defaultChecked />Puede proponer acciones (si no, solo consulta)</label>
      {state?.error && <p className="form-error" role="alert">{state.error}</p>}
      <div className="form-actions"><button type="submit" className="btn" disabled={pending}>{pending ? "Creando…" : "Crear clave"}</button></div>
    </form>
  );
}
