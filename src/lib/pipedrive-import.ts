import { sql, json, type Db } from "./db";
import { decrypt, encrypt, encryptionConfigured } from "./crypto";
import { UserError } from "./errors";
import { activityTypes } from "./activity-types";
import { normalizeDomain } from "./validation";
import { zonedToUtc } from "./slots";

// ===========================================================================
// Importación desde Pipedrive (API v1 y v2).
//
// Repetible: cada registro guarda su id de Pipedrive, así que volver a
// importar actualiza lo existente y añade lo nuevo sin duplicar. Se procesa
// por pasos y a trozos (una página cada vez), guardando dónde va: sirve
// igual en un servidor permanente que en Vercel, y si se corta, sigue.
// Mientras se convive con Pipedrive, puede repetirse cada hora (solo trae
// lo cambiado desde la vez anterior). Pipedrive manda: en una importación,
// sus datos sobrescriben los del CRM.
// ===========================================================================

const API = () => (process.env.PIPEDRIVE_API_URL ?? "https://api.pipedrive.com").replace(/\/$/, "");
const TZ = () => process.env.TZ || "Europe/Madrid";
const PAGE = 500;

export const STEPS = [
  "users", "activity_types", "pipelines", "stages", "fields", "organizations", "persons", "leads", "deals",
  "activities", "notes", "files", "flow", "verify",
] as const;
export type Step = (typeof STEPS)[number] | "done";

export const STEP_LABELS: Record<string, string> = {
  users: "Usuarios", activity_types: "Tipos de actividad", pipelines: "Pipelines", stages: "Fases", fields: "Campos personalizados",
  organizations: "Empresas", persons: "Contactos", leads: "Leads", deals: "Deals", activities: "Actividades", notes: "Notas",
  files: "Archivos", flow: "Recorrido por fases", verify: "Comprobación", done: "Terminado",
};

// ---------------------------------------------------------------------------
// Cliente

class PipedriveError extends Error {
  constructor(message: string, public status = 0, public retryAfter = 0) { super(message); }
}

type Json = Record<string, unknown>;

async function call(token: string, path: string, params: Record<string, string | number | undefined> = {}): Promise<Json> {
  const q = new URLSearchParams({ api_token: token });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
  const res = await fetch(`${API()}${path}?${q}`, { signal: AbortSignal.timeout(60_000) });
  if (res.status === 429) throw new PipedriveError("Pipedrive pide esperar (límite de peticiones).", 429, Number(res.headers.get("retry-after") ?? 10));
  const body = (await res.json().catch(() => ({}))) as Json;
  if (res.status === 401) throw new PipedriveError("El token de Pipedrive no es válido o ha caducado.", 401);
  if (!res.ok || body.success === false) throw new PipedriveError(String(body.error ?? `Pipedrive respondió ${res.status}`), res.status);
  return body;
}

/** Página de la API v2 (paginación por cursor). */
async function pageV2(token: string, entity: string, cursor: string | null, extra: Json = {}) {
  const body = await call(token, `/api/v2/${entity}`, { limit: PAGE, cursor: cursor ?? undefined, ...(extra as Record<string, string>) });
  const next = (body.additional_data as Json | undefined)?.next_cursor as string | null | undefined;
  return { items: (body.data as Json[] | null) ?? [], next: next ?? null };
}

/** Página de la API v1 (paginación por desplazamiento). */
async function pageV1(token: string, path: string, cursor: string | null, extra: Json = {}) {
  const start = Number(cursor ?? 0);
  const body = await call(token, path, { start, limit: PAGE, ...(extra as Record<string, string>) });
  const p = (body.additional_data as Json | undefined)?.pagination as Json | undefined;
  const items = (Array.isArray(body.data) ? body.data : []) as Json[];
  return { items, next: p?.more_items_in_collection ? String(p.next_start ?? start + items.length) : null };
}

// ---------------------------------------------------------------------------
// Ajustes: token y sincronización

export type PipedriveSettings = { connected: boolean; company: string | null; sync: boolean };

export async function getPipedriveSettings(): Promise<PipedriveSettings> {
  const [s] = await sql<{ pipedrive_token: string | null; pipedrive_company: string | null; pipedrive_sync: boolean }[]>`
    SELECT pipedrive_token, pipedrive_company, pipedrive_sync FROM app_settings`;
  return { connected: Boolean(s?.pipedrive_token), company: s?.pipedrive_company ?? null, sync: s?.pipedrive_sync ?? false };
}

async function token(): Promise<string> {
  const [s] = await sql<{ pipedrive_token: string | null }[]>`SELECT pipedrive_token FROM app_settings`;
  if (!s?.pipedrive_token) throw new UserError("Conecta primero Pipedrive con tu token de API.");
  return decrypt(s.pipedrive_token);
}

/** Comprueba el token y lo guarda cifrado. */
export async function connectPipedrive(rawToken: string) {
  const t = rawToken.trim();
  if (t.length < 20) throw new UserError("El token no parece válido (Pipedrive → Configuración personal → API).");
  if (!encryptionConfigured()) throw new UserError("Falta TOKEN_ENCRYPTION_KEY en el servidor para guardar el token cifrado.");
  let me: Json;
  try {
    me = (await call(t, "/v1/users/me")).data as Json;
  } catch (err) {
    throw new UserError(err instanceof Error ? err.message : "No se pudo conectar con Pipedrive.");
  }
  const company = String(me.company_name ?? me.company_domain ?? "Pipedrive");
  await sql`UPDATE app_settings SET pipedrive_token = ${encrypt(t)}, pipedrive_company = ${company}, updated_at = now()`;
  return company;
}

