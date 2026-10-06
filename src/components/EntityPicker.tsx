"use client";

import { useEffect, useId, useRef, useState } from "react";

type Option = { id: string; label: string; hint?: string | null };

type Props = {
  name: string;
  /** Tipo de entidad que se busca en /api/lookup. */
  type: "organizations" | "persons";
  label: string;
  initial?: Option | null;
  required?: boolean;
  placeholder?: string;
};

/**
 * Selector con búsqueda para empresas o contactos. Guarda el id en un campo
 * oculto; escala a miles de registros porque busca en el servidor.
 */
export function EntityPicker({ name, type, label, initial, required, placeholder }: Props) {
  const [selected, setSelected] = useState<Option | null>(initial ?? null);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Option[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    const controller = new AbortController();
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/lookup?type=${type}&q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (res.ok) { setOptions(await res.json()); setActive(0); }
      } catch { /* búsqueda cancelada */ }
    }, 150);
    return () => controller.abort();
  }, [query, open, type]);

  const pick = (o: Option | null) => { setSelected(o); setOpen(false); setQuery(""); };

  return (
    <div className="field picker">
      <span className="label">{label}</span>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      {selected && !open ? (
        <div className="picker-selected">
          <span>{selected.label}</span>
          <button type="button" className="link" onClick={() => setOpen(true)}>Cambiar</button>
          {!required && <button type="button" className="link" onClick={() => pick(null)}>Quitar</button>}
        </div>
      ) : (
        <div className="picker-search">
          <input
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-label={label}
            placeholder={placeholder ?? "Buscar…"}
            value={query}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, options.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              if (e.key === "Enter" && open && options[active]) { e.preventDefault(); pick(options[active]); }
              if (e.key === "Escape") setOpen(false);
            }}
          />
          {open && (
            <ul id={listId} role="listbox" className="picker-list">
              {options.length === 0 && <li className="muted">Sin resultados</li>}
              {options.map((o, i) => (
                <li key={o.id} role="option" aria-selected={i === active}
                    onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
                  {o.label}{o.hint && <span className="muted"> · {o.hint}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
