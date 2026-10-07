// ===========================================================================
// Variables de los correos (al estilo de Apollo), sin dependencias: se usa
// igual en el servidor (al enviar) y en el navegador (vista previa).
//
//   {{nombre}}                      el valor tal cual
//   {{nombre|equipo}}               con valor por defecto si está vacío
//   {{empresa->mayusculas}}         con formato (minusculas, mayusculas,
//                                   capitalizar, primera_palabra)
//   {{hoy_dia_semana->mas_2}}       fechas: N días laborables después/antes
//   {{#if cargo}}…{{#else}}…{{#endif}}
//   {{#if empresa_empleados > 50}}…{{#endif}}   (== != < <= > >= contiene)
//   {contacto.clave}                campos personalizados (contacto, empresa, deal)
//
// También acepta los nombres de Apollo ({{first_name}}, {{company}},
// {{now_weekday}}…) y las variables antiguas de una llave ({nombre}).
// ===========================================================================

export type MergeVars = Record<string, string | number | null | undefined>;
export type MergeOptions = { html?: boolean; now?: Date; tz?: string };
export type MergeResult = { text: string; missing: string[]; unknown: string[]; errors: string[] };

export type VariableDef = { key: string; label: string; group: string; example: string };

export const VARIABLES: VariableDef[] = [
  { key: "nombre", label: "Nombre", group: "Contacto", example: "Laura" },
  { key: "apellidos", label: "Apellidos", group: "Contacto", example: "Martín" },
  { key: "nombre_completo", label: "Nombre completo", group: "Contacto", example: "Laura Martín" },
  { key: "email", label: "Email", group: "Contacto", example: "laura@acme.es" },
  { key: "cargo", label: "Cargo", group: "Contacto", example: "Directora comercial" },
  { key: "telefono", label: "Teléfono", group: "Contacto", example: "+34 600 000 000" },
  { key: "linkedin", label: "LinkedIn", group: "Contacto", example: "https://linkedin.com/in/laura" },
  { key: "empresa", label: "Empresa", group: "Empresa", example: "Acme" },
  { key: "empresa_web", label: "Web", group: "Empresa", example: "https://acme.es" },
  { key: "empresa_dominio", label: "Dominio", group: "Empresa", example: "acme.es" },
  { key: "empresa_sector", label: "Sector", group: "Empresa", example: "Logística" },
  { key: "empresa_empleados", label: "Empleados", group: "Empresa", example: "120" },
  { key: "empresa_ciudad", label: "Ciudad", group: "Empresa", example: "Madrid" },
  { key: "empresa_pais", label: "País", group: "Empresa", example: "España" },
  { key: "deal", label: "Título del deal", group: "Deal", example: "Acme — licencias 2027" },
  { key: "deal_valor", label: "Importe", group: "Deal", example: "12.000 €" },
  { key: "deal_fase", label: "Fase", group: "Deal", example: "Propuesta" },
  { key: "remitente", label: "Tu nombre completo", group: "Remitente", example: "Jesús Cerviño" },
  { key: "remitente_nombre", label: "Tu nombre", group: "Remitente", example: "Jesús" },
  { key: "remitente_email", label: "Tu email", group: "Remitente", example: "jesus@aikit.io" },
  { key: "responsable", label: "Responsable del deal", group: "Remitente", example: "Jesús Cerviño" },
  { key: "saludo", label: "Saludo según la hora", group: "Fecha", example: "Buenos días" },
  { key: "hoy_dia_semana", label: "Día de la semana", group: "Fecha", example: "miércoles" },
  { key: "hoy_dia", label: "Día del mes", group: "Fecha", example: "7" },
  { key: "hoy_mes", label: "Mes", group: "Fecha", example: "octubre" },
  { key: "hoy_anio", label: "Año", group: "Fecha", example: "2026" },
  { key: "hoy_momento", label: "Momento del día", group: "Fecha", example: "mañana" },
  { key: "huecos", label: "Huecos libres de tu agenda", group: "Especiales", example: "· jueves 8, 10:00\n· viernes 9, 16:30" },
  { key: "enlace_reserva", label: "Enlace para reservar reunión", group: "Especiales", example: "https://crm.aikit.io/b/abc" },
  { key: "gancho", label: "Primera línea personalizada (campañas)", group: "Especiales", example: "He visto que estáis abriendo oficina en Valencia." },
  { key: "enlace_baja", label: "Enlace de baja", group: "Especiales", example: "https://crm.aikit.io/u/abc" },
];

