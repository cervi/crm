// Formato de valores de los widgets (sin dependencias de servidor: lo usan los gráficos del navegador).
export type Format = "number" | "money" | "percent" | "days";

export function formatValue(v: number | null | undefined, format: Format, compact = false): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  switch (format) {
    case "money":
      return new Intl.NumberFormat("es-ES", {
        style: "currency", currency: "EUR", maximumFractionDigits: compact && Math.abs(v) >= 1000 ? 1 : 0,
        notation: compact && Math.abs(v) >= 10000 ? "compact" : "standard", useGrouping: "always",
      }).format(v);
    case "percent":
      return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: v < 0.1 ? 1 : 0 }).format(v * 100)} %`;
    case "days":
      return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: v < 10 ? 1 : 0 }).format(v)} días`;
    default:
      return new Intl.NumberFormat("es-ES", {
        maximumFractionDigits: v % 1 === 0 ? 0 : 1, notation: compact && Math.abs(v) >= 10000 ? "compact" : "standard",
        useGrouping: "always",
      }).format(v);
  }
}

/** Marcas "redondas" para el eje: 0 y 3–5 pasos limpios hasta cubrir el máximo. */
export function niceTicks(max: number, format: Format): number[] {
  if (format === "percent") {
    const top = max > 0.5 ? 1 : max > 0.25 ? 0.5 : max > 0.1 ? 0.25 : 0.1;
    return [0, top / 2, top];
  }
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const ticks: number[] = [];
  for (let t = 0; t < max + step * 0.999; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks.length > 1 ? ticks : [0, step];
}
