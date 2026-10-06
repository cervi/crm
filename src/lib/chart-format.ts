// Formato de valores de los widgets (sin dependencias de servidor: lo usan los gráficos del navegador).
export type Format = "number" | "money" | "percent" | "days";

/**
 * Formato compacto propio («12,9 mil», «1,2 M»): el de Intl varía entre el
 * servidor y el navegador (espacios distintos) y rompería la hidratación.
 */
function compactNumber(v: number): string {
  const abs = Math.abs(v);
  const fmt = (n: number) => n.toFixed(1).replace(/\.0$/, "").replace(".", ",");
  if (abs >= 1e6) return `${fmt(v / 1e6)} M`;
  if (abs >= 1e4) return `${fmt(v / 1e3)} mil`;
  return group(Math.round(v));
}

/** Miles con punto, sin depender de los datos de idioma del entorno. */
function group(n: number, decimals = 0): string {
  const [int, dec] = Math.abs(n).toFixed(decimals).split(".");
  const withDots = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${n < 0 ? "-" : ""}${withDots}${dec ? `,${dec}` : ""}`;
}

export function formatValue(v: number | null | undefined, format: Format, compact = false): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  switch (format) {
    case "money":
      return `${compact ? compactNumber(v) : group(Math.round(v))} €`;
    case "percent": {
      const pct = v * 100;
      return `${group(pct, pct !== 0 && Math.abs(pct) < 10 && pct % 1 !== 0 ? 1 : 0)} %`;
    }
    case "days":
      return `${group(v, v < 10 && v % 1 !== 0 ? 1 : 0)} días`;
    default:
      return compact ? compactNumber(v) : group(v, v % 1 === 0 ? 0 : 1);
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