export async function disconnectPipedrive() {
  await sql`UPDATE app_settings SET pipedrive_token = NULL, pipedrive_company = NULL, pipedrive_sync = false, updated_at = now()`;
}

export async function setPipedriveSync(on: boolean) {
  await sql`UPDATE app_settings SET pipedrive_sync = ${on}, updated_at = now()`;
}

// ---------------------------------------------------------------------------
// Trabajos

export type ImportJob = {
  id: string; status: "running" | "done" | "failed" | "cancelled"; step: Step; cursor: string | null;
  options: { flow?: boolean; files?: boolean; since?: string | null };
  counts: Record<string, { created?: number; updated?: number; skipped?: number }>;
  warnings: string[]; verify: { label: string; pipedrive: number; crm: number }[] | null; error: string | null;
  started_at: Date; updated_at: Date; finished_at: Date | null;
};

export async function listImportJobs(limit = 10) {
  return sql<ImportJob[]>`SELECT * FROM import_jobs ORDER BY started_at DESC LIMIT ${limit}`;
}

export async function runningJob(): Promise<ImportJob | null> {
  const [j] = await sql<ImportJob[]>`SELECT * FROM import_jobs WHERE status = 'running' LIMIT 1`;
  return j ?? null;
}

/**
 * Empieza una importación. La IA se pone en pausa: así no reacciona de golpe
 * a cientos de deals importados (se reanuda en Ajustes tras revisarlo).
 */
export async function startImport(options: { flow: boolean; files: boolean; incremental?: boolean }): Promise<string> {
  await token();
  if (await runningJob()) throw new UserError("Ya hay una importación en marcha.");
  let since: string | null = null;
  if (options.incremental) {
    const [last] = await sql<{ started_at: Date }[]>`SELECT started_at FROM import_jobs WHERE status = 'done' ORDER BY started_at DESC LIMIT 1`;
    since = last ? new Date(last.started_at.getTime() - 5 * 60000).toISOString() : null;
  }
  if (!options.incremental) await sql`UPDATE automation_settings SET paused = true`;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO import_jobs (step, options) VALUES ('users', ${json({ flow: options.flow, files: options.files, since })})
    RETURNING id`;
  return row.id;
}

export async function cancelImport(jobId: string) {
  await sql`UPDATE import_jobs SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = ${jobId} AND status = 'running'`;
}

/**
 * Avanza la importación en marcha durante unos segundos (página a página).
 * La llaman la pantalla de importación (mientras está abierta) y la revisión
 * periódica (para que siga aunque se cierre la pantalla).
 */
export async function continueImport(budgetMs = 15_000): Promise<ImportJob | null> {
  const started = Date.now();
  const conn = await sql.reserve();
  try {
    const [{ locked }] = await conn<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(4201338) AS locked`;
    if (!locked) return runningJob();
    try {
      let job = await runningJob();
      if (!job) return null;
      const t = await token();
      await activityTypes(true);
      while (job && job.status === "running" && Date.now() - started < budgetMs) {
        try {
          const r = await STEP_RUNNERS[job.step as Exclude<Step, "done">](t, job);
          const idx = STEPS.indexOf(job.step as (typeof STEPS)[number]);
          const nextStep: Step = r.next !== null ? job.step : (STEPS[idx + 1] ?? "done");
          const done = nextStep === "done";
          await sql`
            UPDATE import_jobs SET step = ${nextStep}, cursor = ${r.next}, counts = ${json(job.counts)}, warnings = ${job.warnings},
                   status = ${done ? "done" : "running"}, finished_at = ${done ? new Date() : null}, updated_at = now()
            WHERE id = ${job.id}`;
          job = (await sql<ImportJob[]>`SELECT * FROM import_jobs WHERE id = ${job.id}`)[0];
        } catch (err) {
          if (err instanceof PipedriveError && err.status === 429) {
            // Límite de Pipedrive: se sigue en la siguiente llamada.
            await sql`UPDATE import_jobs SET updated_at = now() WHERE id = ${job.id}`;
            break;
          }
          const message = err instanceof Error ? err.message : String(err);
          await sql`UPDATE import_jobs SET status = 'failed', error = ${message.slice(0, 1000)}, finished_at = now(), updated_at = now()
                    WHERE id = ${job.id}`;
          console.error("[importación pipedrive]", err);
          return (await sql<ImportJob[]>`SELECT * FROM import_jobs WHERE id = ${job.id}`)[0];
        }
      }
      if (job?.status === "done") await sql`UPDATE app_settings SET updated_at = now()`;
      return job;
    } finally {
      await conn`SELECT pg_advisory_unlock(4201338)`;
    }
  } finally {
    conn.release();
  }
}

/** Para la revisión periódica: sigue la importación en marcha o, si toca, lanza la sincronización horaria. */
export async function importTick(): Promise<void> {
  const s = await getPipedriveSettings();
  if (!s.connected) return;
  if (!(await runningJob()) && s.sync) {
    const [last] = await sql<{ started_at: Date }[]>`SELECT started_at FROM import_jobs ORDER BY started_at DESC LIMIT 1`;
    if (!last || Date.now() - new Date(last.started_at).getTime() > 60 * 60000) {
      await startImport({ flow: true, files: false, incremental: true }).catch(() => null);
    }
  }
  if (await runningJob()) await continueImport(20_000);
}

