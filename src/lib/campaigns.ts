import { createHmac, timingSafeEqual } from "node:crypto";
import { resolveMx } from "node:dns/promises";
import { z } from "zod";
import { sql, transaction } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor } from "./events";
import { generate, parseJsonReply } from "./ai";
import { findOrCreateOrganization } from "./organizations";
import { createPerson, findPersonByEmail } from "./persons";
import { createDeal } from "./deals";
import { createActivity } from "./activities";
import { notify } from "./notifications";
import { publicBase } from "./email-track";
import { runJob } from "./agent-jobs";
import { zonedToUtc } from "./slots";
import { companyDomainFromEmail, normalizeDomain, parse, text } from "./validation";

// ===========================================================================
// Campañas de outbound (sustituyen a Apollo dentro del CRM).
//
// Contactos (CSV, CRM, API o un agente por MCP) → verificación del email →
// primera línea personalizada (IA) que apruebas por lotes → secuencia desde
// los buzones de outbound, con límite diario, calentamiento y horario →
// respuestas clasificadas (interesado crea el deal, más adelante programa el
// retome, baja sale de todo, fuera de la oficina pausa y retoma).
// ===========================================================================

export type CampaignStatus = "draft" | "active" | "paused" | "finished";
export const CAMPAIGN_STATUS: Record<CampaignStatus, string> = { draft: "Borrador", active: "En marcha", paused: "En pausa", finished: "Terminada" };

export type ContactStatus = "pending" | "invalid" | "ready" | "approved" | "enrolled" | "interested" | "later" | "not_interested"
  | "unsubscribed" | "bounced" | "completed" | "skipped";
export const CONTACT_STATUS: Record<ContactStatus, string> = {
  pending: "Por verificar", invalid: "Email no válido", ready: "Para aprobar", approved: "Aprobado", enrolled: "En la secuencia",
  interested: "Interesado", later: "Más adelante", not_interested: "No interesado", unsubscribed: "Baja", bounced: "Rebotó",
  completed: "Secuencia terminada", skipped: "Ya estaba en la secuencia",
};

export type Campaign = {
  id: string; name: string; status: CampaignStatus; sequence_id: string | null; sequence_name: string | null; mailbox_ids: string[];
  pipeline_id: string | null; owner_id: string | null; owner_name: string | null; target: { sector?: string; size?: string; country?: string; roles?: string };
  require_approval: boolean; send_days: number[]; send_from: number; send_to: number; created_at: Date;
};

export type CampaignStats = {
  contacts: number; pending: number; ready: number; enrolled: number; invalid: number; sent: number; opened: number; clicked: number;
  replied: number; interested: number; meetings: number; deals: number; won: number; won_value: number; unsubscribed: number; bounced: number;
};

const campaignCols = sql`c.id, c.name, c.status, c.sequence_id, s.name AS sequence_name, c.mailbox_ids, c.pipeline_id, c.owner_id, u.name AS owner_name,
  c.target, c.require_approval, c.send_days, c.send_from, c.send_to, c.created_at`;
const campaignFrom = sql`FROM campaigns c LEFT JOIN sequences s ON s.id = c.sequence_id LEFT JOIN users u ON u.id = c.owner_id`;

export async function getCampaign(id: string): Promise<Campaign | null> {
  const [c] = await sql<Campaign[]>`SELECT ${campaignCols} ${campaignFrom} WHERE c.id = ${id}`;
  return c ?? null;
}

