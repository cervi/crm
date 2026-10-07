import { z } from "zod";
import { sql, transaction } from "./db";
import { UserError } from "./errors";
import { recordEvent, type Actor, type EntityType } from "./events";
import { optId, optText, parse } from "./validation";
import { createActivity } from "./activities";

// ===========================================================================
// Lo que se hace desde la ficha de un contacto, una empresa o un deal (como
// en Pipedrive): registrar llamadas, etiquetas de colores, fijar notas y el
// resumen de la relación (cuántas actividades, correos, último contacto…).
// ===========================================================================

// --- Llamadas -----------------------------------------------------------------

export const CALL_OUTCOMES = [
  { value: "answered", label: "Contestó" },
  { value: "no_answer", label: "No contestó" },
  { value: "voicemail", label: "Buzón de voz" },
  { value: "busy", label: "Ocupado" },
  { value: "wrong_number", label: "Número equivocado" },
] as const;
export const callOutcomeLabel = (v: string | null | undefined) => CALL_OUTCOMES.find((o) => o.value === v)?.label ?? null;

const callSchema = z.object({
  outcome: z.enum(["answered", "no_answer", "voicemail", "busy", "wrong_number"], { message: "Elige cómo fue la llamada" }),
  minutes: z.coerce.number().int().min(0).max(600).optional(),
  note: optText(5000),
  subject: optText(300),
  deal_id: optId, person_id: optId, organization_id: optId, lead_id: optId,
  follow_up_days: z.coerce.number().int().min(0).max(365).optional(),
});

/** Registra una llamada ya hecha (y, si se pide, programa la siguiente). */
export async function logCall(actor: Actor, data: unknown): Promise<string> {
  const v = parse(callSchema, data);
  if (!v.deal_id && !v.person_id && !v.organization_id && !v.lead_id) throw new UserError("La llamada debe ir asociada a algo.");
  const [p] = v.person_id ? await sql<{ full_name: string }[]>`SELECT full_name FROM persons WHERE id = ${v.person_id}` : [];
  const outcome = callOutcomeLabel(v.outcome)!;
  const subject = v.subject || `Llamada${p ? ` con ${p.full_name}` : ""} · ${outcome.toLowerCase()}`;
  const id = await createActivity(actor, {
    type: "call", subject, note: v.note, due_at: new Date().toISOString(), duration_minutes: v.minutes || undefined,
    deal_id: v.deal_id, person_id: v.person_id, organization_id: v.organization_id, lead_id: v.lead_id, owner_id: actor.id ?? undefined,
  });
  await sql`UPDATE activities SET done = true, done_at = now(), call_outcome = ${v.outcome} WHERE id = ${id}`;
  const [type, eid]: [EntityType, string] = v.deal_id ? ["deal", v.deal_id] : v.person_id ? ["person", v.person_id]
    : v.organization_id ? ["organization", v.organization_id] : ["lead", v.lead_id!];
  await recordEvent(sql, actor, type, eid, "call.logged", { activity_id: id, outcome, minutes: v.minutes ?? null });
  if (v.follow_up_days) {
    await createActivity(actor, {
      type: "call", subject: v.outcome === "answered" ? `Seguimiento${p ? ` con ${p.full_name}` : ""}` : `Volver a llamar${p ? ` a ${p.full_name}` : ""}`,
      due_at: new Date(Date.now() + v.follow_up_days * 86400000).toISOString(),
      deal_id: v.deal_id, person_id: v.person_id, organization_id: v.organization_id, lead_id: v.lead_id, owner_id: actor.id ?? undefined,
    });
  }
  return id;
}

// --- Etiquetas ----------------------------------------------------------------

export type TagEntity = "person" | "organization" | "deal" | "lead";
export type Tag = { id: string; name: string; color: string };
export const TAG_COLORS = ["blue", "green", "orange", "red", "purple", "gray"] as const;
const TAG_TABLE: Record<TagEntity, [string, string]> = {
  person: ["person_tags", "person_id"], organization: ["organization_tags", "organization_id"],
  deal: ["deal_tags", "deal_id"], lead: ["lead_tags", "lead_id"],
};

export async function listTags(): Promise<Tag[]> {
  return sql<Tag[]>`SELECT id, name, coalesce(color, 'blue') AS color FROM tags ORDER BY lower(name)`;
}

export async function tagsOf(entity: TagEntity, id: string): Promise<Tag[]> {
  const [table, col] = TAG_TABLE[entity];
  return sql<Tag[]>`SELECT t.id, t.name, coalesce(t.color, 'blue') AS color FROM ${sql(table)} x JOIN tags t ON t.id = x.tag_id
                    WHERE x.${sql(col)} = ${id} ORDER BY lower(t.name)`;
}

/** Deja exactamente estas etiquetas (crea las que no existan). */
export async function setTags(actor: Actor, entity: TagEntity, id: string, names: string[], color?: string) {
  const [table, col] = TAG_TABLE[entity];
  const clean = [...new Set(names.map((n) => n.trim().replace(/\s+/g, " ")).filter(Boolean).map((n) => n.slice(0, 40)))].slice(0, 20);
  const c: string = color && TAG_COLORS.includes(color as (typeof TAG_COLORS)[number]) ? color : "blue";
  await transaction(async (tx) => {
    const ids: string[] = [];
    for (const n of clean) {
      const [t] = await tx<{ id: string }[]>`
        INSERT INTO tags (name, color) VALUES (${n}, ${c}) ON CONFLICT ((lower(name))) DO UPDATE SET name = tags.name RETURNING id`;
      ids.push(t.id);
    }
    await tx`DELETE FROM ${tx(table)} WHERE ${tx(col)} = ${id} AND NOT (tag_id = ANY(${ids}::uuid[]))`;
    for (const t of ids) await tx`INSERT INTO ${tx(table)} (${tx(col)}, tag_id) VALUES (${id}, ${t}) ON CONFLICT DO NOTHING`;
  });
  await recordEvent(sql, actor, entity, id, `${entity}.tags_changed`, { tags: clean });
}