export const DATE_KEYS = new Set(["saludo", "hoy_dia_semana", "hoy_dia", "hoy_mes", "hoy_anio", "hoy_momento"]);
const KNOWN = new Set(VARIABLES.map((v) => v.key));
/** Campos personalizados: {{contacto.clave}}, {{empresa.clave}}, {{deal.clave}}. */
const CUSTOM_RE = /^(contacto|empresa|deal)\.[a-z0-9_]+$/;

/** Nombres de Apollo (y en inglés) → los nuestros. */
export const ALIASES: Record<string, string> = {
  first_name: "nombre", last_name: "apellidos", name: "nombre_completo", full_name: "nombre_completo", email: "email",
  title: "cargo", phone: "telefono", linkedin_url: "linkedin",
  company: "empresa", company_name: "empresa", account_name: "empresa", account: "empresa", website: "empresa_web",
  domain: "empresa_dominio", industry: "empresa_sector", employees: "empresa_empleados", num_employees: "empresa_empleados",
  city: "empresa_ciudad", country: "empresa_pais",
  sender_name: "remitente", sender_first_name: "remitente_nombre", sender_email: "remitente_email",
  now_weekday: "hoy_dia_semana", now_day: "hoy_dia", now_month: "hoy_mes", now_year: "hoy_anio", now_time_of_day: "hoy_momento",
  greeting: "saludo", contacto: "nombre", primer_nombre: "nombre", deal_title: "deal",
};

const canon = (k: string) => {
  const key = k.trim().toLowerCase();
  return ALIASES[key] ?? key;
};

const isKnown = (k: string) => KNOWN.has(k) || CUSTOM_RE.test(k);

/** Valores de ejemplo (para la vista previa sin contacto). */
export function sampleVars(): MergeVars {
  return Object.fromEntries(VARIABLES.filter((v) => !DATE_KEYS.has(v.key)).map((v) => [v.key, v.example]));
}

// ---------------------------------------------------------------------------
// Fechas

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function localParts(d: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  const wd = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[p.weekday as string] ?? 1;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), wd };
}

/** Suma (o resta) días laborables, como Apollo: los fines de semana no cuentan. */
function shiftBusinessDays(now: Date, n: number, tz: string): Date {
  let d = new Date(now.getTime());
  const step = n >= 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    d = new Date(d.getTime() + step * 86400000);
    const wd = localParts(d, tz).wd;
    if (wd !== 0 && wd !== 6) left--;
  }
  return d;
}

