import type { IconName } from "@/components/Icon";

/** Secciones del menú lateral. «Hoy» y «Ajustes» están siempre; el resto se puede ordenar u ocultar. */
export const NAV_ITEMS: { href: string; match: string[]; label: string; icon: IconName; fixed?: boolean }[] = [
  { href: "/", match: ["/"], label: "Hoy", icon: "home", fixed: true },
  { href: "/pipelines", match: ["/pipelines"], label: "Deals (tablero)", icon: "deals" },
  { href: "/deals", match: ["/deals"], label: "Mis deals", icon: "list" },
  { href: "/inbox", match: ["/inbox"], label: "Bandeja de la IA", icon: "inbox" },
  { href: "/agents", match: ["/agents"], label: "Agentes", icon: "spark" },
  { href: "/sequences", match: ["/sequences"], label: "Secuencias", icon: "send" },
  { href: "/emails", match: ["/emails"], label: "Correos enviados", icon: "mail" },
  { href: "/firmas", match: ["/firmas"], label: "Firmas de contratos", icon: "sign" },
  { href: "/leads", match: ["/leads"], label: "Leads", icon: "leads" },
  { href: "/campaigns", match: ["/campaigns"], label: "Campañas de outbound", icon: "target" },
  { href: "/activities", match: ["/activities"], label: "Actividades", icon: "activities" },
  { href: "/accounts", match: ["/accounts"], label: "Clientes (Customer Success)", icon: "users" },
  { href: "/organizations", match: ["/organizations"], label: "Empresas", icon: "organizations" },
  { href: "/persons", match: ["/persons"], label: "Contactos", icon: "persons" },
  { href: "/reports", match: ["/reports", "/dashboards"], label: "Informes y dashboards", icon: "dashboards" },
  { href: "/settings", match: ["/settings"], label: "Ajustes", icon: "settings", fixed: true },
];

export type NavPrefs = { order?: string[]; hidden?: string[] };

/** Las secciones en el orden de la persona (las nuevas, al final), separando las visibles de las ocultas. */
export function arrangeNav(prefs: NavPrefs | null | undefined) {
  const order = prefs?.order ?? [];
  const hidden = new Set(prefs?.hidden ?? []);
  const movable = NAV_ITEMS.filter((i) => !i.fixed);
  const sorted = [
    ...order.map((h) => movable.find((i) => i.href === h)).filter((i): i is (typeof NAV_ITEMS)[number] => Boolean(i)),
    ...movable.filter((i) => !order.includes(i.href)),
  ];
  return {
    all: sorted,
    visible: [NAV_ITEMS[0], ...sorted.filter((i) => !hidden.has(i.href)), NAV_ITEMS[NAV_ITEMS.length - 1]],
    hidden: sorted.filter((i) => hidden.has(i.href)),
  };
}
