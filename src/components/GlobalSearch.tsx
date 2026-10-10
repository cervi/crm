"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./Icon";

type Hit = { type: "deal" | "person" | "organization" | "lead"; id: string; title: string; subtitle: string | null; href: string };
const LABEL: Record<Hit["type"], string> = { deal: "Deals", person: "Contactos", organization: "Empresas", lead: "Leads" };

/** Buscador de la barra superior: deals, contactos, empresas y leads. Atajo: ⌘K / Ctrl+K. */
export function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest?.("input, textarea, select, [contenteditable]");
      if (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") || (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault(); input.current?.focus(); input.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: ctrl.signal });
        if (res.ok) { setHits(await res.json()); setActive(0); }
      } catch { /* cancelada */ } finally { setLoading(false); }
    }, 160);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q]);

  const go = (href: string) => { setOpen(false); setQ(""); input.current?.blur(); router.push(href); };
  const showAll = () => go(`/search?q=${encodeURIComponent(q.trim())}`);

  return (
    <div className="global-search" role="search">
      <Icon name="search" />
      <input
        ref={input}
        role="combobox"
        aria-expanded={open && q.trim().length >= 2}
        aria-controls={listId}
        aria-label="Buscar en el CRM"
        placeholder="Buscar deals, contactos, empresas o leads"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length)); }
          if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === "Enter" && q.trim().length >= 2) { e.preventDefault(); if (hits[active]) go(hits[active].href); else showAll(); }
          if (e.key === "Escape") { setOpen(false); input.current?.blur(); }
        }}
      />
      <kbd className="kbd" aria-hidden="true">⌘K</kbd>
      {open && q.trim().length >= 2 && (
        <div id={listId} role="listbox" className="search-results">
          {!loading && hits.length === 0 && <div className="search-empty">Sin resultados para «{q}»</div>}
          {(["deal", "person", "organization", "lead"] as const).map((type) => {
            const group = hits.map((h, i) => ({ h, i })).filter((x) => x.h.type === type);
            if (!group.length) return null;
            return (
              <div key={type} className="search-group">
                <div className="search-group-label">{LABEL[type]}</div>
                {group.map(({ h, i }) => (
                  <div key={h.id} role="option" aria-selected={i === active} className="search-hit"
                       onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); go(h.href); }}>
                    <span className="search-hit-title">{h.title}</span>
                    {h.subtitle && <span className="meta">{h.subtitle}</span>}
                  </div>
                ))}
              </div>
            );
          })}
          {hits.length > 0 && (
            <div role="option" aria-selected={active === hits.length} className="search-hit search-all"
                 onMouseEnter={() => setActive(hits.length)} onMouseDown={(e) => { e.preventDefault(); showAll(); }}>
              Ver todos los resultados
            </div>
          )}
        </div>
      )}
    </div>
  );
}
