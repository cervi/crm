import { z } from "zod";
import { sql, json, transaction, type Db } from "./db";
import { recordEvent, type Actor } from "./events";
import { UserError } from "./errors";
import { findOrCreateOrganization } from "./organizations";
import { createPerson, findPersonByEmail } from "./persons";
import { createDeal } from "./deals";
import { checkbox, companyDomainFromEmail, id, normalizeDomain, optId, optMoney, optText, optional, parse, text } from "./validation";

export type LeadListRow = {
  id: string;
  title: string;
  status: "open" | "converted" | "archived";
  source: string | null;
  source_detail: string | null;
  funnel_stage: "tofu" | "mofu" | "bofu" | null;
  person_id: string | null;
  person_name: string | null;
  email: string | null;
  organization_id: string | null;
  organization_name: string | null;
  owner_name: string | null;
  converted_deal_id: string | null;
  tags: string[];
  created_at: Date;
  last_activity_at: Date;
};

export async function listLeads(f: { q?: string; status?: string; source?: string; funnel?: string } = {}) {
  const q = (f.q ?? "").trim().toLowerCase();
  const like = `%${q}%`;
  return sql<LeadListRow[]>`
    SELECT l.id, l.title, l.status, l.source, l.source_detail, l.funnel_stage, l.person_id,
           p.full_name AS person_name,
           (SELECT email FROM person_emails e WHERE e.person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           l.organization_id, o.name AS organization_name, u.name AS owner_name, l.converted_deal_id,
           coalesce((SELECT array_agg(t.name ORDER BY t.name) FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
                     WHERE lt.lead_id = l.id), '{}') AS tags,
           l.created_at,
           greatest(l.updated_at, coalesce((SELECT max(occurred_at) FROM events ev
                     WHERE ev.entity_type = 'lead' AND ev.entity_id = l.id), l.updated_at)) AS last_activity_at
    FROM leads l
    LEFT JOIN persons p ON p.id = l.person_id
    LEFT JOIN organizations o ON o.id = l.organization_id
    LEFT JOIN users u ON u.id = l.owner_id
    WHERE l.deleted_at IS NULL
      AND (${f.status || "open"} = 'all' OR l.status = ${f.status || "open"})
      AND (${f.source || null}::text IS NULL OR l.source = ${f.source || null}::text)
      AND (${f.funnel || null}::text IS NULL OR l.funnel_stage = ${f.funnel || null}::text)
      AND (${q === ""} OR lower(l.title) LIKE ${like} OR lower(coalesce(p.full_name, '')) LIKE ${like}
           OR lower(coalesce(o.name, '')) LIKE ${like}
           OR EXISTS (SELECT 1 FROM person_emails e WHERE e.person_id = p.id AND lower(e.email) LIKE ${like}))
    ORDER BY last_activity_at DESC
    LIMIT 500`;
}

export async function leadSources(): Promise<string[]> {
  const rows = await sql<{ source: string }[]>`
    SELECT DISTINCT source FROM leads WHERE source IS NOT NULL AND deleted_at IS NULL ORDER BY source`;
  return rows.map((r) => r.source);
}

export async function getLead(leadId: string) {
  const [lead] = await sql<(LeadListRow & { custom: Record<string, unknown>; converted_at: Date | null;
                             deal_title: string | null; owner_id: string | null })[]>`
    SELECT l.id, l.title, l.status, l.source, l.source_detail, l.funnel_stage, l.person_id,
           p.full_name AS person_name,
           (SELECT email FROM person_emails e WHERE e.person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           l.organization_id, o.name AS organization_name, l.owner_id, u.name AS owner_name,
           l.converted_deal_id, d.title AS deal_title, l.converted_at, l.custom,
           coalesce((SELECT array_agg(t.name ORDER BY t.name) FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id
                     WHERE lt.lead_id = l.id), '{}') AS tags,
           l.created_at, l.updated_at AS last_activity_at
    FROM leads l
    LEFT JOIN persons p ON p.id = l.person_id
    LEFT JOIN organizations o ON o.id = l.organization_id
    LEFT JOIN users u ON u.id = l.owner_id
    LEFT JOIN deals d ON d.id = l.converted_deal_id
    WHERE l.id = ${leadId} AND l.deleted_at IS NULL`;
  return lead ?? null;
}

