// Columnas de la lista de deals (sin dependencias: lo usan servidor y cliente).

export const DEAL_COLUMNS = {
  organization: "Empresa",
  stage: "Fase",
  value: "Importe",
  days: "Días en la fase",
  next_activity: "Próxima actividad",
  close: "Cierre previsto",
  owner: "Responsable",
  status: "Estado",
  created: "Creado",
  source: "Origen",
} as const;
export type DealColumn = keyof typeof DEAL_COLUMNS;

export const DEFAULT_DEAL_COLUMNS: DealColumn[] = ["organization", "stage", "value", "days", "next_activity", "close", "owner", "status"];

/** «cols=organization,value,cf:competidor» → columnas válidas en orden canónico (las personalizadas al final). */
export function parseDealColumns(param: string | null | undefined, customKeys: string[]): string[] {
  if (!param) return DEFAULT_DEAL_COLUMNS;
  const wanted = new Set(param.split(",").map((c) => c.trim()).filter(Boolean));
  const base = (Object.keys(DEAL_COLUMNS) as DealColumn[]).filter((c) => wanted.has(c));
  const custom = customKeys.filter((k) => wanted.has(`cf:${k}`)).map((k) => `cf:${k}`);
  const cols = [...base, ...custom];
  return cols.length ? cols : DEFAULT_DEAL_COLUMNS;
}
