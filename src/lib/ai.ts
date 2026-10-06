import { sql, json } from "./db";
import { decrypt, encrypt, encryptionConfigured } from "./crypto";
import { UserError } from "./errors";

// ===========================================================================
// Modelo de IA configurable: proveedor, modelo, clave y prompts.
//
// Se usa para redactar resúmenes (deal, parte del día, tras una reunión,
// traspaso a Customer Success). Si no está configurado o falla, quien llama
// usa su versión basada en reglas: la IA mejora el texto, no es imprescindible.
// ===========================================================================

export type AiProvider = "none" | "anthropic" | "openai" | "xai" | "compatible";

export const AI_PROVIDERS: { value: AiProvider; label: string; baseUrl: string; kind: "anthropic" | "openai" | null; modelHint: string }[] = [
  { value: "none", label: "Sin IA (resúmenes con reglas)", baseUrl: "", kind: null, modelHint: "" },
  { value: "anthropic", label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", kind: "anthropic", modelHint: "p. ej. claude-sonnet-5-5" },
  { value: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", kind: "openai", modelHint: "el modelo de OpenAI que uséis" },
  { value: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", kind: "openai", modelHint: "el modelo de Grok que uséis" },
  { value: "compatible", label: "Otro compatible con la API de OpenAI", baseUrl: "", kind: "openai", modelHint: "nombre del modelo" },
];

export type AiTask = "deal_brief" | "meeting_recap" | "daily_digest" | "handoff" | "lead_chat" | "report_question";

export const AI_TASKS: { value: AiTask; label: string; help: string }[] = [
  { value: "deal_brief", label: "Resumen del deal", help: "Arriba de cada ficha: cómo va, riesgos y siguiente paso." },
  { value: "meeting_recap", label: "Resumen tras una reunión", help: "El correo de seguimiento al contacto después de una demo o llamada." },
  { value: "daily_digest", label: "Parte del día", help: "El enfoque del día que encabeza tu parte diario." },
  { value: "handoff", label: "Traspaso a Customer Success", help: "El resumen de un deal ganado para el equipo de CS." },
  { value: "report_question", label: "Preguntas sobre los datos", help: "Convierte una pregunta («¿cuánto ganamos por origen este trimestre?») en un informe." },
  { value: "lead_chat", label: "Chat de la web", help: "El asistente de los formularios web: responde, cualifica al visitante y recoge sus datos." },
];

const COMMON = "Escribes en español de España, con tono profesional y cercano, sin relleno. Usa solo los datos que se te dan; si falta algo, no lo inventes.";

export const DEFAULT_PROMPTS: Record<AiTask, string> = {
  deal_brief: `Eres el asistente comercial del CRM. ${COMMON}
Con los datos del deal, responde SOLO con un JSON: {"resumen": "2-3 frases sobre cómo va el deal y la última interacción", "siguiente_paso": "la acción concreta más útil ahora, en imperativo", "riesgos": ["riesgos concretos, máximo 3"]}`,
  meeting_recap: `Eres el asistente comercial del CRM. ${COMMON}
Con las notas o la transcripción de la reunión, responde SOLO con un JSON: {"resumen": "resumen para enviar al cliente, 3-6 frases o viñetas, sin datos internos", "proximos_pasos": ["próximos pasos acordados, máximo 4, en frases cortas"]}`,
  daily_digest: `Eres el asistente comercial del CRM. ${COMMON}
Con el parte del día, escribe un párrafo breve (máximo 5 frases) con las 3 prioridades del día y por qué, empezando por lo más urgente. Sin saludos ni despedidas.`,
  handoff: `Eres el asistente comercial del CRM. ${COMMON}
Redacta el resumen de traspaso a Customer Success de un deal ganado: cliente y contexto, qué compra, personas clave, cómo fue la venta, compromisos y riesgos a vigilar, y primeros pasos recomendados. Texto plano con apartados cortos.`,
  report_question: `Traduces preguntas sobre los datos del CRM a un informe del catálogo que se te da. No inventes métricas, agrupaciones ni filtros: usa solo las claves del catálogo.
Responde SOLO con un JSON: {"titulo": "título corto", "source": "deals | leads | activities", "metric": "clave", "group_by": "clave o none", "date_field": "clave", "period": "clave", "chart": "number | bar | line | table", "filters": {"pipeline_id"?: "", "owner_id"?: "", "status"?: "", "source"?: ""}}`,
  lead_chat: `Eres el asistente de la web de la empresa y hablas con un visitante. ${COMMON}
Con el contexto (qué vende la empresa y qué conviene preguntar), la conversación y los datos ya recogidos: responde con amabilidad y en pocas frases, resuelve dudas generales sin inventar precios ni condiciones, entiende qué necesita y pide, de forma natural y de uno en uno, su nombre, su email y su empresa. Nunca pidas contraseñas ni datos de pago.
Responde SOLO con un JSON: {"respuesta": "tu mensaje al visitante", "datos": {"nombre": "", "email": "", "empresa": "", "telefono": "", "necesidad": "resumen breve de lo que busca"}, "listo": true cuando tengas al menos email y necesidad}`,
};

export type AiSettings = {
  provider: AiProvider; base_url: string | null; model: string | null; has_key: boolean;
  prompts: Partial<Record<AiTask, string>>; last_error: string | null; last_ok_at: Date | null;
};

export async function getAiSettings(): Promise<AiSettings> {
  const [s] = await sql<{ provider: AiProvider; base_url: string | null; model: string | null; api_key: string | null;
                         prompts: Partial<Record<AiTask, string>>; last_error: string | null; last_ok_at: Date | null }[]>`
    SELECT provider, base_url, model, api_key, prompts, last_error, last_ok_at FROM ai_settings`;
  if (!s) return { provider: "none", base_url: null, model: null, has_key: false, prompts: {}, last_error: null, last_ok_at: null };
  const { api_key, ...rest } = s;
  return { ...rest, has_key: Boolean(api_key) };
}

export const aiReady = (s: AiSettings) => s.provider !== "none" && Boolean(s.model && s.has_key && (s.base_url || preset(s.provider).baseUrl));
const preset = (p: AiProvider) => AI_PROVIDERS.find((x) => x.value === p) ?? AI_PROVIDERS[0];

export async function saveAiSettings(data: Record<string, unknown>) {
  const provider = String(data.provider ?? "none") as AiProvider;
  if (!AI_PROVIDERS.some((p) => p.value === provider)) throw new UserError("Proveedor no válido.");
  const model = String(data.model ?? "").trim() || null;
  const baseUrl = String(data.base_url ?? "").trim().replace(/\/$/, "") || null;
  const key = String(data.api_key ?? "").trim();
  if (provider !== "none") {
    if (!model) throw new UserError("Indica el modelo.");
    if (provider === "compatible" && !baseUrl) throw new UserError("Indica la dirección de la API.");
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new UserError("La dirección de la API debe empezar por https://.");
    if (key && !encryptionConfigured()) throw new UserError("Falta TOKEN_ENCRYPTION_KEY para guardar la clave cifrada.");
  }
  const prompts: Partial<Record<AiTask, string>> = {};
  for (const t of AI_TASKS) {
    const v = String(data[`prompt_${t.value}`] ?? "").trim();
    if (v.length > 8000) throw new UserError(`El prompt «${t.label}» es demasiado largo.`);
    // Solo se guarda si difiere del de serie: así las mejoras del de serie llegan a quien no lo tocó.
    if (v && v !== DEFAULT_PROMPTS[t.value]) prompts[t.value] = v;
  }
  await sql`
    UPDATE ai_settings SET provider = ${provider}, model = ${model}, base_url = ${baseUrl}, prompts = ${json(prompts)},
           api_key = CASE WHEN ${data.clear_key === "on"} THEN NULL WHEN ${key} <> '' THEN ${key ? encrypt(key) : null} ELSE api_key END,
           last_error = NULL, updated_at = now()`;
  await sql`DELETE FROM deal_briefs`; // con otra configuración, los resúmenes se rehacen
}

export const promptFor = (s: AiSettings, task: AiTask) => s.prompts[task] ?? DEFAULT_PROMPTS[task];

/**
 * Pide un texto al modelo configurado. Devuelve null si no hay IA
 * configurada o si falla (el error queda en Ajustes).
 */
export async function generate(task: AiTask | "test", facts: unknown, opts: { maxTokens?: number } = {}): Promise<string | null> {
  const [row] = await sql<{ provider: AiProvider; base_url: string | null; model: string | null; api_key: string | null;
                           prompts: Partial<Record<AiTask, string>> }[]>`SELECT provider, base_url, model, api_key, prompts FROM ai_settings`;
  if (!row || row.provider === "none" || !row.model || !row.api_key) return null;
  const p = preset(row.provider);
  const base = (row.base_url || p.baseUrl).replace(/\/$/, "");
  const system = task === "test" ? "Responde solo «ok»." : (row.prompts[task] ?? DEFAULT_PROMPTS[task]);
  const user = JSON.stringify({ tarea: task, fecha: new Date().toISOString(), datos: facts });
  try {
    const key = decrypt(row.api_key);
    let text: string | undefined;
    if (p.kind === "anthropic") {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: row.model, max_tokens: opts.maxTokens ?? 1200, system, messages: [{ role: "user", content: user }] }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      text = (j.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("\n");
    } else {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(60_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: row.model, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      text = j.choices?.[0]?.message?.content;
    }
    if (!text?.trim()) throw new Error("El modelo no devolvió texto.");
    await sql`UPDATE ai_settings SET last_ok_at = now(), last_error = NULL`;
    return text.trim();
  } catch (err) {
    const message = err instanceof Error ? (err.name === "TimeoutError" ? "El modelo tardó demasiado en responder." : err.message) : String(err);
    await sql`UPDATE ai_settings SET last_error = ${message.slice(0, 500)}`;
    return null;
  }
}

/** Saca el primer objeto JSON de una respuesta (los modelos a veces lo rodean de texto o ```). */
export function parseJsonReply<T>(text: string | null): T | null {
  if (!text) return null;
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as T; } catch { return null; }
}

export async function testAi(): Promise<string> {
  const s = await getAiSettings();
  if (!aiReady(s)) throw new UserError("Configura el proveedor, el modelo y la clave primero.");
  const reply = await generate("test", { mensaje: "Prueba de conexión desde el CRM" }, { maxTokens: 20 });
  if (!reply) throw new UserError(`No ha funcionado: ${(await getAiSettings()).last_error ?? "sin respuesta"}`);
  return reply;
}
