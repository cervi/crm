"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";

type Group = { group: string; items: readonly { key: string; label: string }[] };

/** Selector de rango de fechas: presets de calendario, «últimos…» y personalizado. */
export function PeriodPicker({ groups, current, label, fromIso, toIso }: { groups: readonly Group[]; current: string; label: string; fromIso: string; toIso: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(fromIso);
  const [to, setTo] = useState(toIso);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setFrom(fromIso); setTo(toIso); }, [fromIso, toIso]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const go = (patch: Record<string, string | null>) => {
    const q = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries({ g: null, ...patch })) { if (v) q.set(k, v); else q.delete(k); }
    router.push(`${pathname}?${q}#ventas`, { scroll: false });
    setOpen(false);
  };

  return (
    <div className="period-picker" ref={ref}>
      <button type="button" className="btn secondary" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="activities" />{label}<Icon name="chevron" />
      </button>
      {open && (
        <div className="period-pop" role="dialog" aria-label="Periodo">
          <div className="period-presets">
            {groups.map((g) => (
              <div key={g.group}>
                <span className="period-group">{g.group}</span>
                <ul>
                  {g.items.map((it) => (
                    <li key={it.key}>
                      <button type="button" aria-pressed={current === it.key} onClick={() => go({ r: it.key === "12m" ? null : it.key, from: null, to: null })}>
                        {it.label}{current === it.key && <Icon name="check" />}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <form className="period-custom" onSubmit={(e) => { e.preventDefault(); if (from && to && from <= to) go({ r: "custom", from, to }); }}>
            <span className="period-group">Personalizado</span>
            <label className="field"><span className="label">Desde *</span><input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} required /></label>
            <label className="field"><span className="label">Hasta *</span><input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} required /></label>
            <button type="submit" className="btn small" disabled={!from || !to || from > to}>Aplicar</button>
          </form>
        </div>
      )}
    </div>
  );
}
