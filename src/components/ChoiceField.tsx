"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";

type Opt = { key: string; label: string };

/**
 * Selector de opciones para campos personalizados.
 *  · Pocas opciones (≤ 4): pastillas que se encienden con un clic (Sí / No…).
 *  · Muchas: un desplegable con buscador, casillas y las elegidas como etiquetas.
 * Envía los valores como inputs ocultos con el mismo `name` (igual que las casillas).
 */
export function ChoiceField({ name, label, options, initial, multiple, required }: {
  name: string; label: string; options: Opt[]; initial: string[]; multiple: boolean; required?: boolean;
}) {
  const [picked, setPicked] = useState<string[]>(initial.filter((k) => options.some((o) => o.key === k)));
  const labelId = useId();
  const toggle = (key: string) =>
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : multiple ? [...p, key] : [key]));
  const hidden = multiple
    ? picked.map((k) => <input key={k} type="hidden" name={name} value={k} />)
    : <input type="hidden" name={name} value={picked[0] ?? ""} />;
  const heading = <span className="label" id={labelId}>{label}{required && " *"}</span>;

  if (options.length <= 4) {
    return (
      <div className="field">
        {heading}
        <div className="choice-pills" role="group" aria-labelledby={labelId}>
          {options.map((o) => (
            <button key={o.key} type="button" aria-pressed={picked.includes(o.key)} onClick={() => toggle(o.key)}>
              {picked.includes(o.key) && <Icon name="check" />}{o.label}
            </button>
          ))}
        </div>
        {hidden}
      </div>
    );
  }

  return (
    <div className="field">
      {heading}
      <Dropdown options={options} picked={picked} toggle={toggle} multiple={multiple} labelId={labelId}
                clear={() => setPicked([])} />
      {hidden}
    </div>
  );
}

function Dropdown({ options, picked, toggle, multiple, labelId, clear }: {
  options: Opt[]; picked: string[]; toggle: (k: string) => void; multiple: boolean; labelId: string; clear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const byKey = useMemo(() => new Map(options.map((o) => [o.key, o.label])), [options]);
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    search.current?.focus();
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const choose = (k: string) => { toggle(k); if (!multiple) setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); if (shown[active]) choose(shown[active].key); }
  };

  return (
    <div className="ms" ref={wrap} onKeyDown={open ? onKey : undefined}>
      <div className={`ms-control${open ? " open" : ""}`} role="combobox" aria-expanded={open} aria-controls={listId}
           aria-labelledby={labelId} tabIndex={0}
           onClick={() => setOpen((o) => !o)}
           onKeyDown={(e) => { if (!open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) { e.preventDefault(); setOpen(true); } }}>
        {picked.length === 0 && <span className="ms-placeholder">Elegir…</span>}
        {picked.map((k) => (
          <span key={k} className="ms-tag">
            {byKey.get(k)}
            <button type="button" aria-label={`Quitar ${byKey.get(k)}`} onClick={(e) => { e.stopPropagation(); toggle(k); }}><Icon name="x" /></button>
          </span>
        ))}
        <span className="ms-chevron"><Icon name="chevron" /></span>
      </div>
      {open && (
        <div className="ms-pop">
          {options.length > 7 && (
            <input ref={search} className="ms-search" placeholder="Buscar…" value={q} aria-label="Buscar opción"
                   onChange={(e) => { setQ(e.target.value); setActive(0); }} />
          )}
          <ul id={listId} role="listbox" aria-multiselectable={multiple || undefined}>
            {shown.map((o, i) => {
              const on = picked.includes(o.key);
              return (
                <li key={o.key} role="option" aria-selected={on} className={i === active ? "active" : undefined}
                    onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o.key)}>
                  <span className={`ms-check${multiple ? "" : " radio"}`}>{on && <Icon name="check" />}</span>{o.label}
                </li>
              );
            })}
            {shown.length === 0 && <li className="ms-empty">Sin resultados</li>}
          </ul>
          {picked.length > 0 && (
            <div className="ms-foot">
              <span className="meta">{picked.length} elegida{picked.length === 1 ? "" : "s"}</span>
              <button type="button" className="link-btn meta" onClick={clear}>Quitar todas</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
