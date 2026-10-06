"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

type Item = { id: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string; actor_name: string | null };

const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} día${d === 1 ? "" : "s"}`;
};

/** Campana de avisos de la barra superior. */
export function NotificationBell({ initialUnread }: { initialUnread: number }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(initialUnread);
  const [items, setItems] = useState<Item[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setUnread(initialUnread), [initialUnread]);
  useEffect(() => {
    if (!open) return;
    fetch("/api/notifications").then((r) => r.json()).then((j) => { setItems(j.items ?? []); setUnread(j.unread ?? 0); }).catch(() => setItems([]));
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const read = async (id?: string) => {
    const r = await fetch("/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(id ? { id } : {}) });
    const j = await r.json().catch(() => ({}));
    setUnread(j.unread ?? 0);
    setItems((list) => list?.map((x) => (!id || x.id === id ? { ...x, read_at: x.read_at ?? new Date().toISOString() } : x)) ?? null);
  };

  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="icon-btn bell" aria-label={unread ? `Avisos (${unread} sin leer)` : "Avisos"} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" />
        {unread > 0 && <span className="bell-count" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
      </button>
      {open && (
        <div className="dropdown notifications" role="dialog" aria-label="Avisos">
          <div className="notif-head">
            <span className="dropdown-label">Avisos</span>
            {unread > 0 && <button type="button" className="link-btn" onClick={() => read()}>Marcar todo como leído</button>}
          </div>
          {items === null ? <p className="meta" style={{ padding: "6px 10px" }}>Cargando…</p>
            : items.length === 0 ? <p className="meta" style={{ padding: "6px 10px" }}>No tienes avisos.</p>
            : (
              <ul>
                {items.map((n) => (
                  <li key={n.id} className={n.read_at ? "read" : "unread"}>
                    <Link href={n.link ?? "/notifications"} onClick={() => { if (!n.read_at) read(n.id); setOpen(false); }}>
                      <strong>{n.title}</strong>
                      {n.body && <span className="notif-body">{n.body}</span>}
                      <span className="meta">{n.actor_name ? `${n.actor_name} · ` : ""}{ago(n.created_at)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          <Link href="/notifications" className="notif-all" onClick={() => setOpen(false)}>Ver todos</Link>
        </div>
      )}
    </div>
  );
}
