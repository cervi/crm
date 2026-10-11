"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";

export type SettingsItem = { href: string; title: string; text: string; icon: IconName; keywords?: string };
export type SettingsGroup = { key: string; title: string; hint: string; items: SettingsItem[] };

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Índice de ajustes agrupado, con buscador: escribe «contraseña», «firma», «festivos»… y te lleva. */
export function SettingsIndex({ groups }: { groups: SettingsGroup[] }) {
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const t = norm(q.trim());
    if (!t) return groups;
    return groups.map((g) => ({ ...g, items: g.items.filter((i) => norm(`${i.title} ${i.text} ${i.keywords ?? ""} ${g.title}`).includes(t)) }))
      .filter((g) => g.items.length);
  }, [q, groups]);
  const total = shown.reduce((n, g) => n + g.items.length, 0);
  return (
    <div className="settings-index">
      <aside className="settings-nav" aria-label="Grupos de ajustes">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar un ajuste…" aria-label="Buscar un ajuste" autoFocus
               onKeyDown={(e) => { if (e.key === "Enter" && total === 1) window.location.href = shown[0].items[0].href; }} />
        <nav>
          {groups.map((g) => <a key={g.key} href={`#${g.key}`} className={shown.some((s) => s.key === g.key) ? undefined : "dim"}>{g.title}</a>)}
        </nav>
      </aside>
      <div className="settings-groups">
        {shown.length === 0 && <p className="muted">Nada con «{q}». Prueba con otra palabra (p. ej. «correo», «usuarios», «IA»).</p>}
        {shown.map((g) => (
          <section key={g.key} id={g.key} className="settings-group" aria-labelledby={`h-${g.key}`}>
            <h2 id={`h-${g.key}`}>{g.title}</h2>
            <p className="meta">{g.hint}</p>
            <ul>
              {g.items.map((i) => (
                <li key={i.href}>
                  <Link href={i.href} className="settings-row">
                    <span className="settings-ico"><Icon name={i.icon} /></span>
                    <span><strong>{i.title}</strong><span className="meta">{i.text}</span></span>
                    <Icon name="chevron" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