/** Leads (de cualquier estado) de un contacto: su recorrido antes de ser deal. */
export async function leadsOfPerson(personId: string) {
  return sql<{ id: string; title: string; status: string; source: string | null; source_detail: string | null;
               funnel_stage: string | null; created_at: Date }[]>`
    SELECT id, title, status, source, source_detail, funnel_stage, created_at
    FROM leads WHERE person_id = ${personId} AND deleted_at IS NULL ORDER BY created_at DESC`;
}

// ---------------------------------------------------------------------------
// Entrada de leads (formularios, webinars, integraciones)

const FUNNEL_ORDER = { tofu: 1, mofu: 2, bofu: 3 } as const;
const funnel = z.enum(["tofu", "mofu", "bofu"]);

export const inboundSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Email no válido")),
  first_name: optText(100),
  last_name: optText(100),
  full_name: optText(200),
  phone: optText(50),
  company: optText(200),
  domain: optText(253),
  job_title: optText(200),
  source: text("El origen (source)", 100),
  source_detail: optText(300),
  funnel_stage: optional(funnel),
  tags: optional(z.array(z.string().trim().min(1).max(60)).max(20)),
  consent: optional(z.boolean()),
  intent: optional(z.enum(["lead", "demo_request"])),
  message: optText(5000),
  pipeline_id: optId,
  value: optMoney,
});
export type InboundLead = z.infer<typeof inboundSchema>;

export type IngestResult = {
  person_id: string;
  organization_id: string | null;
  lead_id: string;
  deal_id: string | null;
  created: { person: boolean; organization: boolean; lead: boolean; deal: boolean };
};

function splitName(v: InboundLead) {
  if (v.first_name || v.last_name) return { first: v.first_name, last: v.last_name };
  if (v.full_name) {
    const [first, ...rest] = v.full_name.split(/\s+/);
    return { first, last: rest.join(" ") || undefined };
  }
  return { first: v.email.split("@")[0], last: undefined };
}

async function resolvePipeline(db: Db, pipelineId?: string): Promise<string> {
  if (pipelineId) {
    const [p] = await db<{ id: string }[]>`SELECT id FROM pipelines WHERE id = ${pipelineId} AND is_active`;
    if (!p) throw new UserError("pipeline_id no válido.");
    return p.id;
  }
  const [p] = await db<{ id: string }[]>`
    SELECT id FROM pipelines WHERE is_active ORDER BY (lower(name) = 'inbound') DESC, position LIMIT 1`;
  if (!p) throw new UserError("No hay ningún pipeline activo.");
  return p.id;
}

async function attachTags(db: Db, leadId: string, personId: string, tags: string[]) {
  for (const name of tags) {
    const [tag] = await db<{ id: string }[]>`
      INSERT INTO tags (name) VALUES (${name}) ON CONFLICT (lower(name)) DO UPDATE SET name = tags.name RETURNING id`;
    await db`INSERT INTO lead_tags (lead_id, tag_id) VALUES (${leadId}, ${tag.id}) ON CONFLICT DO NOTHING`;
    await db`INSERT INTO person_tags (person_id, tag_id) VALUES (${personId}, ${tag.id}) ON CONFLICT DO NOTHING`;
  }
}

/**
 * Registra una entrada desde un formulario. Deduplica el contacto por email y
 * la empresa por dominio, reutiliza el lead abierto (subiendo su etapa de
 * funnel si procede) y, si es una solicitud de demo, crea el deal en el
 * pipeline de inbound con una tarea para contactar.
 */