export async function setTagColor(tagId: string, color: string) {
  if (!TAG_COLORS.includes(color as (typeof TAG_COLORS)[number])) throw new UserError("Color no válido.");
  await sql`UPDATE tags SET color = ${color} WHERE id = ${tagId}`;
}

// --- Notas fijadas ------------------------------------------------------------

export async function setNotePinned(noteId: string, pinned: boolean) {
  await sql`UPDATE notes SET is_pinned = ${pinned}, updated_at = now() WHERE id = ${noteId}`;
}

// --- Resumen de la relación ---------------------------------------------------

export type Overview = {
  activities_done: number; activities_open: number; calls: number; emails_out: number; emails_in: number;
  open_deals: number; won_deals: number; won_value: number; last_contact: Date | null; next_activity: Date | null; first_seen: Date | null;
};

export async function overviewFor(ref: { personId?: string; organizationId?: string }): Promise<Overview> {
  const pid = ref.personId ?? null, oid = ref.organizationId ?? null;
  const [o] = await sql<Overview[]>`
    WITH a AS (
      SELECT * FROM activities WHERE (${pid}::uuid IS NOT NULL AND person_id = ${pid}::uuid)
         OR (${oid}::uuid IS NOT NULL AND (organization_id = ${oid}::uuid OR deal_id IN (SELECT id FROM deals WHERE organization_id = ${oid}::uuid)))
    ), m AS (
      SELECT * FROM emails WHERE status = 'sent' AND ((${pid}::uuid IS NOT NULL AND person_id = ${pid}::uuid)
         OR (${oid}::uuid IS NOT NULL AND (organization_id = ${oid}::uuid OR deal_id IN (SELECT id FROM deals WHERE organization_id = ${oid}::uuid))))
    ), d AS (
      SELECT * FROM deals WHERE deleted_at IS NULL AND ((${pid}::uuid IS NOT NULL AND id IN (SELECT deal_id FROM deal_participants WHERE person_id = ${pid}::uuid))
         OR (${oid}::uuid IS NOT NULL AND organization_id = ${oid}::uuid))
    )
    SELECT (SELECT count(*)::int FROM a WHERE done) AS activities_done,
           (SELECT count(*)::int FROM a WHERE NOT done) AS activities_open,
           (SELECT count(*)::int FROM a WHERE done AND type = 'call') AS calls,
           (SELECT count(*)::int FROM m WHERE direction = 'out') AS emails_out,
           (SELECT count(*)::int FROM m WHERE direction = 'in') AS emails_in,
           (SELECT count(*)::int FROM d WHERE status = 'open') AS open_deals,
           (SELECT count(*)::int FROM d WHERE status = 'won') AS won_deals,
           (SELECT coalesce(sum(value), 0)::float8 FROM d WHERE status = 'won') AS won_value,
           greatest((SELECT max(done_at) FROM a WHERE done), (SELECT max(sent_at) FROM m)) AS last_contact,
           (SELECT min(due_at) FROM a WHERE NOT done AND due_at IS NOT NULL) AS next_activity,
           (SELECT created_at FROM ${pid ? sql`persons WHERE id = ${pid}` : sql`organizations WHERE id = ${oid}`}) AS first_seen`;
  return o;
}

// --- vCard --------------------------------------------------------------------

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

export async function personVCard(personId: string): Promise<{ name: string; text: string } | null> {
  const [p] = await sql<{ first_name: string | null; last_name: string | null; full_name: string; linkedin_url: string | null;
                          org: string | null; title: string | null }[]>`
    SELECT p.first_name, p.last_name, p.full_name, p.linkedin_url, o.name AS org, po.job_title AS title
    FROM persons p
    LEFT JOIN LATERAL (SELECT organization_id, job_title FROM person_organizations WHERE person_id = p.id AND status = 'current' LIMIT 1) po ON true
    LEFT JOIN organizations o ON o.id = po.organization_id
    WHERE p.id = ${personId} AND p.deleted_at IS NULL`;
  if (!p) return null;
  const emails = await sql<{ email: string }[]>`SELECT email FROM person_emails WHERE person_id = ${personId} ORDER BY is_primary DESC`;
  const phones = await sql<{ phone: string; label: string }[]>`SELECT phone, label FROM person_phones WHERE person_id = ${personId} ORDER BY is_primary DESC`;
  const lines = [
    "BEGIN:VCARD", "VERSION:3.0",
    `N:${esc(p.last_name ?? "")};${esc(p.first_name ?? "")};;;`, `FN:${esc(p.full_name)}`,
    ...(p.org ? [`ORG:${esc(p.org)}`] : []), ...(p.title ? [`TITLE:${esc(p.title)}`] : []),
    ...emails.map((e) => `EMAIL;TYPE=INTERNET:${esc(e.email)}`),
    ...phones.map((t) => `TEL;TYPE=${t.label === "mobile" ? "CELL" : t.label === "personal" ? "HOME" : "WORK"}:${esc(t.phone)}`),
    ...(p.linkedin_url ? [`URL:${esc(p.linkedin_url)}`] : []),
    "END:VCARD",
  ];
  return { name: p.full_name, text: lines.join("\r\n") + "\r\n" };
}
