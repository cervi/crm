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

export type AiTask = "deal_brief" | "meeting_recap" | "daily_digest" | "handoff" | "lead_chat" | "report_question" | "proposal"
  | "meeting_prep" | "call_extraction" | "enrich_company" | "qualify_lead" | "icebreaker" | "classify_reply" | "write_email" | "compile_instruction" | "check_condition";

export const AI_TASKS: { value: AiTask; label: string; help: string }[] = [
  { value: "deal_brief", label: "Resumen del deal", help: "Arriba de cada ficha: cómo va, riesgos y siguiente paso." },
  { value: "meeting_recap", label: "Resumen tras una reunión", help: "El correo de seguimiento al contacto después de una demo o llamada." },
  { value: "daily_digest", label: "Parte del día", help: "El enfoque del día que encabeza tu parte diario." },
  { value: "handoff", label: "Traspaso a Customer Success", help: "El resumen de un deal ganado para el equipo de CS." },
  { value: "meeting_prep", label: "Preparación de reuniones", help: "La ficha que el agente deja antes de cada reunión: contexto, objetivo y preguntas." },
  { value: "call_extraction", label: "Extracción tras una reunión", help: "Necesidades, decisores, presupuesto, plazos, objeciones y próximos pasos a partir de la transcripción o las notas." },
  { value: "enrich_company", label: "Enriquecer empresas", help: "Sector, tamaño, país y a qué se dedica, a partir de la web de la empresa." },
  { value: "qualify_lead", label: "Cualificar leads", help: "Si un lead encaja con vuestro perfil de cliente ideal, y qué falta saber." },
  { value: "icebreaker", label: "Primera línea de las campañas", help: "La frase personalizada que abre cada correo de outbound." },
  { value: "write_email", label: "Redactar correos de las secuencias", help: "Escribe, mejora, acorta o cambia el tono de un correo en el editor de las secuencias, respetando las variables." },
  { value: "compile_instruction", label: "Entender instrucciones por fase", help: "Convierte lo que escribes en una fase del funnel («cuando entre aquí, escríbele para agendar…») en reglas: cuándo, si y qué hace." },
  { value: "check_condition", label: "Comprobar condiciones", help: "Decide si un deal cumple la condición de una instrucción («si ya han confirmado presupuesto…») con su historial, correos y notas." },
  { value: "classify_reply", label: "Clasificar respuestas", help: "Interesado, más adelante, no interesado, baja o fuera de la oficina." },
  { value: "proposal", label: "Propuestas", help: "El texto de las propuestas que se envían al cliente con los productos del deal." },
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
  meeting_prep: `Eres el asistente comercial del CRM y preparas al comercial para una reunión con un cliente. ${COMMON}
Con los datos del deal (asistentes, historia, lo que sabemos, señales), responde SOLO con un JSON: {"objetivo": "qué conseguir en esta reunión, una frase", "contexto": "2-4 frases con lo esencial del deal y la última interacción", "preguntas": ["preguntas concretas para resolver dudas abiertas, máximo 5"], "cuidado": ["riesgos u objeciones a tener en cuenta, máximo 3"]}`,
  call_extraction: `Eres el asistente comercial del CRM. ${COMMON}
De la transcripción o las notas de una reunión con un cliente, extrae solo lo que se dijo. Responde SOLO con un JSON:
{"necesidades": ["qué necesita el cliente"], "decisores": [{"nombre": "", "cargo": "", "rol": "decisor | influye | usuario | compras"}], "presupuesto": "lo dicho sobre presupuesto o vacío", "plazo": "lo dicho sobre plazos o vacío", "objeciones": [""], "competidores": ["otras soluciones que valoran"], "proximos_pasos": [{"tarea": "en imperativo", "en_dias": número de días desde hoy}], "importe_estimado": número o null, "fecha_cierre": "AAAA-MM-DD o null"}`,
  enrich_company: `Analizas la web de una empresa para un CRM. ${COMMON}
Responde SOLO con un JSON: {"sector": "sector en 1-3 palabras", "empleados_aprox": número o null si no se puede saber, "pais": "país o vacío", "ciudad": "ciudad o vacío", "descripcion": "a qué se dedica, una frase"}`,
  qualify_lead: `Cualificas leads con el perfil de cliente ideal de la empresa. ${COMMON}
Decide si el lead encaja con el perfil (sin inventar datos que no estén). Responde SOLO con un JSON: {"encaje": "encaja | no_encaja | falta_info", "motivo": "una o dos frases", "falta": ["lo que habría que saber para decidir"]}`,
  icebreaker: `Escribes la primera línea de un correo de prospección (outbound) en español de España. Cercana, concreta y basada SOLO en los datos de la empresa y del contacto; sin halagos vacíos ni inventar nada. Máximo 25 palabras, sin saludo (el saludo ya va antes).
Responde SOLO con un JSON: {"linea": "la frase"}`,
  write_email: `Escribes correos comerciales (prospección y seguimiento) en español de España para una secuencia. Breves (50 a 125 palabras), concretos, sin relleno ni halagos vacíos, con una sola llamada a la acción al final (mejor una pregunta).
Usa variables con doble llave para personalizar, SOLO de la lista "variables" que se te da (p. ej. {{nombre}}, {{empresa}}); a los datos que pueden faltar ponles valor por defecto: {{cargo|tu equipo}}. Respeta las variables y condiciones ({{#if}}…{{#endif}}) que ya tenga el correo. No inventes datos, cifras ni clientes.
Según "accion": "escribir" (a partir de las instrucciones), "mejorar", "acortar" (a la mitad como mucho), "tono" (al tono que se pide), "asuntos" (propón un asunto mejor). Si "formato" es "html", el texto va en HTML sencillo (<p>, <br>, <strong>, <ul><li>, <a href>); si es "text", en texto plano con saltos de línea.
Responde SOLO con un JSON: {"asunto": "asunto de 2 a 6 palabras", "texto": "el correo"}`,
  compile_instruction: `Conviertes instrucciones en lenguaje natural sobre cómo trabajar los deals de un funnel en reglas para el CRM. ${COMMON}
Cada regla tiene: CUÁNDO actúa, SI (condición opcional, en lenguaje natural, que se comprobará con los datos de cada deal) y QUÉ hace (una sola acción). Si la instrucción pide varias cosas, devuelve varias reglas.
CUÁNDO ("cuando.tipo"): "entra_en_fase" (al entrar en la fase; "fase" opcional si el ámbito ya es una fase; "incluir_existentes": true si también vale para los deals que ya están en ella), "lleva_dias_en_fase" (con "dias"), "novedades_en_fase" (cada vez que hay novedades en el deal: úsalo para «muévelo cuando/si…» y exige "si"), "sin_movimiento" (con "dias"), "responde" (el contacto responde un correo), "abre_correo", "reserva" (reserva una reunión con el enlace), "actividad_hecha" (con "tipo_actividad" y "resultado": held | no_show | any), "actividad_vencida" (con "dias"), "propuesta_vista", "propuesta_aceptada", "deal_creado", "ganado", "perdido".
QUÉ ("accion.tipo"): "correo" (escribir al contacto; "instrucciones_correo": qué debe decir, "asunto": corto, "usar_calendario": true si hay que ofrecer huecos del calendario o agendar), "mover" ("fase_destino": nombre exacto de una fase de la lista), "tarea" ("tipo_actividad" de la lista, "texto", "dias" hasta su fecha), "nota" ("texto"), "avisar" (preguntar o avisar al responsable: "texto"), "asignar" ("responsable": nombre del equipo).
Usa solo fases, tipos de actividad y personas de las listas. Si algo no se puede hacer o es ambiguo, dilo en "dudas".
Responde SOLO con un JSON: {"resumen": "cómo lo has entendido, en una o dos frases", "dudas": [""], "reglas": [{"nombre": "corto", "cuando": {"tipo": "", "fase": "", "dias": 0, "tipo_actividad": "", "resultado": "any", "incluir_existentes": false}, "si": "condición o null", "accion": {"tipo": "", "fase_destino": "", "asunto": "", "instrucciones_correo": "", "usar_calendario": false, "texto": "", "tipo_actividad": "", "dias": 0, "responsable": ""}}]}`,
  check_condition: `Decides si un deal de un CRM cumple una condición, solo con los datos que se te dan (historial, correos, notas, lo que sabemos). ${COMMON} Si no hay datos suficientes para afirmarlo, la respuesta es que NO se cumple.
Responde SOLO con un JSON: {"cumple": true o false, "motivo": "una frase con la prueba concreta (qué dato lo demuestra o qué falta)"}`,
  classify_reply: `Clasificas la respuesta de un contacto a un correo de prospección. ${COMMON}
Responde SOLO con un JSON: {"clase": "interesado | mas_adelante | no_interesado | baja | fuera_oficina | otro", "retomar_en_dias": número o null (para más adelante o fuera de la oficina), "resumen": "una frase con lo que dice"}`,
  proposal: `Eres el asistente comercial del CRM. ${COMMON}
Redacta el texto de una propuesta comercial para el cliente con los datos del deal: saludo, qué necesita (según las notas), qué le proponemos (los productos, sin repetir precios: van en una tabla aparte), por qué encaja y los siguientes pasos. Sin datos internos ni del pipeline. Máximo 250 palabras, firmado por el responsable.
Responde SOLO con un JSON: {"titulo": "título de la propuesta", "texto": "el texto, con saltos de línea"}`,
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

// ---------------------------------------------------------------------------
// Consumo y presupuesto

/** Qué agente usa cada tarea (para el presupuesto por agente). */
export const TASK_AGENT: Record<AiTask, string> = {
  enrich_company: "captacion", qualify_lead: "captacion", lead_chat: "captacion",
  icebreaker: "prospeccion", classify_reply: "prospeccion", write_email: "prospeccion", compile_instruction: "ejecutivo", check_condition: "ejecutivo",
  deal_brief: "ejecutivo", meeting_recap: "ejecutivo", meeting_prep: "ejecutivo", call_extraction: "ejecutivo", proposal: "ejecutivo",
  daily_digest: "riesgo", report_question: "riesgo",
  handoff: "onboarding",
};
/** Lo que una persona está esperando en ese momento: no se corta por presupuesto. */
const URGENT = new Set<AiTask | "test">(["test", "lead_chat", "report_question", "proposal", "write_email", "compile_instruction"]);

export type AiSpend = { month: number; byAgent: Record<string, number>; budget: number | null; agentBudgets: Record<string, number>; calls: number };

export async function aiSpend(): Promise<AiSpend> {
  const [cfg] = await sql<{ monthly_budget: string | null; agent_budgets: Record<string, number> }[]>`SELECT monthly_budget::text, agent_budgets FROM ai_settings`;
  const rows = await sql<{ agent: string | null; cost: number; calls: number }[]>`
    SELECT agent, sum(cost)::float8 AS cost, count(*)::int AS calls FROM ai_usage WHERE at >= date_trunc('month', now()) GROUP BY agent`;
  const byAgent: Record<string, number> = {};
  for (const r of rows) byAgent[r.agent ?? "otros"] = r.cost;
  return {
    month: rows.reduce((n, r) => n + r.cost, 0), byAgent, calls: rows.reduce((n, r) => n + r.calls, 0),
    budget: cfg?.monthly_budget === null || cfg?.monthly_budget === undefined ? null : Number(cfg.monthly_budget), agentBudgets: cfg?.agent_budgets ?? {},
  };
}

/** ¿Hay presupuesto para esta tarea? (las urgentes siempre pasan). */
async function withinBudget(task: AiTask | "test"): Promise<string | null> {
  if (URGENT.has(task)) return null;
  const s = await aiSpend();
  if (s.budget !== null && s.month >= s.budget) return `Presupuesto de IA del mes agotado (${s.month.toFixed(2)} € de ${s.budget} €): solo se usa en lo urgente.`;
  const agent = TASK_AGENT[task as AiTask];
  const cap = agent ? Number(s.agentBudgets[agent]) : NaN;
  if (agent && Number.isFinite(cap) && cap >= 0 && (s.byAgent[agent] ?? 0) >= cap) return `Presupuesto de IA del agente «${agent}» agotado este mes.`;
  return null;
}

async function recordUsage(task: AiTask | "test", input: number, output: number) {
  const [cfg] = await sql<{ price_in: string; price_out: string }[]>`SELECT price_in::text, price_out::text FROM ai_settings`;
  const cost = (input * Number(cfg?.price_in ?? 3) + output * Number(cfg?.price_out ?? 15)) / 1e6;
  await sql`INSERT INTO ai_usage (task, agent, input_tokens, output_tokens, cost)
            VALUES (${task}, ${TASK_AGENT[task as AiTask] ?? null}, ${input}, ${output}, ${cost})`;
  // Avisos a los administradores al 80 % y al 100 % del presupuesto (una vez al mes cada uno).
  const s = await aiSpend();
  if (s.budget === null || s.budget <= 0) return;
  const month = new Date().toISOString().slice(0, 7);
  for (const pct of [100, 80]) {
    if (s.month < (s.budget * pct) / 100) continue;
    const key = `${month}:${pct}`;
    const [fresh] = await sql`UPDATE ai_settings SET budget_alerts = array_append(budget_alerts, ${key}) WHERE NOT (${key} = ANY(budget_alerts)) RETURNING 1`;
    if (fresh) {
      const admins = await sql<{ id: string }[]>`SELECT id FROM users WHERE role = 'admin' AND is_active AND kind = 'human'`;
      for (const a of admins) {
        await sql`INSERT INTO notifications (user_id, kind, title, body, link) VALUES (${a.id}, 'ai_budget',
                  ${pct === 100 ? "Presupuesto de IA del mes agotado" : "Llevas el 80 % del presupuesto de IA del mes"},
                  ${`${s.month.toFixed(2)} € de ${s.budget} €.${pct === 100 ? " Hasta fin de mes, la IA solo se usa en lo urgente (chat de la web, propuestas y preguntas); lo demás sigue con reglas." : ""}`}, '/agents')`;
      }
    }
    break;
  }
}

/**
 * Pide un texto al modelo configurado. Devuelve null si no hay IA
 * configurada o si falla (el error queda en Ajustes).
 */
export async function generate(task: AiTask | "test", facts: unknown, opts: { maxTokens?: number } = {}): Promise<string | null> {
  const [row] = await sql<{ provider: AiProvider; base_url: string | null; model: string | null; api_key: string | null;
                           prompts: Partial<Record<AiTask, string>> }[]>`SELECT provider, base_url, model, api_key, prompts FROM ai_settings`;
  if (!row || row.provider === "none" || !row.model || !row.api_key) return null;
  const blocked = await withinBudget(task);
  if (blocked) {
    await sql`UPDATE ai_settings SET last_error = ${blocked}`;
    return null;
  }
  const p = preset(row.provider);
  const base = (row.base_url || p.baseUrl).replace(/\/$/, "");
  const system = task === "test" ? "Responde solo «ok»." : (row.prompts[task] ?? DEFAULT_PROMPTS[task]);
  const user = JSON.stringify({ tarea: task, fecha: new Date().toISOString(), datos: facts });
  try {
    const key = decrypt(row.api_key);
    let text: string | undefined;
    // Tokens usados; si el proveedor no los da, se estiman (unos 4 caracteres por token).
    let usage: [number, number] = [0, 0];
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
      usage = [Number(j.usage?.input_tokens) || 0, Number(j.usage?.output_tokens) || 0];
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
      usage = [Number(j.usage?.prompt_tokens) || 0, Number(j.usage?.completion_tokens) || 0];
    }
    if (!text?.trim()) throw new Error("El modelo no devolvió texto.");
    if (!usage[0] && !usage[1]) usage = [Math.ceil((system.length + user.length) / 4), Math.ceil(text.length / 4)];
    await recordUsage(task, usage[0], usage[1]).catch((err) => console.error("[consumo de IA]", err));
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

/** Modelos conocidos para sugerir antes de tener la lista del proveedor. */
export const KNOWN_MODELS: Partial<Record<AiProvider, { id: string; note: string }[]>> = {
  anthropic: [
    { id: "claude-sonnet-5-5", note: "Equilibrado: el recomendado para el día a día" },
    { id: "claude-opus-5-5", note: "El más capaz, más caro" },
    { id: "claude-haiku-4-5-20251001", note: "El más rápido y barato" },
  ],
};

/**
 * Pregunta al proveedor qué modelos hay disponibles con esta clave. Usa la clave
 * escrita en el formulario o, si no hay, la guardada.
 */
export async function listProviderModels(provider: AiProvider, typedKey: string | null, baseUrl: string | null): Promise<{ id: string; name: string; created: string | null }[]> {
  const p = preset(provider);
  if (provider === "none") return [];
  let key = typedKey?.trim() || null;
  if (!key) {
    const [row] = await sql<{ api_key: string | null; provider: AiProvider }[]>`SELECT api_key, provider FROM ai_settings`;
    if (row?.api_key && row.provider === provider) key = decrypt(row.api_key);
  }
  if (!key) throw new UserError("Pega la clave de API para ver los modelos de tu cuenta.");
  const base = (baseUrl?.trim() || p.baseUrl).replace(/\/$/, "");
  if (!base) throw new UserError("Indica la dirección de la API.");
  const res = p.kind === "anthropic"
    ? await fetch(`${base}/v1/models?limit=100`, { signal: AbortSignal.timeout(15_000), headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })
    : await fetch(`${base}/models`, { signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${key}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new UserError(`El proveedor no ha dado la lista: ${j?.error?.message ?? `HTTP ${res.status}`}`);
  const rows = (Array.isArray(j.data) ? j.data : []) as { id: string; display_name?: string; created_at?: string; created?: number }[];
  return rows
    .map((m) => ({ id: m.id, name: m.display_name ?? m.id, created: m.created_at ?? (m.created ? new Date(m.created * 1000).toISOString() : null) }))
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
}
