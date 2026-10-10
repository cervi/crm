import { sql } from "./db";

// ===========================================================================
// «Temperatura» de un contacto según cómo responde a tus correos: si abrió el
// último, cuántas veces, si hizo clic, si respondió. Se enseña al escribir un
// correo y se pasa a la IA para que adapte el mensaje.
// ===========================================================================

export type Temperature = "caliente" | "templado" | "frio" | "sin_datos";
export type Engagement = {
  personId: string;
  temperature: Temperature;
  /** Una frase con el estado: «Abrió tu último correo 3 veces, la última hace 2 h». */
  headline: string;
  /** Qué conviene hacer ahora. */
  advice: string;
  last: { subject: string; sent_at: Date; tracked: boolean; opens: number; last_opened_at: Date | null; clicks: number; replied_at: Date | null } | null;
  sent30: number; opened30: number; replies30: number; lastInboundAt: Date | null; unansweredInRow: number;
};

const ago = (d: Date) => {
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 60) return `hace ${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const dd = Math.round(h / 24);
  return dd === 1 ? "ayer" : `hace ${dd} días`;
};

export async function contactEngagement(personIds: string[]): Promise<Map<string, Engagement>> {
  const out = new Map<string, Engagement>();
  if (personIds.length === 0) return out;
  const rows = await sql<{ person_id: string; subject: string; sent_at: Date; track: boolean; open_count: number; last_opened_at: Date | null; click_count: number; replied_at: Date | null }[]>`
    SELECT e.person_id, e.subject, e.sent_at, e.track, e.open_count, e.last_opened_at, e.click_count,
           (SELECT min(r.sent_at) FROM emails r WHERE r.direction = 'in' AND r.sent_at > e.sent_at AND r.person_id = e.person_id) AS replied_at
    FROM emails e
    WHERE e.direction = 'out' AND e.status = 'sent' AND e.person_id = ANY(${personIds}::uuid[]) AND e.sent_at > now() - interval '120 days'
    ORDER BY e.sent_at DESC`;
  const inbound = await sql<{ person_id: string; at: Date }[]>`
    SELECT person_id, max(sent_at) AS at FROM emails WHERE direction = 'in' AND person_id = ANY(${personIds}::uuid[]) GROUP BY person_id`;
  for (const id of personIds) {
    const mine = rows.filter((r) => r.person_id === id);
    const lastIn = inbound.find((r) => r.person_id === id)?.at ?? null;
    const last = mine[0] ?? null;
    const recent = mine.filter((r) => Date.now() - new Date(r.sent_at).getTime() < 30 * 86400000);
    let unanswered = 0;
    for (const r of mine) { if (r.replied_at) break; unanswered++; }
    const e: Engagement = {
      personId: id, temperature: "sin_datos", headline: "", advice: "",
      last: last && { subject: last.subject, sent_at: last.sent_at, tracked: last.track, opens: last.open_count, last_opened_at: last.last_opened_at, clicks: last.click_count, replied_at: last.replied_at },
      sent30: recent.length, opened30: recent.filter((r) => r.open_count > 0).length, replies30: recent.filter((r) => r.replied_at).length,
      lastInboundAt: lastIn, unansweredInRow: unanswered,
    };
    const repliedRecently = lastIn && Date.now() - new Date(lastIn).getTime() < 14 * 86400000;
    if (!last && !lastIn) {
      e.headline = "Todavía no le has escrito desde el CRM.";
      e.advice = "Primer contacto: breve, personal y con una sola pregunta.";
    } else if (last?.replied_at || repliedRecently) {
      e.temperature = "caliente";
      e.headline = `Te respondió ${ago(last?.replied_at ?? lastIn!)}.`;
      e.advice = "Está en conversación: responde pronto y propón el siguiente paso concreto.";
    } else if (last && !last.track) {
      e.temperature = "sin_datos";
      e.headline = `Tu último correo («${last.subject}», ${ago(last.sent_at)}) se envió sin seguimiento: no sabemos si lo abrió.`;
      e.advice = unanswered >= 2 ? `Lleva ${unanswered} correos sin responder: prueba una llamada.` : "Sin respuesta todavía.";
    } else if (last && (last.open_count >= 2 || last.click_count > 0)) {
      e.temperature = "caliente";
      e.headline = `Abrió tu último correo («${last.subject}») ${last.open_count} ${last.open_count === 1 ? "vez" : "veces"}${last.last_opened_at ? `, la última ${ago(last.last_opened_at)}` : ""}${last.click_count ? ` e hizo clic ${last.click_count} ${last.click_count === 1 ? "vez" : "veces"}` : ""}, pero no ha respondido.`;
      e.advice = "Hay interés: buen momento para llamar o para un correo corto que retome lo que abrió.";
    } else if (last && last.open_count === 1) {
      e.temperature = "templado";
      e.headline = `Abrió tu último correo («${last.subject}») una vez${last.last_opened_at ? `, ${ago(last.last_opened_at)}` : ""}, sin responder.`;
      e.advice = "Lo ha visto: un seguimiento breve con una pregunta fácil de contestar.";
    } else if (last) {
      e.temperature = unanswered >= 2 ? "frio" : "templado";
      e.headline = unanswered >= 2
        ? `No ha abierto tus ${unanswered} últimos correos (el último, ${ago(last.sent_at)}).`
        : `No ha abierto tu último correo («${last.subject}», ${ago(last.sent_at)}).`;
      e.advice = unanswered >= 2 ? "Cambia de canal (llamada o LinkedIn) o prueba un asunto muy distinto." : "Puede que no lo haya visto: prueba otro asunto o espera un par de días.";
    }
    out.set(id, e);
  }
  return out;
}

export const TEMPERATURE_LABEL: Record<Temperature, string> = { caliente: "Caliente", templado: "Templado", frio: "Frío", sin_datos: "Sin datos" };

/** Lo mismo, en el formato que se pasa a la IA. */
export function engagementFacts(e: Engagement | undefined | null) {
  if (!e) return null;
  return {
    temperatura: TEMPERATURE_LABEL[e.temperature], resumen: e.headline,
    ultimo_correo: e.last && { asunto: e.last.subject, enviado: e.last.sent_at, con_seguimiento: e.last.tracked, aperturas: e.last.opens, clics: e.last.clicks, respondido: Boolean(e.last.replied_at) },
    correos_sin_respuesta_seguidos: e.unansweredInRow, correos_30_dias: e.sent30, abiertos_30_dias: e.opened30, respuestas_30_dias: e.replies30,
    pista: "Si abrió varias veces sin responder, retoma lo que vio; si no abre, cambia el ángulo y el asunto; si respondió, contesta a lo que dijo.",
  };
}
