"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

type Opt = { value: string; label: string };

/** Elegir qué columnas se ven en una lista (se guardan en la URL, y con ella en las vistas). */
export function ColumnPicker({ options, selected, defaults }: { options: Opt[]; selected: string[]; defaults: string[] }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string[]>(selected);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setChosen(selected), [selected]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const apply = (cols: string[]) => {
    const next = new URLSearchParams(params.toString());
    const same = cols.length === defaults.length && cols.every((c, i) => c === defaults[i]);
    if (same) next.delete("cols"); else next.set("cols", cols.join(","));
    next.delete("deal");
    router.push(`${path}?${next}`);
    setOpen(false);
  };

  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn secondary" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="list" />Columnas
      </button>
      {open && (
        <div className="dropdown column-picker" role="dialog" aria-label="Columnas">
          <div className="dropdown-label">Columnas visibles</div>
          {options.map((o) => (
            <label key={o.value} className="checkbox">
              <input type="checkbox" checked={chosen.includes(o.value)}
                     onChange={(e) => setChosen((c) => e.target.checked ? options.map((x) => x.value).filter((v) => v === o.value || c.includes(v)) : c.filter((v) => v !== o.value))} />
              {o.label}
            </label>
          ))}
          <div className="dropdown-sep" />
          <div className="column-picker-actions">
            <button type="button" className="btn small" disabled={chosen.length === 0} onClick={() => apply(chosen)}>Aplicar</button>
            <button type="button" className="btn small secondary" onClick={() => apply(defaults)}>Por defecto</button>
          </div>
        </div>
      )}
    </div>
  );
}
