"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { listAiModelsAction } from "@/app/actions/ai";

type Provider = { value: string; label: string; baseUrl: string; modelHint: string };
type Model = { id: string; name: string; note?: string; created?: string | null };

/**
 * Proveedor, modelo, clave y dirección de la API. El modelo se elige de una
 * lista: la de serie del proveedor o la que devuelve su API con tu clave.
 */
export function AiProviderFields({ providers, initial, hasKey, known, keyWarning }: {
  providers: Provider[];
  initial: { provider: string; model: string; baseUrl: string };
  hasKey: boolean;
  known: Record<string, { id: string; note: string }[]>;
  keyWarning?: string | null;
}) {
  const [provider, setProvider] = useState(initial.provider);
  const [model, setModel] = useState(initial.model);
  const [key, setKey] = useState("");
  const [base, setBase] = useState(initial.baseUrl);
  const [loaded, setLoaded] = useState<{ provider: string; models: Model[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);
  const p = providers.find((x) => x.value === provider);
  const none = provider === "none";

  const models: Model[] = loaded?.provider === provider ? loaded.models
    : (known[provider] ?? []).map((m) => ({ id: m.id, name: m.id, note: m.note }));
  const filtered = models.filter((m) => !model || open === false || m.id.toLowerCase().includes(model.toLowerCase()) || m.name.toLowerCase().includes(model.toLowerCase()));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const load = () => {
    setError(null);
    start(async () => {
      const r = await listAiModelsAction(provider, key, base);
      if (r.error) { setError(r.error); return; }
      setLoaded({ provider, models: r.models ?? [] });
      setOpen(true);
    });
  };

  return (
    <div className="grid-2 ai-fields">
      <label className="field"><span className="label">Proveedor</span>
        <select name="provider" value={provider} onChange={(e) => { setProvider(e.target.value); setError(null); setOpen(false); }}>
          {providers.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
        </select>
      </label>

      <div className="field" ref={wrap}>
        <span className="label" id="model-label">Modelo</span>
        <div className="model-picker">
          <input name="model" value={model} onChange={(e) => { setModel(e.target.value); setOpen(true); }} onFocus={() => models.length && setOpen(true)}
                 placeholder={none ? "No hace falta" : p?.modelHint || "Elige o escribe el modelo"} disabled={none} autoComplete="off"
                 aria-labelledby="model-label" aria-expanded={open} role="combobox" aria-controls="model-list" />
          {!none && (
            <button type="button" className="btn secondary" onClick={load} disabled={pending}
                    title="Pregunta al proveedor qué modelos tiene tu cuenta (usa la clave)">
              {pending ? "Buscando…" : loaded?.provider === provider ? "Actualizar lista" : "Ver modelos"}
            </button>
          )}
          {open && filtered.length > 0 && !none && (
            <ul className="model-list" id="model-list" role="listbox">
              {filtered.slice(0, 60).map((m) => (
                <li key={m.id} role="option" aria-selected={m.id === model}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => { setModel(m.id); setOpen(false); }}>
                  <strong>{m.name}</strong>
                  {m.name !== m.id && <code>{m.id}</code>}
                  {m.note && <span className="meta">{m.note}</span>}
                  {m.created && <span className="meta">{new Date(m.created).toLocaleDateString("es-ES", { month: "short", year: "numeric" })}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {error ? <span className="meta tone-bad">{error}</span>
          : <span className="meta">{none ? "Sin IA, los resúmenes se hacen con reglas." : loaded?.provider === provider ? `${loaded.models.length} modelos disponibles en tu cuenta.` : "Pulsa «Ver modelos» para ver los de tu cuenta (hace falta la clave)."}</span>}
      </div>

      <label className="field"><span className="label">Clave de API</span>
        <input name="api_key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} disabled={none}
               placeholder={hasKey ? "Guardada (escribe otra para cambiarla)" : "Pega aquí la clave"} />
        {keyWarning ? <span className="meta tone-bad">{keyWarning}</span> : <span className="meta">Se guarda cifrada. No se vuelve a mostrar.</span>}
      </label>

      <label className="field"><span className="label">Dirección de la API (opcional)</span>
        <input name="base_url" value={base} onChange={(e) => setBase(e.target.value)} disabled={none}
               placeholder={p?.baseUrl ? `Por defecto, ${p.baseUrl}` : "https://…"} />
        <span className="meta">Solo para «Otro compatible» o si usáis un proxy.</span>
      </label>
    </div>
  );
}