export async function ingestLead(actor: Actor, data: unknown): Promise<IngestResult> {
  const v = parse(inboundSchema, data);
  return transaction(async (tx) => {
    const created = { person: false, organization: false, lead: false, deal: false };
    const domain = normalizeDomain(v.domain) ?? companyDomainFromEmail(v.email);

    // Dos envíos simultáneos del mismo formulario (doble clic, reintento de un
    // webhook) se procesan uno detrás de otro en vez de chocar al crear.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`person:${v.email}`}))`;
    const orgKey = domain ?? v.company?.trim().toLowerCase();
    if (orgKey) await tx`SELECT pg_advisory_xact_lock(hashtext(${`org:${orgKey}`}))`;

    // Empresa: dominio explícito o el del email (si no es de correo personal).
    const org = await findOrCreateOrganization(tx, actor, { name: v.company, domain });
    created.organization = org?.created ?? false;

    // Contacto: por email.
    let personId = await findPersonByEmail(tx, v.email);
    if (!personId) {
      const { first, last } = splitName(v);
      personId = await createPerson(actor, {
        first_name: first, last_name: last, email: v.email, phone: v.phone,
        organization_id: org?.id, job_title: v.job_title, marketing_consent: v.consent ? "on" : undefined,
      }, {}, tx);
      created.person = true;
    } else {
      if (v.phone) {
        await tx`INSERT INTO person_phones (person_id, phone, is_primary)
                 SELECT ${personId}, ${v.phone}, NOT EXISTS (SELECT 1 FROM person_phones WHERE person_id = ${personId})
                 WHERE NOT EXISTS (SELECT 1 FROM person_phones WHERE person_id = ${personId} AND phone = ${v.phone})`;
      }
      if (org) {
        await tx`INSERT INTO person_organizations (person_id, organization_id, job_title, started_at)
                 SELECT ${personId}, ${org.id}, ${v.job_title ?? null}, current_date
                 WHERE NOT EXISTS (SELECT 1 FROM person_organizations
                                   WHERE person_id = ${personId} AND organization_id = ${org.id} AND status = 'current')`;
      }
      if (v.consent) {
        await tx`UPDATE persons SET marketing_consent = true, marketing_consent_at = coalesce(marketing_consent_at, now())
                 WHERE id = ${personId}`;
      }
    }

    // Lead: se reutiliza el abierto del contacto.
    const [open] = await tx<{ id: string; funnel_stage: keyof typeof FUNNEL_ORDER | null }[]>`
      SELECT id, funnel_stage FROM leads WHERE person_id = ${personId} AND status = 'open' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`;
    let leadId: string;
    const stage = v.funnel_stage ?? (v.intent === "demo_request" ? "bofu" : null);
    if (open) {
      leadId = open.id;
      const higher = stage && (!open.funnel_stage || FUNNEL_ORDER[stage] > FUNNEL_ORDER[open.funnel_stage]);
      if (higher) await tx`UPDATE leads SET funnel_stage = ${stage} WHERE id = ${leadId}`;
      if (org) await tx`UPDATE leads SET organization_id = coalesce(organization_id, ${org.id}) WHERE id = ${leadId}`;
    } else {
      const [p] = await tx<{ full_name: string }[]>`SELECT full_name FROM persons WHERE id = ${personId}`;
      const [lead] = await tx<{ id: string }[]>`
        INSERT INTO leads ${tx({
          title: `${p.full_name} — ${v.source_detail ?? v.source}`.slice(0, 300),
          person_id: personId,
          organization_id: org?.id ?? null,
          source: v.source,
          source_detail: v.source_detail ?? null,
          funnel_stage: stage,
          custom: json({}),
        })} RETURNING id`;
      leadId = lead.id;
      created.lead = true;
      await recordEvent(tx, actor, "lead", leadId, "lead.created", { source: v.source, source_detail: v.source_detail ?? null });
    }
    await recordEvent(tx, actor, "lead", leadId, "lead.form_submitted", {
      source: v.source, source_detail: v.source_detail ?? null, intent: v.intent ?? "lead", funnel_stage: stage,
    });
    if (v.tags?.length) await attachTags(tx, leadId, personId, v.tags);
    if (v.message) {
      await tx`INSERT INTO notes (content, lead_id, person_id) VALUES (${v.message}, ${leadId}, ${personId})`;
    }

    // Solicitud de demo/presupuesto: deal en el pipeline de inbound.
    let dealId: string | null = null;
    if (v.intent === "demo_request") {
      const pipelineId = await resolvePipeline(tx, v.pipeline_id);
      const [existing] = await tx<{ id: string }[]>`
        SELECT d.id FROM deals d JOIN deal_participants dp ON dp.deal_id = d.id
        WHERE dp.person_id = ${personId} AND d.pipeline_id = ${pipelineId} AND d.status = 'open' AND d.deleted_at IS NULL
        ORDER BY d.created_at DESC LIMIT 1`;
      if (existing) {
        dealId = existing.id;
      } else {
        const [o] = org ? await tx<{ name: string }[]>`SELECT name FROM organizations WHERE id = ${org.id}` : [];
        const [p] = await tx<{ full_name: string }[]>`SELECT full_name FROM persons WHERE id = ${personId}`;
        dealId = await createDeal(actor, {
          title: `${o?.name ?? p.full_name} — ${v.source_detail ?? "solicitud de demo"}`.slice(0, 300),
          organization_id: org?.id, person_id: personId, pipeline_id: pipelineId, value: v.value,
          source: v.source,
        }, {}, { db: tx, leadId });
        created.deal = true;
      }
      const [converted] = await tx<{ id: string }[]>`
        UPDATE leads SET status = 'converted', converted_deal_id = ${dealId}, converted_at = now()
        WHERE id = ${leadId} AND status = 'open' RETURNING id`;
      if (converted) await recordEvent(tx, actor, "lead", leadId, "lead.converted", { deal_id: dealId });
      await tx`
        INSERT INTO activities (type, subject, note, due_at, deal_id, person_id, organization_id, owner_id)
        SELECT 'task', 'Contactar: nueva solicitud de demo', ${v.message ?? null}, now(), ${dealId}, ${personId},
               organization_id, owner_id
        FROM deals WHERE id = ${dealId}`;
    }

    return { person_id: personId, organization_id: org?.id ?? null, lead_id: leadId, deal_id: dealId, created };
  });
}

