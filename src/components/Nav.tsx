"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/pipelines", match: ["/pipelines", "/deals"], label: "Deals" },
  { href: "/leads", match: ["/leads"], label: "Leads" },
  { href: "/organizations", match: ["/organizations"], label: "Empresas" },
  { href: "/persons", match: ["/persons"], label: "Contactos" },
  { href: "/activities", match: ["/activities"], label: "Actividades" },
  { href: "/settings", match: ["/settings"], label: "Ajustes" },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="sidebar" aria-label="Principal">
      <Link href="/" className="brand">CRM</Link>
      <ul>
        {ITEMS.map((item) => {
          const active = item.match.some((m) => path === m || path.startsWith(`${m}/`));
          return (
            <li key={item.href}>
              <Link href={item.href} aria-current={active ? "page" : undefined}>{item.label}</Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