// ---------------------------------------------------------------------------
// Utilidades de conversión

type StepResult = { next: string | null };
type Runner = (token: string, job: ImportJob) => Promise<StepResult>;

const idOf = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object") {
    const o = v as Json;
    return idOf(o.value ?? o.id);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));
/** Fecha de Pipedrive («2024-01-01 10:00:00» UTC en v1, RFC 3339 en v2). */
const ts = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(/T/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const dateOnly = (v: unknown) => (str(v) && /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null);

/** HTML de Pipedrive (notas, descripciones) a texto. */
export function htmlToText(html: string | null | undefined) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function bump(job: ImportJob, entity: string, kind: "created" | "updated" | "skipped", n = 1) {
  const c = (job.counts[entity] ??= {});
  c[kind] = (c[kind] ?? 0) + n;
}
function warn(job: ImportJob, message: string) {
  if (job.warnings.length < 50 && !job.warnings.includes(message)) job.warnings.push(message);
}

/** pipedrive_id → id del CRM para una tabla. */
async function idMap(table: "users" | "pipelines" | "stages" | "organizations" | "persons" | "deals" | "leads", ids: (number | string | null)[]) {
  const keys = [...new Set(ids.filter((x): x is number | string => x !== null && x !== undefined).map(String))];
  const map = new Map<string, string>();
  if (!keys.length) return map;
  const rows = await sql<{ pipedrive_id: string; id: string }[]>`
    SELECT pipedrive_id::text, id FROM ${sql(table)} WHERE pipedrive_id::text = ANY(${keys}::text[])`;
  for (const r of rows) map.set(r.pipedrive_id, r.id);
  return map;
}
const look = (m: Map<string, string>, v: number | string | null) => (v === null ? null : m.get(String(v)) ?? null);

/** Inserta o actualiza por pipedrive_id; devuelve si era nuevo. */
async function upsert(db: Db, table: string, pdId: number | string, values: Record<string, unknown>): Promise<{ id: string; created: boolean }> {
  const [row] = await db<{ id: string; created: boolean }[]>`
    INSERT INTO ${db(table)} ${db({ ...values, pipedrive_id: pdId } as unknown as Record<string, never>)}
    ON CONFLICT (pipedrive_id) DO UPDATE SET ${db(values as unknown as Record<string, never>)}
    RETURNING id, (xmax = 0) AS created`;
  return row;
}

// ---------------------------------------------------------------------------
// Pasos

const users: Runner = async (t, job) => {
  const body = await call(t, "/v1/users");
  for (const u of (body.data as Json[]) ?? []) {
    const email = str(u.email)?.toLowerCase() ?? null;
    const [byEmail] = email ? await sql<{ id: string }[]>`SELECT id FROM users WHERE lower(email) = ${email} AND pipedrive_id IS NULL` : [];
    if (byEmail) {
      await sql`UPDATE users SET pipedrive_id = ${idOf(u.id)} WHERE id = ${byEmail.id}`;
      bump(job, "users", "updated");
      continue;
    }
    const r = await upsert(sql, "users", idOf(u.id)!, { name: str(u.name) ?? email ?? "Usuario de Pipedrive", email, kind: "human", is_active: u.active_flag !== false });
    bump(job, "users", r.created ? "created" : "updated");
  }
  return { next: null };
};

const typeKey = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

const labelKey = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/** Tipo de actividad del CRM para cada tipo de Pipedrive (por clave o, si no, por nombre). */
async function typeMap(t: string): Promise<Map<string, string>> {
  const ours = await activityTypes(true);
  const byLabel = new Map(ours.map((x) => [labelKey(x.label), x.key]));
  const keys = new Set(ours.map((x) => x.key));
  const out = new Map<string, string>();
  const body = await call(t, "/v1/activityTypes").catch(() => ({ data: [] }) as Json);
  for (const a of (body.data as Json[]) ?? []) {
    const raw = typeKey(String(a.key_string ?? a.name ?? ""));
    const key = raw === "lunch" ? "meeting" : raw;
    const mapped = keys.has(key) ? key : byLabel.get(labelKey(str(a.name) ?? ""));
    if (mapped) out.set(raw, mapped);
  }
  return out;
}

const activityTypesStep: Runner = async (t, job) => {
  const body = await call(t, "/v1/activityTypes");
  const current = await activityTypes(true);
  const existing = new Set(current.map((x) => x.key));
  const labels = new Set(current.map((x) => labelKey(x.label)));
  for (const a of (body.data as Json[]) ?? []) {
    let key = typeKey(String(a.key_string ?? a.name ?? ""));
    if (key.length < 2) continue;
    if (key === "lunch") key = "meeting"; // «Comida» se trata como reunión
    const label = str(a.name) ?? key;
    // Ya existe (por clave o con el mismo nombre, p. ej. «Llamada»): se usa ese tipo.
    if (existing.has(key) || labels.has(labelKey(label))) { bump(job, "activity_types", "skipped"); continue; }
    await sql`INSERT INTO activity_types (key, label, is_session, is_active, position)
              VALUES (${key}, ${label}, false, ${a.active_flag !== false}, 100)
              ON CONFLICT DO NOTHING`;
    existing.add(key);
    labels.add(labelKey(label));
    bump(job, "activity_types", "created");
  }
  await activityTypes(true);
  return { next: null };
};

const pipelines: Runner = async (t, job) => {
  const { items, next } = await pageV2(t, "pipelines", job.cursor);
  for (const p of items) {
    if (p.is_deleted) continue;
    const name = str(p.name) ?? `Pipeline ${p.id}`;
    // Si ya hay un pipeline con ese nombre (creado a mano), se reutiliza.
    const [same] = await sql<{ id: string }[]>`SELECT id FROM pipelines WHERE lower(name) = lower(${name}) AND pipedrive_id IS NULL`;
    if (same) { await sql`UPDATE pipelines SET pipedrive_id = ${idOf(p.id)} WHERE id = ${same.id}`; bump(job, "pipelines", "updated"); continue; }
    const r = await upsert(sql, "pipelines", idOf(p.id)!, { name, position: Number(p.order_nr ?? 0), is_active: true });
    bump(job, "pipelines", r.created ? "created" : "updated");
  }
  return { next };
};

const stages: Runner = async (t, job) => {
  const { items, next } = await pageV2(t, "stages", job.cursor);
  const pmap = await idMap("pipelines", items.map((s) => idOf(s.pipeline_id)));
  await sql.begin(async (tx) => {
    await tx`SET CONSTRAINTS ALL DEFERRED`;
    for (const s of items) {
      const pipelineId = look(pmap, idOf(s.pipeline_id));
      if (!pipelineId || s.is_deleted) { bump(job, "stages", "skipped"); continue; }
      const rot = s.is_deal_rot_enabled && Number(s.days_to_rotten) > 0 ? Number(s.days_to_rotten) : null;
      const r = await upsert(tx as unknown as Db, "stages", idOf(s.id)!, {
        pipeline_id: pipelineId, name: str(s.name) ?? `Fase ${s.id}`, position: 1000 + Number(s.order_nr ?? 0),
        win_probability: s.deal_probability === null || s.deal_probability === undefined ? null : Math.max(0, Math.min(100, Number(s.deal_probability))),
        rotten_after_days: rot, is_active: true,
      });
      bump(job, "stages", r.created ? "created" : "updated");
    }
    // Posiciones consecutivas por pipeline, en el orden de Pipedrive (las fases propias van detrás).
    await tx`
      UPDATE stages s SET position = x.rn FROM (
        SELECT id, row_number() OVER (PARTITION BY pipeline_id ORDER BY (pipedrive_id IS NULL), position, created_at) AS rn FROM stages
      ) x WHERE x.id = s.id AND s.position <> x.rn`;
  });
  return { next };
};

// Campos personalizados -------------------------------------------------------

const FIELD_TYPE: Record<string, string> = {
  varchar: "text", varchar_auto: "text", address: "text", time: "text", timerange: "text", daterange: "text", varchar_options: "text",
  text: "long_text", double: "number", int: "number", monetary: "money", date: "date", enum: "single_option", set: "multi_option",
  user: "user", phone: "phone",
};
const FIELD_ENTITIES: [string, string][] = [["dealFields", "deal"], ["personFields", "person"], ["organizationFields", "organization"]];

async function fetchFields(t: string, endpoint: string): Promise<Json[]> {
  const out: Json[] = [];
  let cursor: string | null = null;
  try {
    do { const p = await pageV2(t, endpoint, cursor); out.push(...p.items); cursor = p.next; } while (cursor);
    return out;
  } catch (err) {
    if (!(err instanceof PipedriveError) || ![404, 410].includes(err.status)) throw err;
  }
  let start: string | null = null;
  do { const p = await pageV1(t, `/v1/${endpoint}`, start); out.push(...p.items); start = p.next; } while (start);
  return out;
}

const fields: Runner = async (t, job) => {
  for (const [endpoint, entity] of FIELD_ENTITIES) {
    const defs = await fetchFields(t, endpoint);
    for (const f of defs) {
      const pdKey = str(f.field_code ?? f.key);
      const custom = f.is_custom_field ?? (f.edit_flag === true && /^[0-9a-f]{40}$/.test(pdKey ?? ""));
      if (!pdKey || !custom) continue;
      const type = FIELD_TYPE[String(f.field_type)];
      const label = str(f.field_name ?? f.name) ?? pdKey;
      if (!type) { warn(job, `Campo «${label}» (${f.field_type}) no se importa: tipo no compatible.`); continue; }
      const opts = Array.isArray(f.options) ? (f.options as Json[]).map((o) => ({ key: `pd_${o.id}`, label: String(o.label ?? o.id) })) : null;
      const options = type === "single_option" || type === "multi_option" ? (opts?.length ? opts : [{ key: "pd_none", label: "—" }]) : null;
      const [existing] = await sql<{ id: string; options: { key: string; label: string }[] | null }[]>`
        SELECT id, options FROM custom_field_definitions WHERE entity_type = ${entity} AND pipedrive_key = ${pdKey}`;
      if (existing) {
        // Se conservan las opciones antiguas (valores ya guardados) y se añaden las nuevas.
        const merged = options ? [...options, ...(existing.options ?? []).filter((o) => !options.some((n) => n.key === o.key))] : null;
        await sql`UPDATE custom_field_definitions SET label = ${label}, options = ${merged ? json(merged) : null} WHERE id = ${existing.id}`;
        bump(job, "fields", "updated");
        continue;
      }
      let key = typeKey(label).replace(/^[^a-z]+/, "") || "campo";
      key = key.slice(0, 50);
      const taken = new Set((await sql<{ key: string }[]>`SELECT key FROM custom_field_definitions WHERE entity_type = ${entity}`).map((r) => r.key));
      for (let i = 2; taken.has(key); i++) key = `${key.replace(/_\d+$/, "")}_${i}`;
      await sql`
        INSERT INTO custom_field_definitions (entity_type, key, label, field_type, options, position, pipedrive_key)
        VALUES (${entity}, ${key}, ${label}, ${type}, ${options ? json(options) : null},
                (SELECT coalesce(max(position), 0) + 1 FROM custom_field_definitions WHERE entity_type = ${entity}), ${pdKey})`;
      bump(job, "fields", "created");
    }
  }
  return { next: null };
};

type FieldMap = { pdKey: string; key: string; type: string }[];
async function fieldMap(entity: string): Promise<FieldMap> {
  const rows = await sql<{ pipedrive_key: string; key: string; field_type: string }[]>`
    SELECT pipedrive_key, key, field_type FROM custom_field_definitions WHERE entity_type = ${entity} AND pipedrive_key IS NOT NULL`;
  return rows.map((r) => ({ pdKey: r.pipedrive_key, key: r.key, type: r.field_type }));
}

/** Valores de campos personalizados de un registro de Pipedrive (v2: custom_fields; v1: en la raíz). */
async function customValues(item: Json, map: FieldMap, existing: Record<string, unknown> = {}) {
  const src = { ...(item as Json), ...((item.custom_fields as Json | undefined) ?? {}) };
  const out: Record<string, unknown> = { ...existing };
  const users = await idMap("users", map.filter((f) => f.type === "user").map((f) => idOf(src[f.pdKey])));
  for (const f of map) {
    let v = src[f.pdKey];
    if (v === undefined) continue;
    if (v === null || v === "") { delete out[f.key]; continue; }
    if (typeof v === "object" && !Array.isArray(v) && v !== null && "value" in (v as Json)) v = (v as Json).value;
    switch (f.type) {
      case "single_option": v = `pd_${idOf(v)}`; break;
      case "multi_option": v = (Array.isArray(v) ? v : String(v).split(",")).map((x) => `pd_${idOf(x)}`); break;
      case "number": case "money": v = Number(v); break;
      case "user": v = look(users, idOf(v)); break;
      case "date": v = dateOnly(v); break;
      default: v = typeof v === "object" ? JSON.stringify(v) : String(v);
    }
    if (v === null || (typeof v === "number" && !Number.isFinite(v))) delete out[f.key];
    else out[f.key] = v;
  }
  return out;
}

// Empresas, contactos, leads y deals ---------------------------------------------

const since = (job: ImportJob) => (job.options.since ? { updated_since: job.options.since } : {});

const organizations: Runner = async (t, job) => {
  const { items, next } = await pageV2(t, "organizations", job.cursor, since(job));
  const [owners, fmap] = await Promise.all([idMap("users", items.map((o) => idOf(o.owner_id))), fieldMap("organization")]);
  for (const o of items) {
    if (o.is_deleted) { await sql`UPDATE organizations SET deleted_at = coalesce(deleted_at, now()) WHERE pipedrive_id = ${idOf(o.id)}`; continue; }
    const address = o.address && typeof o.address === "object" ? (o.address as Json) : { value: o.address };
    const [prev] = await sql<{ custom: Record<string, unknown> }[]>`SELECT custom FROM organizations WHERE pipedrive_id = ${idOf(o.id)}`;
    const website = str(o.website);
    const domain = normalizeDomain(website);
    const [taken] = domain ? await sql`SELECT 1 FROM organizations WHERE lower(domain) = ${domain} AND deleted_at IS NULL AND pipedrive_id IS DISTINCT FROM ${idOf(o.id)}` : [];
    const r = await upsert(sql, "organizations", idOf(o.id)!, {
      name: str(o.name) ?? `Empresa ${o.id}`, owner_id: look(owners, idOf(o.owner_id)),
      address: str(address.value ?? address.formatted_address), city: str(address.locality), country: str(address.country),
      website, ...(domain && !taken ? { domain } : {}),
      custom: json(await customValues(o, fmap, prev?.custom)), created_at: ts(o.add_time) ?? new Date(), deleted_at: null,
    });
    bump(job, "organizations", r.created ? "created" : "updated");
  }
  return { next };
};

function splitName(p: Json) {
  const first = str(p.first_name), last = str(p.last_name);
  if (first || last) return { first_name: first, last_name: last };
  const name = str(p.name) ?? "Sin nombre";
  const i = name.indexOf(" ");
  return i > 0 ? { first_name: name.slice(0, i), last_name: name.slice(i + 1) } : { first_name: name, last_name: null };
}

const persons: Runner = async (t, job) => {
  const { items, next } = await pageV2(t, "persons", job.cursor, since(job));
  const [owners, orgs, fmap] = await Promise.all([
    idMap("users", items.map((p) => idOf(p.owner_id))), idMap("organizations", items.map((p) => idOf(p.org_id))), fieldMap("person"),
  ]);
  for (const p of items) {
    if (p.is_deleted) { await sql`UPDATE persons SET deleted_at = coalesce(deleted_at, now()) WHERE pipedrive_id = ${idOf(p.id)}`; continue; }
    await sql.begin(async (tx) => {
      const db = tx as unknown as Db;
      const [prev] = await db<{ custom: Record<string, unknown> }[]>`SELECT custom FROM persons WHERE pipedrive_id = ${idOf(p.id)}`;
      const r = await upsert(db, "persons", idOf(p.id)!, {
        ...splitName(p), owner_id: look(owners, idOf(p.owner_id)), custom: json(await customValues(p, fmap, prev?.custom)),
        created_at: ts(p.add_time) ?? new Date(), deleted_at: null,
      });
      bump(job, "persons", r.created ? "created" : "updated");
      // Emails y teléfonos: los de Pipedrive (sin duplicar emails de otros contactos).
      const emails = ((p.emails ?? p.email) as Json[] | undefined ?? []).filter((e) => str(e.value));
      const phones = ((p.phones ?? p.phone) as Json[] | undefined ?? []).filter((e) => str(e.value));
      await db`DELETE FROM person_emails WHERE person_id = ${r.id}`;
      await db`DELETE FROM person_phones WHERE person_id = ${r.id}`;
      let primaryDone = false;
      for (const e of emails) {
        const isPrimary = Boolean(e.primary) && !primaryDone;
        const ok = await db`
          INSERT INTO person_emails (person_id, email, label, is_primary)
          SELECT ${r.id}, ${String(e.value).trim().toLowerCase()}, ${["work", "personal"].includes(String(e.label)) ? String(e.label) : "other"}, ${isPrimary}
          WHERE NOT EXISTS (SELECT 1 FROM person_emails WHERE lower(email) = ${String(e.value).trim().toLowerCase()})`;
        if (ok.count && isPrimary) primaryDone = true;
        if (!ok.count) warn(job, `El email ${e.value} ya era de otro contacto: no se ha duplicado.`);
      }
      primaryDone = false;
      for (const ph of phones) {
        const isPrimary = Boolean(ph.primary) && !primaryDone;
        await db`INSERT INTO person_phones (person_id, phone, label, is_primary)
                 VALUES (${r.id}, ${String(ph.value)}, ${["work", "mobile", "personal"].includes(String(ph.label)) ? String(ph.label) : "other"}, ${isPrimary})`;
        if (isPrimary) primaryDone = true;
      }
      // Empresa actual: si cambia, la anterior queda como antigua (se conserva el historial).
      const orgId = look(orgs, idOf(p.org_id));
      if (orgId) {
        const [cur] = await db`SELECT 1 FROM person_organizations WHERE person_id = ${r.id} AND organization_id = ${orgId} AND status = 'current'`;
        if (!cur) {
          await db`UPDATE person_organizations SET status = 'former', ended_at = current_date WHERE person_id = ${r.id} AND status = 'current'`;
          await db`INSERT INTO person_organizations (person_id, organization_id, status) VALUES (${r.id}, ${orgId}, 'current')`;
        }
      }
    });
  }
  return { next };
};

const leads: Runner = async (t, job) => {
  const { items, next } = await pageV1(t, "/v1/leads", job.cursor);
  const [owners, people, orgs] = await Promise.all([
    idMap("users", items.map((l) => idOf(l.owner_id))), idMap("persons", items.map((l) => idOf(l.person_id))),
    idMap("organizations", items.map((l) => idOf(l.organization_id))),
  ]);
  for (const l of items) {
    const personId = look(people, idOf(l.person_id)), orgId = look(orgs, idOf(l.organization_id));
    if (!personId && !orgId) { bump(job, "leads", "skipped"); continue; }
    const [prev] = await sql<{ status: string }[]>`SELECT status FROM leads WHERE pipedrive_id = ${String(l.id)}`;
    if (prev?.status === "converted") { bump(job, "leads", "skipped"); continue; } // ya es un deal en el CRM
    const r = await upsert(sql, "leads", String(l.id), {
      title: str(l.title) ?? "Lead", person_id: personId, organization_id: orgId, owner_id: look(owners, idOf(l.owner_id)),
      source: str(l.source_name) ?? "pipedrive", status: l.is_archived ? "archived" : "open", created_at: ts(l.add_time) ?? new Date(),
    });
    bump(job, "leads", r.created ? "created" : "updated");
  }
  return { next };
};

async function lostReasonId(label: string | null) {
  if (!label) return null;
  const clean = label.trim().slice(0, 200);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO lost_reasons (label) VALUES (${clean}) ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label RETURNING id`;
  return row.id;
}

const deals: Runner = async (t, job) => {
  const { items, next } = await pageV2(t, "deals", job.cursor, { ...since(job), status: "open,won,lost" });
  const [owners, people, orgs, pls, sts, fmap] = await Promise.all([
    idMap("users", items.map((d) => idOf(d.owner_id ?? d.user_id))), idMap("persons", items.map((d) => idOf(d.person_id))),
    idMap("organizations", items.map((d) => idOf(d.org_id))), idMap("pipelines", items.map((d) => idOf(d.pipeline_id))),
    idMap("stages", items.map((d) => idOf(d.stage_id))), fieldMap("deal"),
  ]);
  for (const d of items) {
    if (d.is_deleted || d.status === "deleted") { await sql`UPDATE deals SET deleted_at = coalesce(deleted_at, now()) WHERE pipedrive_id = ${idOf(d.id)}`; continue; }
    const pipelineId = look(pls, idOf(d.pipeline_id)), stageId = look(sts, idOf(d.stage_id));
    if (!pipelineId || !stageId) { bump(job, "deals", "skipped"); warn(job, `Deal «${d.title}»: su pipeline o fase no existe.`); continue; }
    const status = ["won", "lost"].includes(String(d.status)) ? String(d.status) : "open";
    const personId = look(people, idOf(d.person_id));
    await sql.begin(async (tx) => {
      const db = tx as unknown as Db;
      const [prev] = await db<{ custom: Record<string, unknown> }[]>`SELECT custom FROM deals WHERE pipedrive_id = ${idOf(d.id)}`;
      const r = await upsert(db, "deals", idOf(d.id)!, {
        title: str(d.title) ?? `Deal ${d.id}`, organization_id: look(orgs, idOf(d.org_id)), pipeline_id: pipelineId, stage_id: stageId,
        status, value: d.value === null || d.value === undefined ? null : Math.max(0, Number(d.value)),
        currency: (str(d.currency) ?? "EUR").toUpperCase().slice(0, 3), expected_close_date: dateOnly(d.expected_close_date),
        owner_id: look(owners, idOf(d.owner_id ?? d.user_id)), source: str(d.origin ?? d.channel) ?? "pipedrive",
        stage_entered_at: ts(d.stage_change_time) ?? ts(d.add_time) ?? new Date(),
        won_at: status === "won" ? ts(d.won_time) ?? ts(d.close_time) ?? new Date() : null,
        lost_at: status === "lost" ? ts(d.lost_time) ?? ts(d.close_time) ?? new Date() : null,
        lost_reason_id: status === "lost" ? await lostReasonId(str(d.lost_reason)) : null,
        custom: json(await customValues(d, fmap, prev?.custom)), created_at: ts(d.add_time) ?? new Date(), deleted_at: null,
      });
      bump(job, "deals", r.created ? "created" : "updated");
      if (personId) {
        await db`UPDATE deal_participants SET is_primary = false WHERE deal_id = ${r.id} AND person_id <> ${personId}`;
        await db`INSERT INTO deal_participants (deal_id, person_id, is_primary) VALUES (${r.id}, ${personId}, true)
                 ON CONFLICT (deal_id, person_id) DO UPDATE SET is_primary = true`;
      }
    });
  }
  return { next };
};

// Actividades, notas y archivos ------------------------------------------------------

const activities: Runner = async (t, job) => {
  const { items, next } = await pageV2(t, "activities", job.cursor, since(job));
  const [owners, people, orgs, dls, lds] = await Promise.all([
    idMap("users", items.map((a) => idOf(a.owner_id ?? a.user_id))), idMap("persons", items.map((a) => idOf(a.person_id))),
    idMap("organizations", items.map((a) => idOf(a.org_id))), idMap("deals", items.map((a) => idOf(a.deal_id))),
    idMap("leads", items.map((a) => str(a.lead_id))),
  ]);
  const types = new Set((await activityTypes()).map((x) => x.key));
  const tmap = await typeMap(t);
  for (const a of items) {
    if (a.is_deleted) { await sql`DELETE FROM activities WHERE pipedrive_id = ${idOf(a.id)}`; continue; }
    const dealId = look(dls, idOf(a.deal_id)), leadId = look(lds, str(a.lead_id));
    const personId = look(people, idOf(a.person_id)), orgId = look(orgs, idOf(a.org_id));
    if (!dealId && !leadId && !personId && !orgId) { bump(job, "activities", "skipped"); continue; }
    let type = typeKey(String(a.type ?? "task"));
    type = tmap.get(type) ?? (type === "lunch" ? "meeting" : type);
    if (!types.has(type)) type = "task";
    // Con hora: en UTC. Sin hora: al final de ese día (hora local), para que no salga vencida todo el día.
    const day = dateOnly(a.due_date);
    let due: Date | null = null;
    if (day && str(a.due_time)) due = new Date(`${day}T${String(a.due_time).slice(0, 5)}:00Z`);
    else if (day) { const [y, m, dd] = day.split("-").map(Number); due = zonedToUtc(y, m, dd, 23, 59, TZ()); }
    const dur = str(a.duration)?.split(":").map(Number);
    const minutes = dur && dur.length >= 2 ? dur[0] * 60 + dur[1] : null;
    const done = Boolean(a.done);
    const note = [htmlToText(str(a.note)), htmlToText(str(a.public_description))].filter(Boolean).join("\n\n") || null;
    const r = await upsert(sql, "activities", idOf(a.id)!, {
      type, subject: (str(a.subject) ?? "Actividad").slice(0, 300), note, due_at: due, duration_minutes: minutes && minutes > 0 ? minutes : null,
      done, done_at: done ? ts(a.done_time ?? a.marked_as_done_time) ?? due ?? ts(a.update_time) ?? new Date() : null,
      deal_id: dealId, lead_id: leadId, person_id: personId, organization_id: orgId, owner_id: look(owners, idOf(a.owner_id ?? a.user_id)),
      created_at: ts(a.add_time) ?? new Date(),
    });
    bump(job, "activities", r.created ? "created" : "updated");
  }
  return { next };
};

const notes: Runner = async (t, job) => {
  const { items, next } = await pageV1(t, "/v1/notes", job.cursor);
  const [authors, people, orgs, dls, lds] = await Promise.all([
    idMap("users", items.map((n) => idOf(n.user_id))), idMap("persons", items.map((n) => idOf(n.person_id))),
    idMap("organizations", items.map((n) => idOf(n.org_id))), idMap("deals", items.map((n) => idOf(n.deal_id))),
    idMap("leads", items.map((n) => str(n.lead_id))),
  ]);
  for (const n of items) {
    const content = htmlToText(str(n.content));
    const dealId = look(dls, idOf(n.deal_id)), leadId = look(lds, str(n.lead_id));
    const personId = look(people, idOf(n.person_id)), orgId = look(orgs, idOf(n.org_id));
    if (!content || (!dealId && !leadId && !personId && !orgId)) { bump(job, "notes", "skipped"); continue; }
    const r = await upsert(sql, "notes", idOf(n.id)!, {
      content: content.slice(0, 20000), deal_id: dealId, lead_id: leadId, person_id: personId, organization_id: orgId,
      author_id: look(authors, idOf(n.user_id)), is_pinned: Boolean(n.pinned_to_deal_flag || n.pinned_to_person_flag || n.pinned_to_organization_flag),
      created_at: ts(n.add_time) ?? new Date(),
    });
    bump(job, "notes", r.created ? "created" : "updated");
  }
  return { next };
};

const files: Runner = async (t, job) => {
  if (!job.options.files) return { next: null };
  const { items, next } = await pageV1(t, "/v1/files", job.cursor);
  const dls = await idMap("deals", items.map((f) => idOf(f.deal_id)));
  for (const f of items) {
    const dealId = look(dls, idOf(f.deal_id));
    const url = str(f.remote_location) && /^https?:/.test(String(f.remote_location)) ? String(f.remote_location) : str(f.url);
    if (!dealId || !url || f.active_flag === false) { bump(job, "files", "skipped"); continue; }
    const res = await sql`
      INSERT INTO deal_documents (deal_id, title, url, source, external_id, mime_type, created_at)
      VALUES (${dealId}, ${str(f.name) ?? "Archivo"}, ${url}, 'link', ${`pd:${f.id}`}, ${str(f.file_type)}, ${ts(f.add_time) ?? new Date()})
      ON CONFLICT (external_id) WHERE external_id LIKE 'pd:%' DO UPDATE SET title = EXCLUDED.title
      RETURNING (xmax = 0) AS created`;
    bump(job, "files", res[0]?.created ? "created" : "updated");
  }
  return { next };
};

/** Recorrido por fases de cada deal (una llamada por deal; se hace a lotes). */
const flow: Runner = async (t, job) => {
  if (!job.options.flow) return { next: null };
  const offset = Number(job.cursor ?? 0);
  const batch = await sql<{ id: string; pipedrive_id: string; pipeline_id: string; stage_id: string; created_at: Date }[]>`
    SELECT id, pipedrive_id::text, pipeline_id, stage_id, created_at FROM deals
    WHERE pipedrive_id IS NOT NULL AND deleted_at IS NULL
      AND (${job.options.since ?? null}::timestamptz IS NULL OR updated_at >= ${job.options.since ?? null}::timestamptz)
    ORDER BY pipedrive_id OFFSET ${offset} LIMIT 25`;
  for (const d of batch) {
    const changes: { from: string | null; to: string; at: Date }[] = [];
    let start: string | null = null;
    do {
      const p = await pageV1(t, `/v1/deals/${d.pipedrive_id}/flow`, start);
      for (const it of p.items) {
        const data = (it.data ?? {}) as Json;
        if (it.object !== "dealChange" || data.field_key !== "stage_id") continue;
        const at = ts(data.log_time);
        if (at) changes.push({ from: str(data.old_value), to: String(data.new_value), at });
      }
      start = p.next;
    } while (start);
    if (!changes.length) { bump(job, "flow", "skipped"); continue; }
    changes.sort((a, b) => a.at.getTime() - b.at.getTime());
    const stageIds = await idMap("stages", changes.flatMap((c) => [c.from, c.to]));
    await sql.begin(async (tx) => {
      await tx`DELETE FROM deal_stage_history WHERE deal_id = ${d.id}`;
      const first = look(stageIds, changes[0].from);
      if (first) await tx`INSERT INTO deal_stage_history (deal_id, pipeline_id, from_stage_id, to_stage_id, changed_at) VALUES (${d.id}, ${d.pipeline_id}, NULL, ${first}, ${d.created_at})`;
      let prev = first;
      for (const c of changes) {
        const to = look(stageIds, c.to);
        if (!to) continue;
        await tx`INSERT INTO deal_stage_history (deal_id, pipeline_id, from_stage_id, to_stage_id, changed_at) VALUES (${d.id}, ${d.pipeline_id}, ${prev}, ${to}, ${c.at})`;
        prev = to;
      }
    });
    bump(job, "flow", "updated");
  }
  return { next: batch.length === 25 ? String(offset + 25) : null };
};

/** Totales de Pipedrive frente a los del CRM, para validar antes de dejar Pipedrive. */
const verify: Runner = async (t, job) => {
  const rows: { label: string; pipedrive: number; crm: number }[] = [];
  for (const status of ["open", "won", "lost"] as const) {
    const s = await call(t, "/v1/deals/summary", { status });
    const total = Number(((s.data as Json | undefined)?.total_count as number | undefined) ?? 0);
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM deals WHERE pipedrive_id IS NOT NULL AND status = ${status} AND deleted_at IS NULL`;
    rows.push({ label: `Deals ${status === "open" ? "abiertos" : status === "won" ? "ganados" : "perdidos"}`, pipedrive: total, crm: n });
  }
  await sql`UPDATE import_jobs SET verify = ${json(rows)} WHERE id = ${job.id}`;
  for (const r of rows) if (r.pipedrive !== r.crm) warn(job, `${r.label}: ${r.pipedrive} en Pipedrive y ${r.crm} en el CRM.`);
  return { next: null };
};

const STEP_RUNNERS: Record<(typeof STEPS)[number], Runner> = {
  users, activity_types: activityTypesStep, pipelines, stages, fields, organizations, persons, leads, deals, activities, notes, files, flow, verify,
};
