import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { INTEGRATION_ACTOR, type Actor } from "./events";
import { ingestLead } from "./leads";
import { recomputeScores } from "./scoring";
import { applyAssignment } from "./assignment";
import { aiReady, generate, getAiSettings, parseJsonReply } from "./ai";
import { publicBase } from "./email-track";
import { parse, text } from "./validation";

// ===========================================================================
// Formularios web alojados en el CRM y chat con IA para la web.
// ===========================================================================

export const FIELD_KEYS = ["full_name", "email", "phone", "company", "job_title", "message"] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];
export const FIELD_DEFAULT_LABELS: Record<FieldKey, string> = {
  full_name: "Nombre", email: "Email", phone: "Teléfono", company: "Empresa", job_title: "Cargo", message: "Mensaje",
};
export type FormField = { key: FieldKey; label: string; required: boolean };

export type WebForm = {
  id: string; slug: string; name: string; title: string; description: string | null; fields: FormField[];
  source: string; source_detail: string | null; intent: "lead" | "demo_request"; funnel_stage: "tofu" | "mofu" | "bofu" | null;
  tags: string[]; success_message: string; redirect_url: string | null; chat_enabled: boolean; chat_context: string | null;
  is_active: boolean; submissions: number; created_at: Date;
};

const cols = sql`id, slug, name, title, description, fields, source, source_detail, intent, funnel_stage, tags, success_message,
                 redirect_url, chat_enabled, chat_context, is_active, submissions, created_at`;

export const listForms = () => sql<WebForm[]>`SELECT ${cols} FROM web_forms ORDER BY is_active DESC, lower(name)`;
export async function getForm(id: string) {
  const [f] = await sql<WebForm[]>`SELECT ${cols} FROM web_forms WHERE id = ${id}`;
  return f ?? null;
}
export async function formBySlug(slug: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(slug)) return null;
  const [f] = await sql<WebForm[]>`SELECT ${cols} FROM web_forms WHERE slug = ${slug} AND is_active`;
  return f ?? null;
}

export const formUrl = (f: { slug: string }) => `${publicBase() ?? ""}/f/${f.slug}`;

const formSchema = z.object({
  name: text("El nombre", 120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,60}$/, "La dirección: letras, números y guiones, sin tildes (3 a 61)."),
  title: text("El título", 200),
  description: z.string().trim().max(2000).optional(),
  source: text("El origen", 100),
  source_detail: z.string().trim().max(300).optional(),
  intent: z.enum(["lead", "demo_request"]),
  funnel_stage: z.enum(["", "tofu", "mofu", "bofu"]).optional(),
  tags: z.string().max(500).optional(),
  success_message: text("El mensaje de gracias", 500),
  redirect_url: z.string().trim().max(500).optional(),
  chat_enabled: z.string().optional(),
  chat_context: z.string().trim().max(4000).optional(),
  is_active: z.string().optional(),
});

function readFields(form: Record<string, unknown>): FormField[] {
  const fields: FormField[] = [];
  for (const key of FIELD_KEYS) {
    if (key !== "email" && form[`field_${key}`] !== "on") continue;
    const label = String(form[`label_${key}`] ?? "").trim().slice(0, 120) || FIELD_DEFAULT_LABELS[key];
    fields.push({ key, label, required: key === "email" || form[`required_${key}`] === "on" });
  }
  return fields;
}