export async function campaignStats(ids: string[]): Promise<Map<string, CampaignStats>> {
  if (ids.length === 0) return new Map();
  const rows = await sql<(CampaignStats & { id: string })[]>`
    SELECT c.id,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id) AS contacts,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'pending') AS pending,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'ready') AS ready,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'enrolled') AS enrolled,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'invalid') AS invalid,
      (SELECT count(*)::int FROM emails e WHERE e.campaign_id = c.id AND e.direction = 'out' AND e.status = 'sent') AS sent,
      (SELECT count(*)::int FROM emails e WHERE e.campaign_id = c.id AND e.direction = 'out' AND e.open_count > 0) AS opened,
      (SELECT count(*)::int FROM emails e WHERE e.campaign_id = c.id AND e.direction = 'out' AND e.click_count > 0) AS clicked,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.reply_class IS NOT NULL AND cc.reply_class NOT IN ('fuera_oficina')) AS replied,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'interested') AS interested,
      (SELECT count(DISTINCT a.deal_id)::int FROM campaign_contacts cc JOIN activities a ON a.deal_id = cc.deal_id
         WHERE cc.campaign_id = c.id AND a.type IN (SELECT key FROM activity_types WHERE is_session) AND coalesce(a.outcome, 'held') <> 'no_show') AS meetings,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.deal_id IS NOT NULL) AS deals,
      (SELECT count(*)::int FROM campaign_contacts cc JOIN deals d ON d.id = cc.deal_id AND d.status = 'won' WHERE cc.campaign_id = c.id) AS won,
      (SELECT coalesce(sum(d.value), 0)::float8 FROM campaign_contacts cc JOIN deals d ON d.id = cc.deal_id AND d.status = 'won' WHERE cc.campaign_id = c.id) AS won_value,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'unsubscribed') AS unsubscribed,
      (SELECT count(*)::int FROM campaign_contacts cc WHERE cc.campaign_id = c.id AND cc.status = 'bounced') AS bounced
    FROM campaigns c WHERE c.id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r]));
}

export async function listCampaigns(): Promise<(Campaign & { stats: CampaignStats })[]> {
  const rows = await sql<Campaign[]>`SELECT ${campaignCols} ${campaignFrom} ORDER BY (c.status = 'active') DESC, c.created_at DESC`;
  const stats = await campaignStats(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, stats: stats.get(r.id)! }));
}

const campaignSchema = z.object({
  name: text("El nombre", 120),
  sequence_id: z.string().regex(/^[0-9a-f-]{36}$/i, "Elige la secuencia").optional().or(z.literal("")),
  pipeline_id: z.string().optional(),
  owner_id: z.string().optional(),
  sector: z.string().max(200).optional(), size: z.string().max(100).optional(), country: z.string().max(200).optional(), roles: z.string().max(300).optional(),
  require_approval: z.string().optional(),
  send_from: z.coerce.number().int().min(0).max(23).default(8),
  send_to: z.coerce.number().int().min(1).max(24).default(18),
});

export async function saveCampaign(actor: Actor, id: string | null, data: Record<string, unknown>): Promise<string> {
  const v = parse(campaignSchema, data);
  if (v.send_from >= v.send_to) throw new UserError("La hora de fin del envío tiene que ser posterior a la de inicio.");
  const mailboxes = Object.keys(data).filter((k) => k.startsWith("mb_") && data[k] === "on").map((k) => k.slice(3)).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => data[`day_${d}`] === "on");
  const uuid = (x?: string) => (x && /^[0-9a-f-]{36}$/i.test(x) ? x : null);
  const values = {
    name: v.name, sequence_id: uuid(v.sequence_id), pipeline_id: uuid(v.pipeline_id), owner_id: uuid(v.owner_id),
    target: sql.json({ sector: v.sector?.trim() || undefined, size: v.size?.trim() || undefined, country: v.country?.trim() || undefined, roles: v.roles?.trim() || undefined } as never),
    require_approval: v.require_approval === "on", send_from: v.send_from, send_to: v.send_to,
    send_days: days.length ? days : [1, 2, 3, 4, 5], mailbox_ids: mailboxes,
  };
  if (id) {
    await sql`UPDATE campaigns SET ${sql(values as unknown as Record<string, never>)} WHERE id = ${id}`;
    return id;
  }
  const [row] = await sql<{ id: string }[]>`INSERT INTO campaigns ${sql({ ...values, created_by: actor.id } as unknown as Record<string, never>)} RETURNING id`;
  return row.id;
}

export async function setCampaignStatus(id: string, status: CampaignStatus) {
  const c = await getCampaign(id);
  if (!c) throw new UserError("La campaña ya no existe.");
  if (status === "active") {
    if (!c.sequence_id) throw new UserError("Elige la secuencia de correos antes de ponerla en marcha.");
    const [mb] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM mailbox_connections WHERE id = ANY(${c.mailbox_ids}::uuid[]) AND status = 'active' AND NOT paused`;
    if (mb.n === 0) throw new UserError("Elige al menos un buzón de outbound activo (Ajustes → Correo) antes de ponerla en marcha.");
  }
  await sql`UPDATE campaigns SET status = ${status} WHERE id = ${id}`;
  // Pausar o terminar para lo que estaba en marcha (se retoma al reactivar).
  if (status === "finished") {
    await sql`UPDATE sequence_enrollments SET status = 'stopped', stopped_reason = 'Campaña terminada', finished_at = now(), next_run_at = NULL
              WHERE status = 'active' AND campaign_contact_id IN (SELECT id FROM campaign_contacts WHERE campaign_id = ${id})`;
  }
}

