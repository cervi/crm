// Iconos de trazo (24×24), dibujados a mano para no depender de una librería.
const PATHS = {
  deals: "M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z",
  dashboards: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  leads: "M3 5h18l-7 8v5l-4 2v-7z",
  organizations: "M4 21V5l8-2v18M12 9h8v12M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2M2 21h20",
  persons: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  activities: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4M9 15l2 2 4-4",
  settings: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  system: "M3 5h18v11H3zM8 20h8M12 16v4",
  plus: "M12 5v14M5 12h14",
  plug: "M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0zM12 18v3",
  x: "M6 6l12 12M18 6L6 18",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, title }: { name: IconName; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
         aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title && <title>{title}</title>}
      <path d={PATHS[name]} />
    </svg>
  );
}
