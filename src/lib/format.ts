export function money(value: string | number | null | undefined, currency = "EUR") {
  if (value === null || value === undefined || value === "") return "—";
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 0 })
    .format(Number(value));
}

export function date(value: Date | string | null | undefined) {
  if (!value) return "—";
  const d = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
}

export function dateTime(value: Date | string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-ES", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** Valor para un <input type="datetime-local">. */
export function toDateTimeLocal(value: Date | string | null | undefined) {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const ACTIVITY_TYPES = [
  { value: "call", label: "Llamada" },
  { value: "meeting", label: "Reunión" },
  { value: "video_call", label: "Videollamada" },
  { value: "demo", label: "Demo" },
  { value: "email", label: "Email" },
  { value: "task", label: "Tarea" },
  { value: "deadline", label: "Fecha límite" },
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number]["value"];
export const activityLabel = (t: string | null) => ACTIVITY_TYPES.find((a) => a.value === t)?.label ?? t ?? "—";

export const OUTCOMES = [
  { value: "held", label: "Realizada" },
  { value: "no_show", label: "No se presentó" },
  { value: "rescheduled", label: "Reprogramada" },
  { value: "cancelled", label: "Cancelada" },
] as const;
export const outcomeLabel = (o: string | null) => OUTCOMES.find((x) => x.value === o)?.label ?? "";

export const FUNNEL_STAGES = [
  { value: "tofu", label: "TOFU" },
  { value: "mofu", label: "MOFU" },
  { value: "bofu", label: "BOFU" },
] as const;

export const STATUS_LABELS: Record<string, string> = {
  open: "Abierto", won: "Ganado", lost: "Perdido", converted: "Convertido", archived: "Archivado",
};