// ---------------------------------------------------------------------------
// Contactos

export type ContactInput = { email: string; first_name?: string; last_name?: string; full_name?: string; company?: string; domain?: string; job_title?: string; phone?: string };
export type AddResult = { added: number; existing: number; skipped: { email: string; reason: string }[] };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Añade contactos (creando el contacto y la empresa si no existen). No repite a nadie en la misma campaña. */
export async function addContacts(actor: Actor, campaignId: string, rows: ContactInput[], source: string): Promise<AddResult> {
  const c = await getCampaign(campaignId);
  if (!c) throw new UserError("La campaña ya no existe.");
  if (c.status === "finished") throw new UserError("La campaña está terminada.");
  if (rows.length > 5000) throw new UserError("Como mucho 5000 contactos de una vez.");
  const out: AddResult = { added: 0, existing: 0, skipped: [] };
  for (const r of rows) {
    const email = String(r.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) { if (out.skipped.length < 100) out.skipped.push({ email: email || "(vacío)", reason: "Email no válido" }); continue; }
    try {
      const added = await transaction(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`person:${email}`}))`;
        let personId = await findPersonByEmail(tx, email);
        if (!personId) {
          const domain = normalizeDomain(r.domain) ?? companyDomainFromEmail(email);
          const org = await findOrCreateOrganization(tx, actor, { name: r.company?.slice(0, 200), domain });
          const [first, ...rest] = (r.full_name ?? "").trim().split(/\s+/);
          personId = await createPerson(actor, {
            first_name: (r.first_name ?? first) || email.split("@")[0], last_name: r.last_name ?? (rest.join(" ") || undefined),
            email, phone: r.phone, organization_id: org?.id, job_title: r.job_title?.slice(0, 200),
          }, {}, tx);
        }
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO campaign_contacts (campaign_id, person_id, email, source) VALUES (${campaignId}, ${personId}, ${email}, ${source})
          ON CONFLICT (campaign_id, person_id) DO NOTHING RETURNING id`;
        return Boolean(row);
      });
      if (added) out.added++; else out.existing++;
    } catch (err) {
      if (out.skipped.length < 100) out.skipped.push({ email, reason: err instanceof UserError ? err.message : "No se pudo añadir" });
    }
  }
  return out;
}

/** Contactos del CRM que encajan con unos filtros (sector, país, tamaño, cargo). */
export async function addFromCrm(actor: Actor, campaignId: string, data: Record<string, unknown>): Promise<AddResult> {
  const like = (k: string) => (String(data[k] ?? "").trim() ? `%${String(data[k]).trim().toLowerCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%` : null);
  const min = Number(data.min_employees) || null, max = Number(data.max_employees) || null;
  const rows = await sql<{ email: string }[]>`
    SELECT DISTINCT ON (p.id) pe.email FROM persons p
    JOIN person_emails pe ON pe.person_id = p.id AND pe.bounced_at IS NULL
    LEFT JOIN person_organizations po ON po.person_id = p.id AND po.status = 'current'
    LEFT JOIN organizations o ON o.id = po.organization_id
    WHERE p.deleted_at IS NULL AND p.unsubscribed_at IS NULL
      AND (${like("industry")}::text IS NULL OR lower(o.industry) LIKE ${like("industry")}::text)
      AND (${like("country")}::text IS NULL OR lower(o.country) LIKE ${like("country")}::text)
      AND (${like("job_title")}::text IS NULL OR lower(po.job_title) LIKE ${like("job_title")}::text)
      AND (${min}::int IS NULL OR o.employee_count >= ${min}::int) AND (${max}::int IS NULL OR o.employee_count <= ${max}::int)
      -- ni clientes ni deals abiertos: el outbound es para cuentas nuevas
      AND NOT EXISTS (SELECT 1 FROM deal_participants dp JOIN deals d ON d.id = dp.deal_id AND d.deleted_at IS NULL
                      WHERE dp.person_id = p.id AND d.status IN ('open', 'won'))
      AND NOT EXISTS (SELECT 1 FROM campaign_contacts cc WHERE cc.campaign_id = ${campaignId} AND cc.person_id = p.id)
    ORDER BY p.id, pe.is_primary DESC
    LIMIT 500`;
  return addContacts(actor, campaignId, rows.map((r) => ({ email: r.email })), "crm");
}

