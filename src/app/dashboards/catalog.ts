import { CATALOG, CHARTS, PERIODS, customGroupOptions } from "@/lib/analytics";
import { listPipelines } from "@/lib/pipelines";
import { listUsers } from "@/lib/users";
import type { Catalog } from "@/components/charts/WidgetBuilder";

/** Opciones del editor de widgets, en un formato que se puede enviar al navegador. */
export async function builderOptions() {
  const [custom, pipelines, users] = await Promise.all([customGroupOptions(), listPipelines(), listUsers()]);
  const catalog = Object.fromEntries((Object.keys(CATALOG) as (keyof typeof CATALOG)[]).map((k) => {
    const s = CATALOG[k];
    return [k, {
      label: s.label,
      metrics: Object.entries(s.metrics).map(([value, m]) => ({ value, label: m.label })),
      groups: [
        ...Object.entries(s.groups).map(([value, g]) => ({ value, label: g.label, time: Boolean(g.time) })),
        ...custom[k],
      ],
      dates: Object.entries(s.dates).map(([value, label]) => ({ value, label })),
    }];
  })) as Catalog;
  return {
    catalog,
    periods: Object.entries(PERIODS).map(([value, label]) => ({ value, label })),
    charts: Object.entries(CHARTS).map(([value, label]) => ({ value, label })),
    pipelines: pipelines.map((p) => ({ value: p.id, label: p.name })),
    users: users.filter((u) => u.kind === "human").map((u) => ({ value: u.id, label: u.name })),
  };
}