function dateValue(key: string, now: Date, tz: string, offset: number): string {
  const p = localParts(offset ? shiftBusinessDays(now, offset, tz) : now, tz);
  switch (key) {
    case "hoy_dia_semana": return WEEKDAYS[p.wd];
    case "hoy_dia": return String(p.d);
    case "hoy_mes": return MONTHS[p.m - 1];
    case "hoy_anio": return String(p.y);
    case "hoy_momento": return p.h < 14 ? "mañana" : p.h < 21 ? "tarde" : "noche";
    case "saludo": return p.h >= 6 && p.h < 14 ? "Buenos días" : p.h >= 6 && p.h < 21 ? "Buenas tardes" : "Buenas noches";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Formatos

const capitalizeWords = (s: string) => s.toLocaleLowerCase("es").replace(/(^|[\s\-'’])(\p{L})/gu, (_, a: string, b: string) => a + b.toLocaleUpperCase("es"));

export const OPERATORS: { key: string; label: string; aliases: string[] }[] = [
  { key: "minusculas", label: "en minúsculas", aliases: ["lowercase", "lower"] },
  { key: "mayusculas", label: "EN MAYÚSCULAS", aliases: ["uppercase", "upper"] },
  { key: "capitalizar", label: "Cada Palabra Con Mayúscula", aliases: ["capitalize_each_word", "capitalize", "titlecase"] },
  { key: "primera_palabra", label: "solo la primera palabra", aliases: ["first_word"] },
];

function applyOp(value: string, op: string): string {
  const o = op.trim().toLowerCase();
  if (o === "minusculas" || o === "lowercase" || o === "lower") return value.toLocaleLowerCase("es");
  if (o === "mayusculas" || o === "uppercase" || o === "upper") return value.toLocaleUpperCase("es");
  if (o === "capitalizar" || o === "capitalize_each_word" || o === "capitalize" || o === "titlecase") return capitalizeWords(value);
  if (o === "primera_palabra" || o === "first_word") return value.trim().split(/\s+/)[0] ?? "";
  return value;
}

/** Desplazamiento de fecha de los formatos (->mas_2, ->plus_2, ->menos_1, ->minus_1). */
function dateOffset(ops: string[]): number {
  let n = 0;
  for (const op of ops) {
    const m = /^(mas|más|plus|menos|minus)_(\d{1,3})$/.exec(op.trim().toLowerCase());
    if (m) n += (m[1] === "menos" || m[1] === "minus" ? -1 : 1) * Number(m[2]);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Análisis

type Node =
  | { t: "text"; v: string }
  | { t: "var"; key: string; ops: string[]; fallback: string | null; raw: string }
  | { t: "if"; cond: string; yes: Node[]; no: Node[] };

const TAG_RE = /\{\{\s*([^{}]*?)\s*\}\}/g;

const decodeEntities = (s: string) =>
  s.replace(/&nbsp;|&#160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/ /g, " ");

const unquote = (s: string) => {
  const t = s.trim();
  return /^(["'“”‘’]).*\1$/.test(t) || /^[“‘].*[”’]$/.test(t) ? t.slice(1, -1) : t;
};

/** Variables antiguas de una llave ({nombre}) → {{nombre}} (solo si existen). */
function upgradeLegacy(src: string): string {
  return src.replace(/(^|[^{])\{([a-z_][\w.]*)\}(?!\})/gi, (m, pre: string, k: string) =>
    isKnown(canon(k)) ? `${pre}{{${k}}}` : m);
}

function parse(src: string): { nodes: Node[]; errors: string[] } {
  const errors: string[] = [];
  const root: Node[] = [];
  const stack: { node: Extract<Node, { t: "if" }>; inElse: boolean }[] = [];
  const target = () => {
    const top = stack[stack.length - 1];
    return top ? (top.inElse ? top.node.no : top.node.yes) : root;
  };
  let last = 0;
  for (const m of src.matchAll(TAG_RE)) {
    const at = m.index ?? 0;
    if (at > last) target().push({ t: "text", v: src.slice(last, at) });
    last = at + m[0].length;
    const inner = decodeEntities(m[1]).trim();
    const lower = inner.toLowerCase();
    if (/^#\s*if\b/.test(lower) || /^#\s*si\b/.test(lower)) {
      const node: Extract<Node, { t: "if" }> = { t: "if", cond: inner.replace(/^#\s*(if|si)\b/i, "").trim(), yes: [], no: [] };
      if (!node.cond) errors.push("Un {{#if}} sin condición.");
      target().push(node);
      stack.push({ node, inElse: false });
    } else if (/^(#|\/)?\s*(else|si_no|sino)$/.test(lower)) {
      const top = stack[stack.length - 1];
      if (!top) errors.push("Hay un {{#else}} sin su {{#if}}.");
      else if (top.inElse) errors.push("Hay dos {{#else}} en la misma condición.");
      else top.inElse = true;
    } else if (/^(#\s*endif|\/\s*if|#\s*fin_si|\/\s*si)$/.test(lower)) {
      if (!stack.pop()) errors.push("Hay un {{#endif}} sin su {{#if}}.");
    } else if (!inner) {
      target().push({ t: "text", v: m[0] });
    } else {
      const bar = inner.indexOf("|");
      const left = bar >= 0 ? inner.slice(0, bar) : inner;
      const fallback = bar >= 0 ? unquote(inner.slice(bar + 1)) : null;
      const [name, ...ops] = left.split("->").map((s) => s.trim());
      target().push({ t: "var", key: canon(name), ops, fallback, raw: m[0] });
    }
  }
  if (last < src.length) target().push({ t: "text", v: src.slice(last) });
  if (stack.length) errors.push(`Falta cerrar ${stack.length === 1 ? "un {{#if}}" : `${stack.length} {{#if}}`} con {{#endif}}.`);
  return { nodes: root, errors };
}

// ---------------------------------------------------------------------------
// Evaluación

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r?\n/g, "<br>");

const num = (s: string) => {
  const t = s.replace(/[€$%\s]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", ".");
  return t !== "" && Number.isFinite(Number(t)) ? Number(t) : null;
};

export function mergeTemplate(src: string, vars: MergeVars, opts: MergeOptions = {}): MergeResult {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? (typeof process !== "undefined" ? process.env?.TZ : undefined) ?? "Europe/Madrid";
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const { nodes, errors } = parse(upgradeLegacy(src ?? ""));
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (v !== null && v !== undefined) norm[canon(k)] = String(v);

  const lookup = (key: string, ops: string[] = []): string => {
    if (DATE_KEYS.has(key)) return dateValue(key, now, tz, dateOffset(ops));
    return (norm[key] ?? "").trim();
  };

  const test = (cond: string): boolean => {
    const m = /^(!|not\s+|no\s+)?\s*([\w.]+)\s*(?:(==|!=|<=|>=|<|>|=|contiene|contains)\s*(.+))?$/i.exec(cond.trim());
    if (!m) { errors.push(`No entiendo la condición «${cond}».`); return false; }
    const key = canon(m[2]);
    if (!isKnown(key) && !(key in norm)) unknown.add(key);
    const value = lookup(key);
    let result: boolean;
    if (!m[3]) result = value !== "" && value !== "0" && value.toLowerCase() !== "false" && value.toLowerCase() !== "no";
    else {
      const op = m[3].toLowerCase();
      const other = unquote(m[4]);
      const a = num(value), b = num(other);
      const cmp = a !== null && b !== null ? a - b : value.localeCompare(other, "es", { sensitivity: "base" });
      result = op === "==" || op === "=" ? cmp === 0
        : op === "!=" ? cmp !== 0
        : op === "<" ? cmp < 0 : op === "<=" ? cmp <= 0 : op === ">" ? cmp > 0 : op === ">=" ? cmp >= 0
        : value.toLocaleLowerCase("es").includes(other.toLocaleLowerCase("es"));
    }
    return m[1] ? !result : result;
  };

  const render = (list: Node[]): string => list.map((n) => {
    if (n.t === "text") return n.v;
    if (n.t === "if") return render(test(n.cond) ? n.yes : n.no);
    if (!isKnown(n.key) && !(n.key in norm)) {
      unknown.add(n.key);
      if (n.fallback !== null) return opts.html ? escapeHtml(n.fallback) : n.fallback;
      return n.raw;
    }
    let v = lookup(n.key, n.ops);
    if (!v) {
      if (n.fallback === null) { missing.add(n.key); return ""; }
      v = n.fallback;
    }
    for (const op of n.ops) v = applyOp(v, op);
    return opts.html ? escapeHtml(v) : v;
  }).join("");

  const text = render(nodes);
  return { text, missing: [...missing], unknown: [...unknown], errors: [...new Set(errors)] };
}

/** Variables que usa una plantilla (para medir la personalización). */
export function usedVariables(src: string): string[] {
  const out = new Set<string>();
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (n.t === "var") out.add(n.key);
      else if (n.t === "if") {
        const m = /([\w.]+)/.exec(n.cond.replace(/^(!|not\s+|no\s+)/i, ""));
        if (m) out.add(canon(m[1]));
        walk(n.yes); walk(n.no);
      }
    }
  };
  walk(parse(upgradeLegacy(src ?? "")).nodes);
  return [...out];
}

/** ¿Usa esta plantilla alguna de estas variables? (p. ej. «huecos», que hay que calcular). */
export const usesVariable = (src: string, key: string) => usedVariables(src).includes(key);
