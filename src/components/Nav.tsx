"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./Icon";

export const NAV_ITEMS: { href: string; match: string[]; label: string; icon: IconName }[] = [
  { href: "/", match: ["/"], label: "Hoy", icon: "home" },
  { href: "/pipelines", match: ["/pipelines", "/deals"], label: "Deals", icon: "deals" },
  { href: "/inbox", match: ["/inbox"], label: "Bandeja de la IA", icon: "inbox" },
  { href: "/sequences", match: ["/sequences"], label: "Secuencias", icon: "send" },
  { href: "/emails", match: ["/emails"], label: "Correos enviados", icon: "mail" },
  { href: "/leads", match: ["/leads"], label: "Leads", icon: "leads" },
  { href: "/activities", match: ["/activities"], label: "Actividades", icon: "activities" },
  { href: "/organizations", match: ["/organizations"], label: "Empresas", icon: "organizations" },
  { href: "/persons", match: ["/persons"], label: "Contactos", icon: "persons" },
  { href: "/reports", match: ["/reports", "/dashboards"], label: "Informes y dashboards", icon: "dashboards" },
  { href: "/settings", match: ["/settings"], label: "Ajustes", icon: "settings" },
];

/** Menú lateral colapsado: solo iconos, con el nombre al pasar el ratón. */
export function Nav({ inboxCount = 0 }: { inboxCount?: number }) {
  const path = usePathname();
  return (
    <aside className="rail">
      <Link href="/" className="rail-brand" aria-label="Inicio"><Icon name="deals" /></Link>
      <nav aria-label="Principal">
        <ul>
          {NAV_ITEMS.map((item) => {
            const active = item.match.some((m) => path === m || path.startsWith(`${m}/`));
            const count = item.href === "/inbox" ? inboxCount : 0;
            const label = count > 0 ? `${item.label} (${count} pendiente${count === 1 ? "" : "s"})` : item.label;
            return (
              <li key={item.href}>
                <Link href={item.href} aria-current={active ? "page" : undefined} aria-label={label} data-tip={label}>
                  <Icon name={item.icon} />
                  {count > 0 && <span className="rail-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
