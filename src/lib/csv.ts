// CSV que Excel abre bien a la primera: UTF-8 con BOM (tildes), separador
// configurable («;» para Excel en español, con coma decimal), fechas en hora
// local y protección contra fórmulas en celdas que empiezan por = + - @.

export type Separator = ";" | "," | "\t";
export type Cell = string | number | boolean | Date | null | undefined | string[];

const TZ = () => process.env.TZ || "Europe/Madrid";

function dateText(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export function cellText(v: Cell, sep: Separator): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.join(", ");
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : dateText(v);
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "";
    const s = String(v);
    return sep === ";" ? s.replace(".", ",") : s;
  }
  // Una celda que empieza por = + - @ podría ejecutarse como fórmula al abrirla.
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

function quote(s: string, sep: Separator) {
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: Cell[][], sep: Separator = ";"): string {
  const line = (cells: Cell[]) => cells.map((c) => quote(cellText(c, sep), sep)).join(sep);
  return `﻿${[headers.map((h) => quote(h, sep)).join(sep), ...rows.map(line)].join("\r\n")}\r\n`;
}

/** Importe de la base de datos (texto) a número. */
export const num = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? null : Number(v));