export type CampaignContact = {
  id: string; person_id: string; full_name: string; email: string; job_title: string | null; organization: string | null; status: ContactStatus;
  verify_note: string | null; personal_line: string | null; reply_class: string | null; reply_summary: string | null; deal_id: string | null;
  retake_at: string | null; mailbox_email: string | null; source: string | null; added_at: Date;
};

export async function listContacts(campaignId: string, status?: string | null, limit = 500): Promise<CampaignContact[]> {
  return sql<CampaignContact[]>`
    SELECT cc.id, cc.person_id, p.full_name, cc.email, po.job_title, o.name AS organization, cc.status, cc.verify_note, cc.personal_line,
           cc.reply_class, cc.reply_summary, cc.deal_id, cc.retake_at::text, m.email AS mailbox_email, cc.source, cc.added_at
    FROM campaign_contacts cc JOIN persons p ON p.id = cc.person_id
    LEFT JOIN LATERAL (SELECT job_title, organization_id FROM person_organizations WHERE person_id = p.id AND status = 'current' LIMIT 1) po ON true
    LEFT JOIN organizations o ON o.id = po.organization_id
    LEFT JOIN mailbox_connections m ON m.id = cc.mailbox_id
    WHERE cc.campaign_id = ${campaignId} AND (${status ?? null}::text IS NULL OR cc.status = ${status ?? null}::text)
    ORDER BY cc.updated_at DESC LIMIT ${limit}`;
}

export async function approveContacts(campaignId: string, ids: string[] | "all") {
  if (ids === "all") {
    await sql`UPDATE campaign_contacts SET status = 'approved', updated_at = now() WHERE campaign_id = ${campaignId} AND status = 'ready'`;
  } else if (ids.length) {
    await sql`UPDATE campaign_contacts SET status = 'approved', updated_at = now() WHERE campaign_id = ${campaignId} AND status = 'ready' AND id = ANY(${ids}::uuid[])`;
  }
}

export async function updateLine(campaignId: string, contactId: string, line: string) {
  await sql`UPDATE campaign_contacts SET personal_line = ${line.trim().slice(0, 400) || null}, updated_at = now()
            WHERE id = ${contactId} AND campaign_id = ${campaignId} AND status IN ('ready', 'approved', 'pending')`;
}

export async function removeContact(campaignId: string, contactId: string) {
  const [cc] = await sql<{ enrollment_id: string | null }[]>`DELETE FROM campaign_contacts WHERE id = ${contactId} AND campaign_id = ${campaignId} RETURNING enrollment_id`;
  if (cc?.enrollment_id) {
    await sql`UPDATE sequence_enrollments SET status = 'stopped', stopped_reason = 'Quitado de la campaña', finished_at = now(), next_run_at = NULL
              WHERE id = ${cc.enrollment_id} AND status = 'active'`;
  }
}

// ---------------------------------------------------------------------------
// Verificación del email

const ROLE = /^(info|admin|contact|contacto|hola|hello|ventas|sales|soporte|support|noreply|no-reply|rrhh|hr|marketing|office|oficina|facturacion|billing|team|equipo)@/i;
const DISPOSABLE = new Set(["mailinator.com", "10minutemail.com", "guerrillamail.com", "tempmail.com", "yopmail.com", "trashmail.com", "getnada.com", "sharklasers.com", "temp-mail.org"]);

