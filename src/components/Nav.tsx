"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";
import { ThemeSwitch, type Theme } from "./ThemeSwitch";

const ITEMS: { href: string; match: string[]; label: string; icon: IconName }[] = [
  { href: "/pipelines", match: ["/pipelines", "/deals"], label: "Deals", icon: "deals" },
  { href: "/leads", match: ["/leads"], label: "Leads", icon: "leads" },
  { href: "/organizations", match: ["/organizations"], label: "Empresas", icon: "organizations" },
  { href: "/persons", match: ["/persons"], label: "Contactos", icon: "persons" },
  { href: "/activities", match: ["/activities"], label: "Actividades", icon: "activities" },
  { href: "/settings", match: ["/settings"], label: "Ajustes", icon: "settings" },
];

export function Nav({ theme }: { theme: Theme }) {
  const path = usePathname();
  return (
    <aside className="sidebar">
      <Link href="/" className="brand">
        <span className="brand-mark"><Icon name="deals" /></span>
        <span>CRM</span>
      </Link>
      <nav aria-label="Principal">
        <ul>
          {ITEMS.map((item) => {
            const active = item.match.some((m) => path === m || path.startsWith(`${m}/`));
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={active ? "page" : undefined}>
                  <Icon name={item.icon} /><span>{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="spacer" />
      <ThemeSwitch initial={theme} />
    </aside>
  );
}
