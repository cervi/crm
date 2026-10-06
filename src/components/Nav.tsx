"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

export const NAV_ITEMS: { href: string; match: string[]; label: string; icon: IconName }[] = [
  { href: "/pipelines", match: ["/pipelines", "/deals"], label: "Deals", icon: "deals" },
  { href: "/leads", match: ["/leads"], label: "Leads", icon: "leads" },
  { href: "/activities", match: ["/activities"], label: "Actividades", icon: "activities" },
  { href: "/organizations", match: ["/organizations"], label: "Empresas", icon: "organizations" },
  { href: "/persons", match: ["/persons"], label: "Contactos", icon: "persons" },
  { href: "/dashboards", match: ["/dashboards"], label: "Dashboards", icon: "dashboards" },
  { href: "/settings", match: ["/settings"], label: "Ajustes", icon: "settings" },
];

/** Menú lateral colapsado: solo iconos, con el nombre al pasar el ratón. */
export function Nav() {
  const path = usePathname();
  return (
    <aside className="rail">
      <Link href="/" className="rail-brand" aria-label="Inicio"><Icon name="deals" /></Link>
      <nav aria-label="Principal">
        <ul>
          {NAV_ITEMS.map((item) => {
            const active = item.match.some((m) => path === m || path.startsWith(`${m}/`));
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={active ? "page" : undefined} aria-label={item.label} data-tip={item.label}>
                  <Icon name={item.icon} />
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