export async function verifyEmail(email: string, cache = new Map<string, boolean | null>()): Promise<{ ok: boolean; note: string | null }> {
  if (!EMAIL.test(email)) return { ok: false, note: "Formato no válido" };
  const domain = email.split("@")[1].toLowerCase();
  if (DISPOSABLE.has(domain)) return { ok: false, note: "Dirección temporal (desechable)" };
  const [p] = await sql<{ unsubscribed: boolean; bounced: boolean }[]>`
    SELECT p.unsubscribed_at IS NOT NULL AS unsubscribed, pe.bounced_at IS NOT NULL AS bounced
    FROM person_emails pe JOIN persons p ON p.id = pe.person_id WHERE lower(pe.email) = ${email} LIMIT 1`;
  if (p?.unsubscribed) return { ok: false, note: "Se dio de baja de las comunicaciones" };
  if (p?.bounced) return { ok: false, note: "Ya rebotó antes" };
  if (process.env.EMAIL_VERIFY_DNS !== "off") {
    if (!cache.has(domain)) {
      try {
        const mx = await Promise.race([resolveMx(domain), new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), 5000))]);
        cache.set(domain, mx.length > 0);
      } catch (err) {
        const code = (err as { code?: string }).code;
        // Solo cuenta como no válido si el dominio no existe o no tiene correo; un fallo de red no descarta a nadie.
        cache.set(domain, code === "ENOTFOUND" || code === "ENODATA" ? false : null);
      }
    }
    if (cache.get(domain) === false) return { ok: false, note: "El dominio no recibe correo" };
  }
  return { ok: true, note: ROLE.test(email) ? "Dirección genérica: mejor una persona concreta" : null };
}

// ---------------------------------------------------------------------------
// Preparar (verificar + primera línea) e inscribir en la secuencia

async function personalLine(contactId: string): Promise<string | null> {
  const [f] = await sql<{ full_name: string; job_title: string | null; organization: string | null; industry: string | null; description: string | null;
                          city: string | null; employee_count: number | null; target: Campaign["target"] }[]>`
    SELECT p.full_name, po.job_title, o.name AS organization, o.industry, o.description, o.city, o.employee_count, c.target
    FROM campaign_contacts cc JOIN campaigns c ON c.id = cc.campaign_id JOIN persons p ON p.id = cc.person_id
    LEFT JOIN LATERAL (SELECT job_title, organization_id FROM person_organizations WHERE person_id = p.id AND status = 'current' LIMIT 1) po ON true
    LEFT JOIN organizations o ON o.id = po.organization_id
    WHERE cc.id = ${contactId}`;
  if (!f) return null;
  const j = parseJsonReply<{ linea?: string }>(await generate("icebreaker", {
    contacto: { nombre: f.full_name, cargo: f.job_title }, empresa: { nombre: f.organization, sector: f.industry, a_que_se_dedica: f.description, ciudad: f.city, empleados: f.employee_count },
    a_quien_buscamos: f.target,
  }, { maxTokens: 200 }));
  return j?.linea?.trim().slice(0, 400) || null;
}

/** Elige el buzón con menos contactos de esta campaña (reparto entre dominios). */
async function pickMailbox(c: Campaign): Promise<{ id: string; user_id: string } | null> {
  const [m] = await sql<{ id: string; user_id: string }[]>`
    SELECT m.id, m.user_id FROM mailbox_connections m
    WHERE m.id = ANY(${c.mailbox_ids}::uuid[]) AND m.status = 'active' AND NOT m.paused AND m.purpose = 'outbound'
    ORDER BY (SELECT count(*) FROM campaign_contacts cc WHERE cc.campaign_id = ${c.id} AND cc.mailbox_id = m.id), m.created_at
    LIMIT 1`;
  return m ?? null;
}

export async function enrollApproved(c: Campaign, limit = 100): Promise<number> {
  if (c.status !== "active" || !c.sequence_id) return 0;
  const [first] = await sql<{ delay_days: number }[]>`SELECT delay_days FROM sequence_steps WHERE sequence_id = ${c.sequence_id} ORDER BY position LIMIT 1`;
  if (!first) return 0;
  const rows = await sql<{ id: string; person_id: string }[]>`
    SELECT id, person_id FROM campaign_contacts WHERE campaign_id = ${c.id} AND status = 'approved' ORDER BY added_at LIMIT ${limit}`;
  let n = 0;
  for (const r of rows) {
    const mb = await pickMailbox(c);
    if (!mb) break;
    const [e] = await sql<{ id: string }[]>`
      INSERT INTO sequence_enrollments (sequence_id, deal_id, person_id, user_id, mailbox_id, campaign_contact_id, next_step, next_run_at, enrolled_by)
      VALUES (${c.sequence_id}, NULL, ${r.person_id}, ${mb.user_id}, ${mb.id}, ${r.id}, 0, now() + make_interval(days => ${first.delay_days}), ${c.owner_id})
      ON CONFLICT (sequence_id, person_id) WHERE status = 'active' DO NOTHING RETURNING id`;
    await sql`UPDATE campaign_contacts SET status = ${e ? "enrolled" : "skipped"}, enrollment_id = ${e?.id ?? null}, mailbox_id = ${mb.id}, updated_at = now()
              WHERE id = ${r.id}`;
    if (e) n++;
  }
  return n;
}

