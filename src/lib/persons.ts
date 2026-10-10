import { z } from "zod";
import { sql, json, transaction, type Db } from "./db";
import { recordEvent, type Actor } from "./events";
import { UserError } from "./errors";
import { checkbox, optEmail, optId, optText, parse } from "./validation";

export type PersonListRow = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  organization_id: string | null;
  organization_name: string | null;
  job_title: string | null;
  owner_name: string | null;
  open_deals: number;
  next_activity: Date | null;
  last_activity: Date | null;
  tags: { name: string; color: string }[];
  custom: Record<string, unknown>;
  created_at: Date;
};

export type ListFilters = {
  q?: string; owner?: string; tag?: string; activity?: "" | "none" | "overdue"; deals?: "" | "open" | "none";
  sort?: "name" | "recent" | "next" | "last"; limit?: number; me?: string | null;
};

/** Filtro de responsable: un id, «me» (yo) o «none» (sin responsable). */
export const ownerFilter = (col: string, owner: string | undefined, me: string | null | undefined) =>
  !owner ? sql`true` : owner === "none" ? sql`${sql.unsafe(col)} IS NULL`
    : sql`${sql.unsafe(col)} = ${owner === "me" ? me ?? null : /^[0-9a-f-]{36}$/i.test(owner) ? owner : null}::uuid`;

export async function listPersons({ q = "", owner, tag, activity, deals, sort = "name", limit = 300, me }: ListFilters = {}) {
  const like = `%${q.trim().toLowerCase()}%`;
  const order = sort === "recent" ? sql`x.created_at DESC` : sort === "next" ? sql`x.next_activity NULLS LAST, lower(x.full_name)`
    : sort === "last" ? sql`x.last_activity DESC NULLS LAST` : sql`lower(x.full_name)`;
  return sql<PersonListRow[]>`
    SELECT * FROM (
      SELECT p.id, p.full_name, p.created_at, p.custom,
             (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
             (SELECT phone FROM person_phones WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS phone,
             cur.organization_id, o.name AS organization_name, cur.job_title, u.name AS owner_name,
             (SELECT count(*)::int FROM deal_participants dp JOIN deals d ON d.id = dp.deal_id AND d.status = 'open' AND d.deleted_at IS NULL
               WHERE dp.person_id = p.id) AS open_deals,
             (SELECT min(due_at) FROM activities a WHERE a.person_id = p.id AND NOT a.done) AS next_activity,
             (SELECT max(done_at) FROM activities a WHERE a.person_id = p.id AND a.done) AS last_activity,
             coalesce((SELECT json_agg(json_build_object('name', t.name, 'color', coalesce(t.color, 'blue')) ORDER BY lower(t.name))
                       FROM person_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.person_id = p.id), '[]'::json) AS tags,
             (SELECT bool_or(NOT a.done AND a.due_at < now()) FROM activities a WHERE a.person_id = p.id) AS overdue
      FROM persons p
      LEFT JOIN LATERAL (
        SELECT organization_id, job_title FROM person_organizations
        WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1
      ) cur ON true
      LEFT JOIN organizations o ON o.id = cur.organization_id
      LEFT JOIN users u ON u.id = p.owner_id
      WHERE p.deleted_at IS NULL
        AND (${q.trim() === ""} OR lower(p.full_name) LIKE ${like} OR lower(coalesce(o.name, '')) LIKE ${like}
             OR EXISTS (SELECT 1 FROM person_emails e WHERE e.person_id = p.id AND lower(e.email) LIKE ${like}))
        AND ${ownerFilter("p.owner_id", owner, me)}
        AND (${tag ?? ""} = '' OR EXISTS (SELECT 1 FROM person_tags pt WHERE pt.person_id = p.id AND pt.tag_id::text = ${tag ?? ""}))
    ) x
    WHERE (${activity ?? ""} = '' OR (${activity ?? ""} = 'none' AND x.next_activity IS NULL) OR (${activity ?? ""} = 'overdue' AND x.overdue))
      AND (${deals ?? ""} = '' OR (${deals ?? ""} = 'open' AND x.open_deals > 0) OR (${deals ?? ""} = 'none' AND x.open_deals = 0))
    ORDER BY ${order}
    LIMIT ${limit}`;
}

