// ===========================================================================
// Revisión de un correo mientras se escribe (como el «email score» de Apollo):
// longitud del asunto y del texto, enlaces, imágenes, palabras de spam,
// personalización, llamada a la acción, mayúsculas y exclamaciones, y que
// las variables estén bien escritas. Sin dependencias: corre en el navegador.
// ===========================================================================

import { htmlToText } from "./email-html";
import { mergeTemplate, usedVariables, VARIABLES } from "./merge";

export type CheckLevel = "ok" | "warn" | "error";
export type CheckItem = { level: CheckLevel; text: string };
export type EmailCheck = { score: number; items: CheckItem[]; words: number; links: number; readSeconds: number };

const SPAM = [
  "gratis", "100%", "garantizado", "garantía total", "sin coste", "sin compromiso", "oferta exclusiva", "oferta limitada",
  "urgente", "actúa ya", "actua ya", "compra ahora", "haz clic aquí", "haz click aquí", "pincha aquí", "gana dinero", "dinero fácil",
  "promoción", "descuento exclusivo", "última oportunidad", "ultima oportunidad", "sin riesgo", "felicidades", "has sido seleccionado",
  "free", "click here", "buy now", "act now", "limited time", "guaranteed", "risk-free", "winner", "$$$", "€€€",
];

const PERSONAL = new Set(["nombre", "nombre_completo", "empresa", "cargo", "gancho", "empresa_sector", "empresa_ciudad", "deal"]);
const KNOWN = new Set(VARIABLES.map((v) => v.key));

export function checkEmail(input: { subject: string; body: string; html: boolean; threadReply?: boolean; firstStep?: boolean }): EmailCheck {
  const items: CheckItem[] = [];
  const add = (level: CheckLevel, text: string) => items.push({ level, text });
  const subject = (input.subject ?? "").trim();
  const text = input.html ? htmlToText(input.body ?? "") : (input.body ?? "");
  // El texto tal y como se leería (las variables con su ejemplo), para contar palabras.
  const sample = mergeTemplate(text, Object.fromEntries(VARIABLES.map((v) => [v.key, v.example]))).text;
  const words = sample.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
  const links = input.html ? (input.body.match(/<a\b[^>]*href=/gi) ?? []).length : (text.match(/https?:\/\//g) ?? []).length;
  const images = input.html ? (input.body.match(/<img\b/gi) ?? []).length : 0;
  let score = 100;

  // Variables
  const bodyCheck = mergeTemplate(input.body ?? "", {});
  const subjCheck = mergeTemplate(subject, {});
  const errors = [...new Set([...bodyCheck.errors, ...subjCheck.errors])];
  for (const e of errors) { add("error", e); score -= 20; }
  const unknown = [...new Set([...bodyCheck.unknown, ...subjCheck.unknown])].filter((k) => !/^(contacto|empresa|deal)\./.test(k));
  if (unknown.length) { add("error", `Variables que no existen: ${unknown.map((k) => `{{${k}}}`).join(", ")}.`); score -= 15; }

  // Asunto
  if (!subject && !input.threadReply) { add("error", "Falta el asunto."); score -= 25; }
  else if (subject) {
    const sw = subject.split(/\s+/).length;
    if (subject.length > 60 || sw > 9) { add("warn", `Asunto largo (${sw} palabras): mejor de 2 a 6, se lee entero en el móvil.`); score -= 8; }
    else add("ok", "Asunto corto.");
    if (/!/.test(subject)) { add("warn", "Quita las exclamaciones del asunto: suenan a publicidad."); score -= 6; }
    if (/\b[A-ZÁÉÍÓÚÑ]{4,}\b/.test(subject.replace(/\{\{[^}]*\}\}/g, ""))) { add("warn", "Evita palabras en mayúsculas en el asunto."); score -= 6; }
  }

  // Longitud
  if (words < 25) { add("warn", `Muy corto (${words} palabras): añade por qué le escribes y qué le propones.`); score -= 8; }
  else if (words > 200) { add("warn", `Largo (${words} palabras): los correos en frío de 50 a 125 palabras tienen más respuestas.`); score -= 12; }
  else if (words > 125) { add("warn", `Algo largo (${words} palabras): mejor de 50 a 125.`); score -= 5; }
  else add("ok", `Buena longitud (${words} palabras).`);

  // Frases largas
  const sentences = sample.split(/[.!?¿¡\n]+/).map((s) => s.trim()).filter(Boolean);
  const longOnes = sentences.filter((s) => s.split(/\s+/).length > 28).length;
  if (longOnes) { add("warn", `${longOnes === 1 ? "Hay una frase" : `Hay ${longOnes} frases`} de más de 28 palabras: pártelas.`); score -= 4; }

  // Enlaces e imágenes
  if (links > 3) { add("warn", `${links} enlaces: con más de 2 o 3, más riesgo de acabar en spam.`); score -= 10; }
  else if (input.firstStep && links > 1) { add("warn", "En el primer correo, mejor un solo enlace (o ninguno)."); score -= 4; }
  if (images) { add("warn", `${images === 1 ? "Lleva una imagen" : `Lleva ${images} imágenes`}: en correos en frío empeoran la entrega.`); score -= 6; }

  // Spam
  const lower = `${subject} ${sample}`.toLocaleLowerCase("es");
  const spam = SPAM.filter((w) => lower.includes(w));
  if (spam.length) { add("warn", `Palabras que activan filtros de spam: ${spam.slice(0, 5).map((w) => `«${w}»`).join(", ")}.`); score -= Math.min(20, spam.length * 6); }

  // Mayúsculas y exclamaciones
  const caps = (sample.match(/\b[A-ZÁÉÍÓÚÑ]{4,}\b/g) ?? []).length;
  if (caps > 2) { add("warn", "Demasiadas palabras en mayúsculas."); score -= 5; }
  const bangs = (sample.match(/!/g) ?? []).length;
  if (bangs > 2) { add("warn", `${bangs} exclamaciones: con una basta.`); score -= 5; }

  // Personalización
  const used = new Set([...usedVariables(input.body ?? ""), ...usedVariables(subject)]);
  const personal = [...used].filter((k) => PERSONAL.has(k) || /^(contacto|empresa|deal)\./.test(k));
  if (!personal.length) { add("warn", "Sin personalizar: usa al menos {{nombre}} o {{empresa}}."); score -= 10; }
  else add("ok", `Personalizado (${personal.slice(0, 3).map((k) => `{{${k}}}`).join(", ")}).`);
  if ([...used].some((k) => KNOWN.has(k) && !["nombre", "empresa", "remitente", "remitente_nombre", "responsable", "saludo"].includes(k)) && !/\|/.test(input.body)) {
    // Recordatorio suave: los datos que no siempre están pueden quedar vacíos.
    add("ok", "Consejo: pon un valor por defecto a los datos que pueden faltar, p. ej. {{cargo|tu equipo}}.");
  }

  // Llamada a la acción
  const tail = sample.trim().split(/\n+/).slice(-4).join(" ");
  if (!/\?/.test(tail) && !/\{\{\s*(huecos|enlace_reserva)/.test(input.body)) { add("warn", "Termina con una pregunta concreta o un enlace para reservar."); score -= 6; }
  else add("ok", "Tiene una llamada a la acción.");

  return { score: Math.max(0, Math.min(100, score)), items, words, links, readSeconds: Math.max(5, Math.round((words / 230) * 60)) };
}
