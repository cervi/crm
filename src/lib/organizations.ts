import { z } from "zod";
import { sql, json, transaction, type Db } from "./db";
import { recordEvent, type Actor } from "./events";
import { normalizeDomain, optId, optText, optional, parse, text } from "./validation";
import { UserError } from "./errors";

export type OrganizationListRow = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  owner_name: string | null;
  contacts: number;
  open_deals: number;
  open_value: string;
};

export async function listOrganizations({ q = "", limit = 200 } = {}) {
  const like = `%${q.trim().toLowerCase()}%`;
  return sql<OrganizationListRow[]>`
    SELECT o.id, o.name, o.domain, o.industry, u.name AS owner_name,
           (SELECT count(*)::int FROM person_organizations po
             WHERE po.organization_id = o.id AND po.status = 'current') AS contacts,
           (SELECT count(*)::int FROM deals d
             WHERE d.organization_id = o.id AND d.status = 'open' AND d.deleted_at IS NULL) AS open_deals,
           (SELECT coalesce(sum(d.value), 0)::text FROM deals d
             WHERE d.organization_id = o.id AND d.status = 'open' AND d.deleted_at IS NULL) AS open_value
    FROM organizations o LEFT JOIN users u ON u.id = o.owner_id
    WHERE o.deleted_at IS NULL
      AND (${q.trim() === ""} OR lower(o.name) LIKE ${like} OR lower(coalesce(o.domain, '')) LIKE ${like})
    ORDER BY lower(o.name)
    LIMIT ${limit}`;
}

export type Organization = {
  id: string;
  name: string;
  domain: string | null;
  website: string | null;
  industry: string | null;
  employee_count: number | null;
  country: string | null;
  city: string | null;
  address: string | null;
  owner_id: string | null;
  owner_name: string | null;
  custom: Record<string, unknown>;
  created_at: Date;
};

export async function getOrganization(id: string, db: Db = sql): Promise<Organization | null> {
  const [org] = await db<Organization[]>`
    SELECT o.id, o.name, o.domain, o.website, o.industry, o.employee_count, o.country, o.city,
           o.address, o.owner_id, u.name AS owner_name, o.custom, o.created_at
    FROM organizations o LEFT JOIN users u ON u.id = o.owner_id
    WHERE o.id = ${id} AND o.deleted_at IS NULL`;
  return org ?? null;
}

export type OrgContact = {
  person_id: string;
  full_name: string;
  job_title: string | null;
  status: "current" | "former";
  email: string | null;
  started_at: string | null;
  ended_at: string | null;
};

export async function organizationContacts(id: string) {
  return sql<OrgContact[]>`
    SELECT p.id AS person_id, p.full_name, po.job_title, po.status,
           (SELECT email FROM person_emails pe WHERE pe.person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           po.started_at::text, po.ended_at::text
    FROM person_organizations po JOIN persons p ON p.id = po.person_id
    WHERE po.organization_id = ${id} AND p.deleted_at IS NULL
    ORDER BY po.status, p.full_name`;
}

const orgSchema = z.object({
  name: text("El nombre"),
  domain: optText(253),
  website: optText(500),
  industry: optText(200),
  employee_count: optional(z.coerce.number().int().min(0, "Número de empleados no válido")),
  country: optText(100),
  city: optText(100),
  address: optText(500),
  owner_id: optId,
});
export type OrganizationInput = z.infer<typeof orgSchema>;

function clean(input: OrganizationInput) {
  const domain = input.domain ? normalizeDomain(input.domain) : normalizeDomain(input.website);
  if (input.domain && !domain) throw new UserError("El dominio no es válido (ejemplo: empresa.com).");
  return {
    name: input.name,
    domain,
    website: input.website ?? null,
    industry: input.industry ?? null,
    employee_count: input.employee_count ?? null,
    country: input.country ?? null,
    city: input.city ?? null,
    address: input.address ?? null,
    owner_id: input.owner_id ?? null,
  };
}

export async function createOrganization(
  actor: Actor,
  data: unknown,
  custom: Record<string, unknown> = {},
  db?: Db,
): Promise<string> {
  const values = clean(parse(orgSchema, data));
  const run = async (tx: Db) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO organizations ${tx({ ...values, custom: json(custom) })} RETURNING id`;
    await recordEvent(tx, actor, "organization", row.id, "organization.created", { name: values.name });
    return row.id;
  };
  return db ? run(db) : transaction(run);
}

export async function updateOrganization(actor: Actor, id: string, data: unknown, custom: Record<string, unknown>) {
  const values = clean(parse(orgSchema, data));
  await transaction(async (tx) => {
    const before = await getOrganization(id, tx);
    if (!before) throw new UserError("La empresa no existe.");
    await tx`UPDATE organizations SET ${tx({ ...values, custom: json(custom) })} WHERE id = ${id}`;
    const changed = Object.keys(values).filter(
      (k) => String(before[k as keyof Organization] ?? "") !== String(values[k as keyof typeof values] ?? ""),
    );
    await recordEvent(tx, actor, "organization", id, "organization.updated", { changed });
  });
}

/** Busca una empresa por dominio o la crea (deduplicación para la entrada de leads). */
export async function findOrCreateOrganization(
  db: Db,
  actor: Actor,
  { name, domain }: { name?: string | null; domain?: string | null },
): Promise<{ id: string; created: boolean } | null> {
  const d = normalizeDomain(domain);
  if (d) {
    const [found] = await db<{ id: string }[]>`
      SELECT id FROM organizations WHERE lower(domain) = ${d} AND deleted_at IS NULL`;
    if (found) return { id: found.id, created: false };
  }
  const cleanName = name?.trim();
  if (!cleanName && !d) return null;
  if (cleanName) {
    // Misma empresa dada de alta sin dominio: se reutiliza (y se le asigna el dominio si llega uno).
    const [byName] = await db<{ id: string }[]>`
      SELECT id FROM organizations
      WHERE lower(name) = ${cleanName.toLowerCase()} AND deleted_at IS NULL AND (${d === null} OR domain IS NULL)
      ORDER BY created_at LIMIT 1`;
    if (byName) {
      if (d) await db`UPDATE organizations SET domain = ${d} WHERE id = ${byName.id} AND domain IS NULL`;
      return { id: byName.id, created: false };
    }
  }
  const id = await createOrganization(actor, { name: cleanName || d, domain: d ?? undefined }, {}, db);
  return { id, created: true };
}