export type Person = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string;
  linkedin_url: string | null;
  owner_id: string | null;
  owner_name: string | null;
  marketing_consent: boolean;
  unsubscribed_at: Date | null;
  custom: Record<string, unknown>;
  created_at: Date;
};

export async function getPerson(id: string, db: Db = sql): Promise<Person | null> {
  const [p] = await db<Person[]>`
    SELECT p.id, p.first_name, p.last_name, p.full_name, p.linkedin_url, p.owner_id,
           u.name AS owner_name, p.marketing_consent, p.unsubscribed_at, p.custom, p.created_at
    FROM persons p LEFT JOIN users u ON u.id = p.owner_id
    WHERE p.id = ${id} AND p.deleted_at IS NULL`;
  return p ?? null;
}

export async function personContactInfo(id: string) {
  const [emails, phones, companies] = await Promise.all([
    sql<{ id: string; email: string; label: string; is_primary: boolean }[]>`
      SELECT id, email, label, is_primary FROM person_emails WHERE person_id = ${id}
      ORDER BY is_primary DESC, created_at`,
    sql<{ id: string; phone: string; label: string; is_primary: boolean }[]>`
      SELECT id, phone, label, is_primary FROM person_phones WHERE person_id = ${id}
      ORDER BY is_primary DESC, created_at`,
    sql<{ id: string; organization_id: string; organization_name: string; job_title: string | null;
          status: "current" | "former"; started_at: string | null; ended_at: string | null }[]>`
      SELECT po.id, po.organization_id, o.name AS organization_name, po.job_title, po.status,
             po.started_at::text, po.ended_at::text
      FROM person_organizations po JOIN organizations o ON o.id = po.organization_id
      WHERE po.person_id = ${id}
      ORDER BY po.status, po.started_at DESC NULLS LAST, po.created_at DESC`,
  ]);
  return { emails, phones, companies };
}

const personSchema = z.object({
  first_name: optText(100),
  last_name: optText(100),
  email: optEmail,
  phone: optText(50),
  linkedin_url: optText(500),
  owner_id: optId,
  organization_id: optId,
  job_title: optText(200),
  marketing_consent: checkbox,
}).refine((v) => v.first_name || v.last_name, { message: "Indica al menos el nombre o los apellidos" });

export type PersonInput = z.infer<typeof personSchema>;