export async function saveForm(actor: Actor, formId: string | null, data: Record<string, unknown>): Promise<string> {
  const v = parse(formSchema, data);
  if (v.redirect_url && !/^https?:\/\//.test(v.redirect_url)) throw new UserError("La página de destino tiene que empezar por https://.");
  const [taken] = await sql`SELECT 1 FROM web_forms WHERE slug = ${v.slug} AND id IS DISTINCT FROM ${formId}::uuid`;
  if (taken) throw new UserError("Esa dirección ya la usa otro formulario.");
  const values = {
    name: v.name, slug: v.slug, title: v.title, description: v.description || null, fields: sql.json(readFields(data)),
    source: v.source, source_detail: v.source_detail || null, intent: v.intent, funnel_stage: v.funnel_stage || null,
    tags: (v.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 20),
    success_message: v.success_message, redirect_url: v.redirect_url || null,
    chat_enabled: v.chat_enabled === "on", chat_context: v.chat_context || null, is_active: formId ? v.is_active === "on" : true,
  };
  if (formId) {
    await sql`UPDATE web_forms SET ${sql(values as unknown as Record<string, never>)} WHERE id = ${formId}`;
    return formId;
  }
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO web_forms ${sql({ ...values, created_by: actor.id } as unknown as Record<string, never>)} RETURNING id`;
  return row.id;
}

export async function deleteForm(formId: string) {
  await sql`DELETE FROM web_forms WHERE id = ${formId}`;
}

/** Lo que llega de la web: entra como lead (o solicitud de demo), se puntúa y se reparte. */
async function intake(f: WebForm, v: { email: string; full_name?: string; phone?: string; company?: string; job_title?: string; message?: string },
                      utm: Record<string, string> = {}) {
  const r = await ingestLead(INTEGRATION_ACTOR, {
    email: v.email, full_name: v.full_name || undefined, phone: v.phone || undefined, company: v.company || undefined,
    job_title: v.job_title || undefined, message: v.message || undefined, source: f.source, source_detail: f.source_detail ?? f.name,
    intent: f.intent, funnel_stage: f.funnel_stage ?? undefined, tags: f.tags.length ? f.tags : undefined, ...utm,
  });
  await sql`UPDATE web_forms SET submissions = submissions + 1 WHERE id = ${f.id}`;
  await recomputeScores(r.lead_id).then(() => applyAssignment()).catch((err) => console.error("[formulario]", err));
  return r;
}

/** utm_* de la página donde estaba el formulario (campos ocultos). */
export function utmFrom(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
    const v = String(data[k] ?? "").trim().slice(0, 200);
    if (v) out[k] = v;
  }
  return out;
}

export async function submitForm(slug: string, data: Record<string, unknown>): Promise<{ message: string; redirect: string | null }> {
  const f = await formBySlug(slug);
  if (!f) throw new UserError("Este formulario ya no está disponible.");
  // Antispam: un campo oculto que solo rellenan los robots y un tiempo mínimo para rellenarlo.
  const started = Number(data._t);
  const bot = String(data.website ?? "") !== "" || !Number.isFinite(started) || Date.now() - started < 2000;
  if (bot) return { message: f.success_message, redirect: f.redirect_url };
  const values: Record<string, string> = {};
  for (const field of f.fields) {
    const v = String(data[field.key] ?? "").trim();
    if (field.required && !v) throw new UserError(`Falta «${field.label}».`);
    if (v) values[field.key] = v.slice(0, field.key === "message" ? 5000 : 300);
  }
  const email = (values.email ?? "").toLowerCase();
  if (!z.email().safeParse(email).success) throw new UserError("El email no es válido.");
  await intake(f, { ...values, email }, utmFrom(data));
  return { message: f.success_message, redirect: f.redirect_url };
}

// ---------------------------------------------------------------------------
// Chat con IA

export type ChatMessage = { rol: "visitante" | "asistente"; texto: string };
export type ChatReply = { reply: string; done: boolean };

const hits = new Map<string, number[]>();
/** Límite sencillo por visitante: 40 mensajes por hora. */
function rateLimited(key: string) {
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < 3600000);
  list.push(now);
  hits.set(key, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 40;
}

export async function chatAvailable(f: WebForm) {
  return f.chat_enabled && aiReady(await getAiSettings());
}

export async function chat(slug: string, messages: unknown, who: string): Promise<ChatReply> {
  const f = await formBySlug(slug);
  if (!f || !(await chatAvailable(f))) throw new UserError("El chat no está disponible ahora mismo.");
  const conv = z.array(z.object({ rol: z.enum(["visitante", "asistente"]), texto: z.string().max(2000) })).max(40).safeParse(messages);
  if (!conv.success || conv.data.length === 0) throw new UserError("Mensaje no válido.");
  if (conv.data.filter((m) => m.rol === "visitante").length > 15) {
    return { reply: "Gracias por la conversación. Para seguir, déjanos tu email en el formulario y te escribimos.", done: true };
  }
  if (rateLimited(`${slug}:${who}`)) throw new UserError("Demasiados mensajes seguidos. Inténtalo dentro de un rato.");
  const raw = await generate("lead_chat", {
    empresa: f.title, contexto: f.chat_context ?? f.description ?? "", conversacion: conv.data.slice(-20),
  }, { maxTokens: 600 });
  const j = parseJsonReply<{ respuesta?: string; datos?: Record<string, string>; listo?: boolean }>(raw);
  if (!j?.respuesta) return { reply: "Perdona, ahora mismo no puedo responder. Déjanos tus datos en el formulario y te escribimos.", done: false };
  const d = j.datos ?? {};
  const email = String(d.email ?? "").trim().toLowerCase();
  if (j.listo && z.email().safeParse(email).success) {
    const transcript = conv.data.map((m) => `${m.rol === "visitante" ? "Visitante" : "Asistente"}: ${m.texto}`).join("\n");
    await intake(f, {
      email, full_name: d.nombre, company: d.empresa, phone: d.telefono,
      message: [`Necesidad (resumen del chat): ${d.necesidad ?? "—"}`, "", "Conversación:", transcript].join("\n").slice(0, 5000),
    });
    return { reply: j.respuesta, done: true };
  }
  return { reply: j.respuesta, done: false };
}
