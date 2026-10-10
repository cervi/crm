"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { saveNavPrefsAction } from "@/app/actions/preferences";
import { arrangeNav, NAV_ITEMS, type NavPrefs } from "@/lib/nav-items";
import { Icon } from "./Icon";

export { NAV_ITEMS };

type Item = (typeof NAV_ITEMS)[number];
const isActive = (item: Item, path: string) => item.match.some((m) => path === m || path.startsWith(`${m}/`));

/**
 * Menú lateral colapsado: solo iconos, con el nombre al pasar el ratón.
 * Cada persona elige qué secciones ve y en qué orden («Más» → «Personalizar
 * el menú»); las ocultas siguen a mano en «Más».
 */
export function Nav({ inboxCount = 0, prefs = {} }: { inboxCount?: number; prefs?: NavPrefs }) {
  const path = usePathname();
  const { visible, hidden } = arrangeNav(prefs);
  const [moreOpen, setMoreOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const moreRef = useRef<HTMLLIElement>(null);

  // «Más» se cierra al pulsar fuera, con Esc o al navegar.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: MouseEvent) => { if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMoreOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [moreOpen]);
  useEffect(() => setMoreOpen(false), [path]);

  const link = (item: Item) => {
    const count = item.href === "/inbox" ? inboxCount : 0;
    const label = count > 0 ? `${item.label} (${count} pendiente${count === 1 ? "" : "s"})` : item.label;
    return (
      <li key={item.href}>
        <Link href={item.href} aria-current={isActive(item, path) ? "page" : undefined} aria-label={label} data-tip={label}>
          <Icon name={item.icon} />
          {count > 0 && <span className="rail-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
        </Link>
      </li>
    );
  };
  const hiddenActive = hidden.some((i) => isActive(i, path));
  const hiddenInbox = hidden.some((i) => i.href === "/inbox") && inboxCount > 0;

  return (
    <aside className="rail">
      <Link href="/" className="rail-brand" aria-label="Inicio"><Icon name="deals" /></Link>
      <nav aria-label="Principal">
        <ul>
          {visible.slice(0, -1).map(link)}
          <li ref={moreRef} className="rail-more">
            <button type="button" aria-expanded={moreOpen} aria-haspopup="true" onClick={() => setMoreOpen((o) => !o)}
                    aria-label={hidden.length ? `Más secciones (${hidden.length})` : "Más: personalizar el menú"} data-tip={hidden.length ? "Más" : "Personalizar el menú"}
                    className={hiddenActive ? "current" : undefined}>
              <Icon name="dots" />
              {hiddenInbox && <span className="rail-count" aria-hidden="true">{inboxCount > 99 ? "99+" : inboxCount}</span>}
            </button>
            {moreOpen && (
              <div className="rail-pop" role="menu" aria-label="Más secciones">
                {hidden.length > 0 ? hidden.map((i) => (
                  <Link key={i.href} href={i.href} role="menuitem" aria-current={isActive(i, path) ? "page" : undefined}>
                    <Icon name={i.icon} />{i.label}
                    {i.href === "/inbox" && inboxCount > 0 && <span className="badge">{inboxCount}</span>}
                  </Link>
                )) : <p className="meta">Tienes todas las secciones en el menú.</p>}
                <hr />
                <button type="button" role="menuitem" onClick={() => { setMoreOpen(false); setEditing(true); }}>
                  <Icon name="pencil" />Personalizar el menú
                </button>
              </div>
            )}
          </li>
          {link(visible[visible.length - 1])}
        </ul>
      </nav>
      {editing && <NavEditor prefs={prefs} onClose={() => setEditing(false)} />}
    </aside>
  );
}

/** Elegir qué secciones salen en el menú y en qué orden. */
function NavEditor({ prefs, onClose }: { prefs: NavPrefs; onClose: () => void }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState(() => arrangeNav(prefs).all.map((i) => i.href));
  const [hidden, setHidden] = useState(() => new Set(prefs.hidden ?? []));
  const [state, setState] = useState<{ saving?: boolean; error?: string }>({});
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => { ref.current?.showModal(); }, []);

  const move = (href: string, delta: number) => setItems((list) => {
    const i = list.indexOf(href), j = i + delta;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const toggle = (href: string) => setHidden((h) => { const n = new Set(h); if (n.has(href)) n.delete(href); else n.add(href); return n; });

  async function save(p: NavPrefs | null) {
    setState({ saving: true });
    const r = await saveNavPrefsAction(p);
    if (r?.error) { setState({ error: r.error }); return; }
    router.refresh();
    onClose();
  }

  const byHref = (h: string) => NAV_ITEMS.find((i) => i.href === h)!;
  return (
    <dialog ref={ref} className="drawer nav-editor" aria-label="Personalizar el menú" onClose={onClose}
            onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}>
      <div className="drawer-inner">
        <header className="drawer-head">
          <div>
            <h2>Personalizar el menú</h2>
            <p className="meta">Elige qué secciones ves en el menú lateral y en qué orden. Las que quites siguen en «Más». Solo cambia tu menú, no el del equipo.</p>
          </div>
          <button type="button" className="icon-btn" onClick={() => ref.current?.close()} aria-label="Cerrar" title="Cerrar"><Icon name="x" /></button>
        </header>
        <div className="drawer-body">
          <ul className="nav-edit-list">
            <li className="fixed"><span className="grip" /><Icon name="home" /><span className="name">Hoy</span><span className="meta">Siempre arriba</span></li>
            {items.map((h, idx) => {
              const it = byHref(h), shown = !hidden.has(h);
              return (
                <li key={h} draggable onDragStart={() => setDragging(h)} onDragEnd={() => setDragging(null)}
                    onDragOver={(e) => { e.preventDefault(); if (dragging && dragging !== h) setItems((list) => { const n = list.filter((x) => x !== dragging); n.splice(n.indexOf(h) + (list.indexOf(dragging) < list.indexOf(h) ? 1 : 0), 0, dragging); return n; }); }}
                    className={[dragging === h ? "dragging" : "", shown ? "" : "off"].join(" ")}>
                  <span className="grip" aria-hidden="true"><Icon name="grip" /></span>
                  <label className="checkbox"><input type="checkbox" checked={shown} onChange={() => toggle(h)} aria-label={`Mostrar ${it.label} en el menú`} />
                    <Icon name={it.icon} /><span className="name">{it.label}</span></label>
                  <span className="order-btns">
                    <button type="button" className="icon-btn" onClick={() => move(h, -1)} disabled={idx === 0} aria-label={`Subir ${it.label}`} title="Subir"><Icon name="up" /></button>
                    <button type="button" className="icon-btn" onClick={() => move(h, 1)} disabled={idx === items.length - 1} aria-label={`Bajar ${it.label}`} title="Bajar"><Icon name="chevron" /></button>
                  </span>
                </li>
              );
            })}
            <li className="fixed"><span className="grip" /><Icon name="settings" /><span className="name">Ajustes</span><span className="meta">Siempre abajo</span></li>
          </ul>
          {state.error && <p className="form-error" role="alert">{state.error}</p>}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => save({ order: items, hidden: [...hidden] })} disabled={state.saving}>{state.saving ? "Guardando…" : "Guardar menú"}</button>
            <button type="button" className="btn secondary" onClick={() => ref.current?.close()}>Cancelar</button>
            <button type="button" className="btn secondary reset" onClick={() => save(null)} disabled={state.saving} title="Todas las secciones, en el orden de siempre">Restablecer</button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