// ---------------------------------------------------------------------------
// Gestión manual

export async function convertLead(actor: Actor, leadId: string, data: unknown): Promise<string> {
  const v = parse(z.object({ pipeline_id: id, title: text("El título", 300), value: optMoney, owner_id: optId }), data);
  return transaction(async (tx) => {
    const [lead] = await tx<{ status: string; person_id: string | null; organization_id: string | null; source: string | null }[]>`
      SELECT status, person_id, organization_id, source FROM leads WHERE id = ${leadId} FOR UPDATE`;
    if (!lead) throw new UserError("El lead no existe.");
    if (lead.status !== "open") throw new UserError("El lead ya no está abierto.");
    const dealId = await createDeal(actor, {
      title: v.title, organization_id: lead.organization_id ?? undefined, person_id: lead.person_id ?? undefined,
      pipeline_id: v.pipeline_id, value: v.value, owner_id: v.owner_id, source: lead.source ?? undefined,
    }, {}, { db: tx, leadId });
    await tx`UPDATE leads SET status = 'converted', converted_deal_id = ${dealId}, converted_at = now() WHERE id = ${leadId}`;
    await recordEvent(tx, actor, "lead", leadId, "lead.converted", { deal_id: dealId });
    return dealId;
  });
}

export async function archiveLead(actor: Actor, leadId: string) {
  await transaction(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      UPDATE leads SET status = 'archived' WHERE id = ${leadId} AND status = 'open' RETURNING id`;
    if (row) await recordEvent(tx, actor, "lead", leadId, "lead.archived", {});
  });
}

export async function updateLeadFunnel(actor: Actor, leadId: string, data: unknown) {
  const v = parse(z.object({ funnel_stage: optional(funnel), owner_id: optId, unarchive: checkbox }), data);
  await sql`UPDATE leads SET funnel_stage = ${v.funnel_stage ?? null}, owner_id = ${v.owner_id ?? null},
                   status = CASE WHEN ${v.unarchive} AND status = 'archived' THEN 'open' ELSE status END
            WHERE id = ${leadId}`;
  await recordEvent(sql, actor, "lead", leadId, "lead.updated", { funnel_stage: v.funnel_stage ?? null });
}