/** Trabajo: verificar, escribir la primera línea e inscribir lo aprobado. */
export async function runCampaignPrepare(): Promise<string | number | null> {
  return runJob("campaign_prepare", async () => {
    const campaigns = await sql<Campaign[]>`SELECT ${campaignCols} ${campaignFrom} WHERE c.status IN ('draft', 'active', 'paused')`;
    const cache = new Map<string, boolean | null>();
    let done = 0;
    for (const c of campaigns) {
      const pending = await sql<{ id: string; email: string }[]>`
        SELECT id, email FROM campaign_contacts WHERE campaign_id = ${c.id} AND status = 'pending' ORDER BY added_at LIMIT 40`;
      for (const p of pending) {
        const v = await verifyEmail(p.email, cache);
        if (!v.ok) {
          await sql`UPDATE campaign_contacts SET status = 'invalid', verify_note = ${v.note}, updated_at = now() WHERE id = ${p.id}`;
          continue;
        }
        const line = await personalLine(p.id).catch(() => null);
        await sql`UPDATE campaign_contacts SET status = ${c.require_approval ? "ready" : "approved"}, verify_note = ${v.note},
                         personal_line = coalesce(personal_line, ${line}), updated_at = now() WHERE id = ${p.id}`;
        done++;
      }
      done += await enrollApproved(c);
    }
    return done;
  });
}

// ---------------------------------------------------------------------------
// Envío: horario, límites y pie de baja (lo usa el motor de secuencias)

export type SendGate = { ok: true } | { ok: false; retryAt: Date; reason: string };

const TZ = () => process.env.TZ || "Europe/Madrid";
function localParts(d: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), wd: ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[p.weekday as string] ?? 1 };
}

/** Siguiente momento dentro del horario de envío de la campaña (ahora, si ya lo está). */
export function nextSendWindow(c: Pick<Campaign, "send_days" | "send_from" | "send_to">, now = new Date()): Date {
  for (let i = 0; i < 8; i++) {
    const day = new Date(now.getTime() + i * 86400000);
    const p = localParts(day);
    if (!c.send_days.includes(p.wd)) continue;
    if (i === 0 && p.h >= c.send_from && p.h < c.send_to) return now;
    const start = zonedToUtc(p.y, p.m, p.d, c.send_from, Math.floor(Math.random() * 40), TZ());
    if (start > now) return start;
  }
  return new Date(now.getTime() + 86400000);
}

const SECRET = () => process.env.TOKEN_ENCRYPTION_KEY || process.env.CRON_SECRET || "crm";
const sign = (personId: string) => createHmac("sha256", SECRET()).update(`baja:${personId}`).digest("base64url").slice(0, 22);
export const unsubscribeToken = (personId: string) => `${personId}.${sign(personId)}`;
export function personFromToken(token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(id));
  return a.length === b.length && timingSafeEqual(a, b) ? id : null;
}
export const unsubscribeUrl = (personId: string) => `${publicBase() ?? ""}/u/${unsubscribeToken(personId)}`;
export const unsubscribeFooter = (personId: string) =>
  `\n\n—\nSi prefieres no recibir más correos como este, puedes darte de baja aquí: ${unsubscribeUrl(personId)}`;

