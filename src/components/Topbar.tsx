"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { GlobalSearch } from "./GlobalSearch";
import { Icon } from "./Icon";
import { NAV_ITEMS } from "./Nav";
import { logoutAction } from "@/app/actions/auth";
import { NotificationBell } from "./NotificationBell";

export type Theme = "light" | "dark" | "system";

const NEW_ITEMS = [
  { href: "/deals/new", label: "Deal" },
  { href: "/leads/new", label: "Lead" },
  { href: "/persons/new", label: "Contacto" },
  { href: "/organizations/new", label: "Empresa" },
];

const THEMES: { value: Theme; label: string }[] = [
  { value: "light", label: "Claro" },
  { value: "dark", label: "Oscuro" },
  { value: "system", label: "Como el sistema" },
];

/** Cierra un menú desplegable al pulsar fuera o Escape. */
function useMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return { open, setOpen, ref };
}

export type TopbarUser = { name: string; email: string; role: "admin" | "member" | "viewer" };
const ROLE: Record<TopbarUser["role"], string> = { admin: "Administrador", member: "Comercial", viewer: "Solo lectura" };

export function Topbar({ theme: initialTheme, user: me, unread = 0 }: { theme: Theme; user: TopbarUser; unread?: number }) {
  const path = usePathname();
  const section = NAV_ITEMS.find((i) => i.match.some((m) => path === m || path.startsWith(`${m}/`)))?.label
    ?? (path.startsWith("/search") ? "Búsqueda" : "");
  const add = useMenu();
  const user = useMenu();
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const chooseTheme = (value: Theme) => {
    setTheme(value);
    const root = document.documentElement;
    if (value === "system") delete root.dataset.theme;
    else root.dataset.theme = value;
    // En una cookie para que el servidor pinte ya el tema correcto (sin destello).
    document.cookie = `theme=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  };

  return (
    <header className="topbar">
      <div className="topbar-section">{section}</div>
      <GlobalSearch />
      <div className="topbar-actions">
        <NotificationBell initialUnread={unread} />
        <div className="menu-wrap" ref={add.ref}>
          <button type="button" className="icon-btn" aria-label="Crear" aria-expanded={add.open} onClick={() => add.setOpen((o) => !o)}>
            <Icon name="plus" />
          </button>
          {add.open && (
            <div className="dropdown" role="menu">
              <div className="dropdown-label">Crear</div>
              {NEW_ITEMS.map((i) => (
                <Link key={i.href} href={i.href} role="menuitem" onClick={() => add.setOpen(false)}>{i.label}</Link>
              ))}
            </div>
          )}
        </div>
        <div className="menu-wrap" ref={user.ref}>
          <button type="button" className="icon-btn user-btn" aria-label={`Tu cuenta (${me.name})`} aria-expanded={user.open} onClick={() => user.setOpen((o) => !o)}>
            <span className="user-initials" aria-hidden="true">{initials(me.name)}</span>
          </button>
          {user.open && (
            <div className="dropdown" role="menu">
              <div className="dropdown-user">
                <strong>{me.name}</strong>
                <span>{me.email}</span>
                <span className="muted">{ROLE[me.role]}</span>
              </div>
              <div className="dropdown-sep" />
              <div className="dropdown-label">Apariencia</div>
              {THEMES.map((t) => (
                <button key={t.value} type="button" role="menuitemradio" aria-checked={theme === t.value} onClick={() => chooseTheme(t.value)}>
                  <span className="check">{theme === t.value && <Icon name="check" />}</span>{t.label}
                </button>
              ))}
              <div className="dropdown-sep" />
              <Link href="/account" role="menuitem" onClick={() => user.setOpen(false)}>Mi cuenta</Link>
              <Link href="/settings" role="menuitem" onClick={() => user.setOpen(false)}>Ajustes</Link>
              <form action={logoutAction}>
                <button type="submit" role="menuitem">Cerrar sesión</button>
              </form>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