export async function createPerson(
  actor: Actor,
  data: unknown,
  custom: Record<string, unknown> = {},
  db?: Db,
): Promise<string> {
  const v = parse(personSchema, data);
  const run = async (tx: Db) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO persons ${tx({
        first_name: v.first_name ?? null,
        last_name: v.last_name ?? null,
        linkedin_url: v.linkedin_url ?? null,
        owner_id: v.owner_id ?? null,
        marketing_consent: v.marketing_consent,
        marketing_consent_at: v.marketing_consent ? new Date() : null,
        custom: json(custom),
      })} RETURNING id`;
    if (v.email) await tx`INSERT INTO person_emails (person_id, email, is_primary) VALUES (${row.id}, ${v.email}, true)`;
    if (v.phone) await tx`INSERT INTO person_phones (person_id, phone, is_primary) VALUES (${row.id}, ${v.phone}, true)`;
    if (v.organization_id) {
      await tx`INSERT INTO person_organizations (person_id, organization_id, job_title, started_at)
               VALUES (${row.id}, ${v.organization_id}, ${v.job_title ?? null}, current_date)`;
    }
    await recordEvent(tx, actor, "person", row.id, "person.created", {
      name: [v.first_name, v.last_name].filter(Boolean).join(" "),
      organization_id: v.organization_id ?? null,
    });
    return row.id;
  };
  return db ? run(db) : transaction(run);
}

/** Actualiza datos personales, email y teléfono principales (no la empresa). */
export async function updatePerson(actor: Actor, id: string, data: unknown, custom: Record<string, unknown>) {
  const v = parse(personSchema, data);
  await transaction(async (tx) => {
    const before = await getPerson(id, tx);
    if (!before) throw new UserError("El contacto no existe.");
    const consentChanged = v.marketing_consent !== before.marketing_consent;
    await tx`
      UPDATE persons SET ${tx({
        first_name: v.first_name ?? null,
        last_name: v.last_name ?? null,
        linkedin_url: v.linkedin_url ?? null,
        owner_id: v.owner_id ?? null,
        marketing_consent: v.marketing_consent,
        custom: json(custom),
      })}, marketing_consent_at = CASE WHEN ${consentChanged && v.marketing_consent} THEN now()
                                       WHEN ${consentChanged} THEN NULL ELSE marketing_consent_at END
      WHERE id = ${id}`;
    await setPrimary(tx, "email", id, v.email ?? null);
    await setPrimary(tx, "phone", id, v.phone ?? null);
    await recordEvent(tx, actor, "person", id, "person.updated", consentChanged ? { marketing_consent: v.marketing_consent } : {});
  });
}

/** Sustituye el email/teléfono principal (o lo quita si viene vacío). */
async function setPrimary(tx: Db, kind: "email" | "phone", personId: string, value: string | null) {
  if (kind === "email") {
    if (!value) { await tx`DELETE FROM person_emails WHERE person_id = ${personId} AND is_primary`; return; }
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM person_emails WHERE person_id = ${personId} AND lower(email) = ${value.toLowerCase()}`;
    await tx`UPDATE person_emails SET is_primary = false WHERE person_id = ${personId} AND is_primary`;
    if (existing) await tx`UPDATE person_emails SET is_primary = true WHERE id = ${existing.id}`;
    else await tx`INSERT INTO person_emails (person_id, email, is_primary) VALUES (${personId}, ${value}, true)`;
  } else {
    if (!value) { await tx`DELETE FROM person_phones WHERE person_id = ${personId} AND is_primary`; return; }
    const [primary] = await tx<{ id: string }[]>`
      SELECT id FROM person_phones WHERE person_id = ${personId} AND is_primary`;
    if (primary) await tx`UPDATE person_phones SET phone = ${value} WHERE id = ${primary.id}`;
    else await tx`INSERT INTO person_phones (person_id, phone, is_primary) VALUES (${personId}, ${value}, true)`;
  }
}

/**
 * Cambio de trabajo: la relación actual pasa a "antigua" (se conserva todo su
 * historial) y, si se indica, se crea la relación con la nueva empresa.
 */
export async function changeCompany(
  actor: Actor,
  personId: string,
  data: unknown,
) {
  const v = parse(z.object({
    organization_id: optId,
    job_title: optText(200),
    left_previous: checkbox,
  }), data);
  await transaction(async (tx) => {
    if (v.left_previous) {
      await tx`UPDATE person_organizations SET status = 'former', ended_at = current_date
               WHERE person_id = ${personId} AND status = 'current'
                 AND organization_id IS DISTINCT FROM ${v.organization_id ?? null}`;
    }
    if (v.organization_id) {
      await tx`INSERT INTO person_organizations (person_id, organization_id, job_title, started_at)
               VALUES (${personId}, ${v.organization_id}, ${v.job_title ?? null}, current_date)
               ON CONFLICT (person_id, organization_id) WHERE status = 'current'
               DO UPDATE SET job_title = EXCLUDED.job_title`;
    }
    await recordEvent(tx, actor, "person", personId, "person.changed_company", {
      organization_id: v.organization_id ?? null, left_previous: v.left_previous,
    });
  });
}

/** Busca un contacto por email (deduplicación). */
export async function findPersonByEmail(db: Db, email: string) {
  // El email es único también entre contactos borrados: si vuelve a entrar,
  // se recupera ese contacto en lugar de chocar con el índice único.
  const [row] = await db<{ id: string; deleted: boolean }[]>`
    SELECT p.id, p.deleted_at IS NOT NULL AS deleted FROM person_emails e JOIN persons p ON p.id = e.person_id
    WHERE lower(e.email) = ${email.toLowerCase()}`;
  if (row?.deleted) await db`UPDATE persons SET deleted_at = NULL WHERE id = ${row.id}`;
  return row?.id ?? null;
}