export async function unsubscribe(personId: string, how: string) {
  const [p] = await sql<{ id: string }[]>`UPDATE persons SET unsubscribed_at = coalesce(unsubscribed_at, now()) WHERE id = ${personId} RETURNING id`;
  if (!p) return false;
  await sql`UPDATE campaign_contacts SET status = 'unsubscribed', updated_at = now()
            WHERE person_id = ${personId} AND status NOT IN ('interested', 'unsubscribed')`;
  await sql`UPDATE sequence_enrollments SET status = 'stopped', stopped_reason = 'Se dio de baja', finished_at = now(), next_run_at = NULL
            WHERE person_id = ${personId} AND status = 'active'`;
  await recordEvent(sql, { type: "integration", id: null }, "person", personId, "person.unsubscribed", { how });
  return true;
}

// ---------------------------------------------------------------------------
// Respuestas

export type ReplyClass = "interesado" | "mas_adelante" | "no_interesado" | "baja" | "fuera_oficina" | "otro";
export const REPLY_LABEL: Record<ReplyClass, string> = {
  interesado: "Interesado", mas_adelante: "Más adelante", no_interesado: "No interesado", baja: "Baja", fuera_oficina: "Fuera de la oficina", otro: "Otra respuesta",
};

/** Clasificación sin IA, por palabras clave. */
export function classifyByRules(text: string): { clase: ReplyClass; dias: number | null } {
  const t = text.toLowerCase();
  if (/fuera de la oficina|out of office|vacaciones|respuesta autom[aá]tica|automatic reply|estar[eé] ausente|ausente hasta/.test(t)) return { clase: "fuera_oficina", dias: 7 };
  if (/darme de baja|dadme de baja|\bbaja\b|unsubscribe|no me escrib|no nos escrib|elimin[ae]d? mis datos|remove me/.test(t)) return { clase: "baja", dias: null };
  if (/no (nos|me) interesa|not interested|no,? gracias|no estamos interesados/.test(t)) return { clase: "no_interesado", dias: null };
  if (/m[aá]s adelante|pr[oó]ximo (trimestre|a[nñ]o|mes|semestre)|ahora no|en unos meses|later/.test(t)) return { clase: "mas_adelante", dias: 90 };
  if (/interesa|hablamos|llamada|reuni[oó]n|cu[aá]ndo|agenda|demo|precio|cu[eé]ntame|me encaj|adelante/.test(t)) return { clase: "interesado", dias: null };
  return { clase: "otro", dias: null };
}

