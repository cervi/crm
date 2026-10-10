"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

// Atajos de teclado para moverse sin ratón. «?» enseña la lista.
const GO: Record<string, { href: string; label: string }> = {
  h: { href: "/", label: "Hoy" },
  d: { href: "/deals", label: "Mis deals" },
  t: { href: "/pipelines", label: "Tablero de deals" },
  a: { href: "/activities", label: "Actividades" },
  i: { href: "/inbox", label: "Bandeja de la IA" },
  l: { href: "/leads", label: "Leads" },
  c: { href: "/persons", label: "Contactos" },
  e: { href: "/organizations", label: "Empresas" },
  r: { href: "/reports", label: "Informes" },
};
const NEW: Record<string, { href: string; label: string }> = {
  d: { href: "/deals/new", label: "Nuevo deal" },
  c: { href: "/persons/new", label: "Nuevo contacto" },
  e: { href: "/organizations/new", label: "Nueva empresa" },
  l: { href: "/leads/new", label: "Nuevo lead" },
};

export function Shortcuts() {
  const router = useRouter();
  const [help, setHelp] = useState(false);
  const prefix = useRef<{ key: "g" | "n"; at: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target as HTMLElement;
      if (el.closest?.("input, textarea, select, [contenteditable], dialog[open]")) return;
      const k = e.key.toLowerCase();
      const p = prefix.current && Date.now() - prefix.current.at < 1500 ? prefix.current : null;
      prefix.current = null;
      if (p) {
        const target = (p.key === "g" ? GO : NEW)[k];
        if (target) { e.preventDefault(); router.push(target.href); }
        return;
      }
      if (k === "g" || k === "n") { prefix.current = { key: k, at: Date.now() }; return; }
      if (e.key === "?") { e.preventDefault(); setHelp(true); }
    };
    const open = () => setHelp(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("crm:shortcuts", open);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("crm:shortcuts", open); };
  }, [router]);

  useEffect(() => {
    if (help && !dialog.current?.open) dialog.current?.showModal();
  }, [help]);

  if (!help) return null;
  const Row = ({ keys, label }: { keys: string[]; label: string }) => (
    <li><span className="kbds">{keys.map((x, i) => <kbd key={i}>{x}</kbd>)}</span><span>{label}</span></li>
  );
  return (
    <dialog ref={dialog} className="drawer shortcuts" aria-label="Atajos de teclado" onClose={() => setHelp(false)}
            onClick={(e) => { if (e.target === dialog.current) dialog.current?.close(); }}>
      <div className="drawer-inner">
        <header className="drawer-head">
          <div><h2>Atajos de teclado</h2><p className="meta">Funcionan cuando no estás escribiendo en un campo.</p></div>
          <button type="button" className="icon-btn" onClick={() => dialog.current?.close()} aria-label="Cerrar" title="Cerrar"><Icon name="x" /></button>
        </header>
        <div className="drawer-body">
          <h3>General</h3>
          <ul className="shortcut-list">
            <Row keys={["/"]} label="Buscar (también ⌘K o Ctrl K)" />
            <Row keys={["?"]} label="Ver estos atajos" />
            <Row keys={["Esc"]} label="Cerrar paneles y ventanas" />
          </ul>
          <h3>Ir a…</h3>
          <ul className="shortcut-list">
            {Object.entries(GO).map(([k, v]) => <Row key={k} keys={["g", k]} label={v.label} />)}
          </ul>
          <h3>Crear</h3>
          <ul className="shortcut-list">
            {Object.entries(NEW).map(([k, v]) => <Row key={k} keys={["n", k]} label={v.label} />)}
          </ul>
          <h3>En el tablero, con un deal abierto en el panel</h3>
          <ul className="shortcut-list">
            <Row keys={["j"]} label="Deal siguiente" />
            <Row keys={["k"]} label="Deal anterior" />
          </ul>
        </div>
      </div>
    </dialog>
  );
}