/** Trabajo: clasifica las respuestas de los contactos de campaña y actúa. */
export async function runCampaignReplies(): Promise<string | number | null> {
  return runJob("campaign_replies", async () => {
    const rows = await sql<{ cc_id: string; person_id: string; full_name: string; campaign_id: string; campaign: string; pipeline_id: string | null;
                             owner_id: string | null; mailbox_user: string | null; organization_id: string | null; organization: string | null;
                             enrollment_id: string | null; deal_id: string | null; email_id: string; subject: string; body: string }[]>`
      SELECT cc.id AS cc_id, cc.person_id, p.full_name, c.id AS campaign_id, c.name AS campaign, c.pipeline_id, c.owner_id, m.user_id AS mailbox_user,
             po.organization_id, o.name AS organization, cc.enrollment_id, cc.deal_id, e.id AS email_id, e.subject, e.body
      FROM campaign_contacts cc
      JOIN campaigns c ON c.id = cc.campaign_id
      JOIN persons p ON p.id = cc.person_id
      LEFT JOIN mailbox_connections m ON m.id = cc.mailbox_id
      LEFT JOIN LATERAL (SELECT organization_id FROM person_organizations WHERE person_id = p.id AND status = 'current' LIMIT 1) po ON true
      LEFT JOIN organizations o ON o.id = po.organization_id
      JOIN LATERAL (SELECT id, subject, body FROM emails e WHERE e.direction = 'in' AND e.person_id = cc.person_id AND e.reply_class IS NULL
                      AND e.sent_at > cc.added_at ORDER BY e.sent_at LIMIT 1) e ON true
      WHERE cc.status IN ('enrolled', 'completed', 'later', 'approved')
      LIMIT 30`;
    for (const r of rows) {
      const text = `${r.subject}\n${r.body}`.slice(0, 4000);
      const ai = parseJsonReply<{ clase?: ReplyClass; retomar_en_dias?: number | null; resumen?: string }>(
        await generate("classify_reply", { campana: r.campaign, contacto: r.full_name, respuesta: text }, { maxTokens: 200 }));
      const rules = classifyByRules(text);
      const clase: ReplyClass = ai?.clase && ai.clase in REPLY_LABEL ? ai.clase : rules.clase;
      const days = Math.max(1, Math.min(365, Number(ai?.retomar_en_dias ?? rules.dias ?? (clase === "fuera_oficina" ? 7 : 90)) || 7));
      const summary = (ai?.resumen?.trim() || text.split("\n").find((l) => l.trim().length > 3)?.trim() || "").slice(0, 300);
      const owner = r.mailbox_user ?? r.owner_id;
      await sql`UPDATE emails SET reply_class = ${clase === "fuera_oficina" ? "ooo" : clase} WHERE id = ${r.email_id}`;
      await sql`UPDATE campaign_contacts SET reply_class = ${clase}, reply_summary = ${summary}, last_reply_id = ${r.email_id}, updated_at = now() WHERE id = ${r.cc_id}`;
      if (clase === "fuera_oficina") {
        // Pausa y retoma: la secuencia sigue cuando vuelva.
        await sql`UPDATE sequence_enrollments SET status = 'active', stopped_reason = NULL, finished_at = NULL,
                         next_run_at = greatest(coalesce(next_run_at, now()), now() + make_interval(days => ${days}))
                  WHERE id = ${r.enrollment_id} AND (status = 'active' OR (status = 'stopped' AND stopped_reason = 'Respondió'))`;
        continue;
      }
      if (clase === "baja") { await unsubscribe(r.person_id, "respuesta"); continue; }
      if (clase === "no_interesado") { await sql`UPDATE campaign_contacts SET status = 'not_interested' WHERE id = ${r.cc_id}`; continue; }
      if (clase === "mas_adelante") {
        const at = new Date(Date.now() + days * 86400000);
        await sql`UPDATE campaign_contacts SET status = 'later', retake_at = ${at.toISOString().slice(0, 10)} WHERE id = ${r.cc_id}`;
        await createActivity({ type: "system", id: null }, {
          type: "task", subject: `Retomar con ${r.full_name} (campaña «${r.campaign}»)`, note: `Dijo: ${summary}`, due_at: at.toISOString(),
          person_id: r.person_id, organization_id: r.organization_id ?? undefined, owner_id: owner ?? undefined,
        });
        continue;
      }
      // Interesado (u otra respuesta que hay que leer): deal en el pipeline de la campaña y aviso.
      if (clase === "interesado") {
        let dealId = r.deal_id;
        if (!dealId) {
          const [pl] = r.pipeline_id ? [{ id: r.pipeline_id }]
            : await sql<{ id: string }[]>`SELECT id FROM pipelines WHERE is_active ORDER BY (lower(name) = 'outbound') DESC, position LIMIT 1`;
          dealId = await createDeal({ type: "system", id: null }, {
            title: `${r.organization ?? r.full_name} — outbound`.slice(0, 300), organization_id: r.organization_id ?? undefined,
            person_id: r.person_id, pipeline_id: pl.id, owner_id: owner ?? undefined, source: `Outbound: ${r.campaign}`.slice(0, 100),
          });
          await sql`UPDATE campaign_contacts SET deal_id = ${dealId} WHERE id = ${r.cc_id}`;
          await sql`UPDATE emails SET deal_id = ${dealId} WHERE id = ${r.email_id}`;
        }
        await sql`UPDATE campaign_contacts SET status = 'interested' WHERE id = ${r.cc_id}`;
        await recordEvent(sql, { type: "system", id: null }, "deal", dealId, "campaign.interested", { campaign: r.campaign, summary });
        await createActivity({ type: "system", id: null }, {
          type: "task", subject: `Responder a ${r.full_name}: interesado (${r.campaign})`, note: summary, due_at: new Date().toISOString(),
          deal_id: dealId, person_id: r.person_id, owner_id: owner ?? undefined,
        });
        if (owner) await notify(sql, { userId: owner, kind: "campaign", title: `¡${r.full_name} está interesado! (${r.campaign})`, body: summary, link: `/deals/${dealId}` });
      } else if (owner) {
        await createActivity({ type: "system", id: null }, {
          type: "task", subject: `Leer la respuesta de ${r.full_name} (${r.campaign})`, note: summary, due_at: new Date().toISOString(),
          person_id: r.person_id, owner_id: owner,
        });
      }
    }
    return rows.length;
  });
}
