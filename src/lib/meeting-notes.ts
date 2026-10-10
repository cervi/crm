import { sql, transaction } from "./db";
import { INTEGRATION_ACTOR, type Actor } from "./events";
import { UserError } from "./errors";
import { completeActivity, createActivity } from "./activities";
import { matchContacts } from "./mailbox";
import { createPerson } from "./persons";
import { notify } from "./notifications";
import { companyDomainFromEmail } from "./validation";

/**
 * Notas de reuniones grabadas por una IA (Granola, Gemini en Google Meet…).
 *
 * Cada nota que llega se asocia sola a la reunión del CRM (la actividad del
 * calendario), a sus contactos y a su deal o lead. Al quedar la reunión como
 * «Realizada» con la transcripción, se ponen en marcha las automatizaciones de
 * siempre: el correo de resumen y lo que sabemos del deal (necesidades,
 * decisores, presupuesto…). Si hay dudas, la nota espera en «Reuniones
 * grabadas» a que alguien la asigne.
 */

export const NOTE_SOURCES: Record<string, string> = {
  granola: "Granola", meet: "Google Meet", api: "API", manual: "A mano",
};

export type NoteInput = {
  source: string;
  external_id?: string | null;
  title?: string | null;
  started_at?: Date | null;
  organizer_email?: string | null;
  attendees?: { name?: string | null; email?: string | null }[];
  summary?: string | null;
  notes?: string | null;
  transcript?: string | null;
  link?: string | null;
  /** Referencia de la actividad del calendario (gcal:…), si se sabe. */
  activity_ref?: string | null;
};

export type MeetingNote = {
  id: string; source: string; title: string | null; started_at: Date | null; owner_id: string | null; owner_name: string | null;
  organizer_email: string | null; attendees: { name: string | null; email: string }[]; summary: string | null; notes: string | null;
  transcript_len: number; link: string | null; status: "matched" | "pending" | "ignored"; match_reason: string | null;
  activity_id: string | null; deal_id: string | null; deal_title: string | null; lead_id: string | null; lead_title: string | null;
  person_names: string[]; created_at: Date;
};

const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\r\n/g, "\n").trim();
  return t ? t.slice(0, n) : null;
};
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lo que queda en la nota de la actividad: resumen y notas, sin la transcripción. */
function noteText(n: { source: string; summary: string | null; notes: string | null; link: string | null }) {
  const parts = [`Notas de la reunión (${NOTE_SOURCES[n.source] ?? n.source})`];
  if (n.summary) parts.push(`Resumen:\n${n.summary}`);
  if (n.notes && n.notes !== n.summary) parts.push(`Notas:\n${n.notes}`);
  if (n.link) parts.push(`Original: ${n.link}`);
  const t = parts.join("\n\n");
  return t.length > 4900 ? `${t.slice(0, 4890)}…` : t;
}

async function teamEmails() {
  const rows = await sql<{ id: string; email: string; name: string }[]>`
    SELECT id, lower(email) AS email, name FROM users WHERE kind = 'human' AND email IS NOT NULL`;
  const domains = new Set(rows.map((u) => u.email.split("@")[1]).filter((d) => d && companyDomainFromEmail(`x@${d}`)));
  return { users: rows, domains };
}

/**
 * Guarda una nota y la asocia si se puede. Si ya había llegado (misma fuente e
 * identificador), no hace nada y devuelve la existente.
 */
export async function ingestMeetingNote(input: NoteInput): Promise<{ id: string; status: string; reason: string | null; duplicate: boolean }> {
  const source = (input.source || "api").toLowerCase().slice(0, 30);
  const externalId = clip(input.external_id, 300);
  if (externalId) {
    const [dup] = await sql<{ id: string; status: string; match_reason: string | null }[]>`
      SELECT id, status, match_reason FROM meeting_notes WHERE source = ${source} AND external_id = ${externalId}`;
    if (dup) return { id: dup.id, status: dup.status, reason: dup.match_reason, duplicate: true };
  }
  const summary = clip(input.summary, 20000);
  const notes = clip(input.notes, 20000);
  const transcript = clip(input.transcript, 200000);
  if (!summary && !notes && !transcript) throw new UserError("La nota llega vacía: hace falta el resumen, las notas o la transcripción.");

  const seen = new Set<string>();
  const attendees = (input.attendees ?? [])
    .map((a) => ({ name: clip(a.name, 200), email: (a.email ?? "").trim().toLowerCase() }))
    .filter((a) => emailRe.test(a.email) && !seen.has(a.email) && seen.add(a.email));
  const organizer = (input.organizer_email ?? "").trim().toLowerCase() || null;

  const team = await teamEmails();
  const owner = team.users.find((u) => u.email === organizer) ?? team.users.find((u) => attendees.some((a) => a.email === u.email)) ?? null;

  const startedAt = input.started_at && !Number.isNaN(input.started_at.getTime()) ? input.started_at : null;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO meeting_notes ${sql({
      source, external_id: externalId, title: clip(input.title, 300), started_at: startedAt, owner_id: owner?.id ?? null,
      organizer_email: organizer, attendees: sql.json(attendees), summary, notes, transcript, link: clip(input.link, 1000),
    })}
    ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id`;
  if (!row) {
    const [dup] = await sql<{ id: string; status: string; match_reason: string | null }[]>`
      SELECT id, status, match_reason FROM meeting_notes WHERE source = ${source} AND external_id = ${externalId}`;
    return { id: dup.id, status: dup.status, reason: dup.match_reason, duplicate: true };
  }
  const r = await autoMatch(row.id, { attendees, owner, team, startedAt, activityRef: clip(input.activity_ref, 300) });
  return { id: row.id, ...r, duplicate: false };
}

type Ctx = {
  attendees: { name: string | null; email: string }[];
  owner: { id: string } | null;
  team: Awaited<ReturnType<typeof teamEmails>>;
  startedAt: Date | null;
  activityRef: string | null;
};

async function setPending(id: string, reason: string, ownerId: string | null, candidates: { kind: "deal" | "lead"; id: string }[] = []) {
  await sql`UPDATE meeting_notes SET status = 'pending', match_reason = ${reason}, candidates = ${sql.json(candidates)} WHERE id = ${id}`;
  // Un solo aviso pendiente por persona («Tienes notas por asociar»), no uno por nota. Sin dueño: a los administradores.
  const to = ownerId ? [ownerId]
    : (await sql<{ id: string }[]>`SELECT id FROM users WHERE kind = 'human' AND is_active AND role = 'admin'`).map((u) => u.id);
  for (const userId of to) {
    const [open] = await sql`SELECT 1 FROM notifications WHERE user_id = ${userId} AND kind = 'meeting_note' AND read_at IS NULL`;
    if (open) continue;
    await notify(sql, {
      userId, kind: "meeting_note", title: "Tienes notas de reunión por asociar",
      body: "No hemos sabido a qué deal o lead van. Elígelo en un clic.", link: "/reuniones?ver=pending",
    }).catch((err) => console.error("[notas de reunión]", err));
  }
  return { status: "pending", reason };
}

/** Decide a qué reunión, deal o lead pertenece la nota. */
async function autoMatch(id: string, ctx: Ctx): Promise<{ status: string; reason: string | null }> {
  const isTeam = (email: string) => ctx.team.users.some((u) => u.email === email) || ctx.team.domains.has(email.split("@")[1]);
  const external = ctx.attendees.filter((a) => !isTeam(a.email));

  // 1. La reunión del calendario, si la conocemos por su referencia.
  if (ctx.activityRef) {
    const [a] = await sql<{ id: string }[]>`SELECT id FROM activities WHERE external_ref = ${ctx.activityRef}`;
    if (a) return applyToActivity(id, a.id, "Su reunión del calendario.");
  }

  if (ctx.attendees.length > 0 && external.length === 0) {
    // Reunión interna: no se guarda su contenido (puede ser un 1:1 o algo confidencial).
    await sql`UPDATE meeting_notes SET status = 'ignored', match_reason = 'Reunión interna: solo había gente de tu equipo.',
                summary = NULL, notes = NULL, transcript = NULL WHERE id = ${id}`;
    return { status: "ignored", reason: "Reunión interna: solo había gente de tu equipo." };
  }

  const matches = await matchContacts(external.map((a) => a.email), ctx.owner?.id ?? null);
  const personIds = [...new Set(matches.map((m) => m.person_id))];

  // 2. Una reunión del CRM con esos contactos a esa hora (±3 h).
  if (ctx.startedAt && personIds.length) {
    const acts = await sql<{ id: string }[]>`
      SELECT a.id FROM activities a
      WHERE coalesce(a.outcome, 'held') NOT IN ('cancelled', 'no_show')
        AND a.due_at BETWEEN ${new Date(ctx.startedAt.getTime() - 3 * 3600000)} AND ${new Date(ctx.startedAt.getTime() + 3 * 3600000)}
        AND a.type IN (SELECT key FROM activity_types WHERE is_session UNION SELECT 'meeting' UNION SELECT 'video_call' UNION SELECT 'call')
        AND (a.person_id = ANY(${personIds}::uuid[])
             OR a.deal_id IN (SELECT deal_id FROM deal_participants WHERE person_id = ANY(${personIds}::uuid[])))
        AND NOT EXISTS (SELECT 1 FROM meeting_notes m WHERE m.activity_id = a.id AND m.id <> ${id})
      ORDER BY abs(extract(epoch FROM a.due_at - ${ctx.startedAt}::timestamptz)) LIMIT 1`;
    if (acts[0]) return applyToActivity(id, acts[0].id, "La reunión del CRM con esos contactos a esa hora.");
  }

  // 3. Contactos conocidos: su deal abierto (si es uno) o su lead abierto.
  if (personIds.length) {
    const deals = [...new Set(matches.map((m) => m.deal_id).filter(Boolean))] as string[];
    if (deals.length > 1) return setPending(id, "Los asistentes están en varios deals abiertos: elige a cuál va.", ctx.owner?.id ?? null,
      deals.map((d) => ({ kind: "deal" as const, id: d })));
    if (deals.length === 1) return applyTo(id, { deal_id: deals[0], person_ids: personIds }, "El deal abierto de los asistentes.");
    const leads = await sql<{ id: string }[]>`
      SELECT id FROM leads WHERE status = 'open' AND deleted_at IS NULL
        AND (person_id = ANY(${personIds}::uuid[])
             OR organization_id IN (SELECT organization_id FROM person_organizations WHERE person_id = ANY(${personIds}::uuid[]) AND status = 'current'))
      ORDER BY updated_at DESC LIMIT 6`;
    if (leads.length === 1) return applyTo(id, { lead_id: leads[0].id, person_ids: personIds }, "El lead abierto de los asistentes.");
    if (leads.length > 1) return setPending(id, "Los asistentes tienen varios leads abiertos: elige a cuál va.", ctx.owner?.id ?? null,
      leads.map((l) => ({ kind: "lead" as const, id: l.id })));
    return applyTo(id, { person_ids: personIds }, "En la ficha del contacto: no tiene deal ni lead abierto.");
  }

  // 4. Nadie conocido, pero su empresa sí (por el dominio): se dan de alta los contactos en ella.
  for (const a of external) {
    const domain = companyDomainFromEmail(a.email);
    if (!domain) continue;
    const [org] = await sql<{ id: string }[]>`SELECT id FROM organizations WHERE lower(domain) = ${domain} AND deleted_at IS NULL`;
    if (!org) continue;
    const created: string[] = [];
    await transaction(async (tx) => {
      for (const p of external.filter((x) => companyDomainFromEmail(x.email) === domain)) {
        const [first, ...rest] = (p.name || p.email.split("@")[0]).split(/\s+/);
        created.push(await createPerson(INTEGRATION_ACTOR, { first_name: first, last_name: rest.join(" ") || undefined, email: p.email,
          organization_id: org.id, owner_id: ctx.owner?.id ?? undefined }, {}, tx));
      }
    });
    const deals = await sql<{ id: string }[]>`
      SELECT id FROM deals WHERE organization_id = ${org.id} AND status = 'open' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 6`;
    if (deals.length === 1) {
      for (const pid of created) {
        await sql`INSERT INTO deal_participants (deal_id, person_id) VALUES (${deals[0].id}, ${pid}) ON CONFLICT DO NOTHING`;
      }
      return applyTo(id, { deal_id: deals[0].id, person_ids: created }, "Contacto nuevo dado de alta en su empresa, que tiene este deal abierto.");
    }
    if (deals.length > 1) {
      await sql`UPDATE meeting_notes SET person_ids = ${created}::uuid[] WHERE id = ${id}`;
      return setPending(id, "Contacto nuevo de una empresa con varios deals abiertos: elige a cuál va.", ctx.owner?.id ?? null,
        deals.map((d) => ({ kind: "deal" as const, id: d.id })));
    }
    return applyTo(id, { person_ids: created }, "Contacto nuevo dado de alta en su empresa.");
  }

  return setPending(id, external.length
    ? `Ningún asistente está en el CRM (${external.map((a) => a.email).slice(0, 3).join(", ")}).`
    : "La nota no trae asistentes.", ctx.owner?.id ?? null);
}

type NoteRow = {
  id: string; source: string; title: string | null; started_at: Date | null; owner_id: string | null; summary: string | null; notes: string | null;
  transcript: string | null; link: string | null; person_ids: string[]; attendees: { email: string }[];
};
const loadNote = async (id: string) => (await sql<NoteRow[]>`
  SELECT id, source, title, started_at, owner_id, summary, notes, transcript, link, person_ids, attendees FROM meeting_notes WHERE id = ${id}`)[0];

/** Vuelca la nota en una actividad existente: si estaba pendiente queda «Realizada». */
async function applyToActivity(noteId: string, activityId: string, reason: string, actor: Actor = INTEGRATION_ACTOR) {
  const n = await loadNote(noteId);
  const [a] = await sql<{ done: boolean; deal_id: string | null; lead_id: string | null; person_id: string | null; owner_id: string | null }[]>`
    SELECT done, deal_id, lead_id, person_id, owner_id FROM activities WHERE id = ${activityId}`;
  if (!a) throw new UserError("Esa reunión ya no existe.");
  const note = noteText(n);
  if (!a.done) {
    if (!a.owner_id && n.owner_id) await sql`UPDATE activities SET owner_id = ${n.owner_id} WHERE id = ${activityId}`;
    await completeActivity(actor, activityId, { outcome: "held", note, transcript: n.transcript ?? undefined });
  } else {
    // Ya estaba hecha: se añade lo que falte (la extracción la recoge en su siguiente pasada).
    await sql`
      UPDATE activities SET note = concat_ws(E'\n\n', note, ${note}::text), transcript = coalesce(transcript, ${n.transcript})
      WHERE id = ${activityId}`;
  }
  const persons = [...new Set([...(n.person_ids ?? []), ...(a.person_id ? [a.person_id] : [])])];
  await sql`
    UPDATE meeting_notes SET status = 'matched', match_reason = ${reason}, activity_id = ${activityId}, deal_id = ${a.deal_id},
           lead_id = ${a.lead_id}, person_ids = ${persons}::uuid[], matched_at = now()
    WHERE id = ${noteId}`;
  return { status: "matched", reason };
}

/** Crea la reunión (ya hecha) en el deal, lead o contacto y le vuelca la nota. */
async function applyTo(noteId: string, target: { deal_id?: string; lead_id?: string; person_ids: string[] }, reason: string, actor: Actor = INTEGRATION_ACTOR) {
  const n = await loadNote(noteId);
  await sql`UPDATE meeting_notes SET person_ids = ${target.person_ids}::uuid[] WHERE id = ${noteId}`;
  let ownerId = n.owner_id;
  if (!ownerId && target.deal_id) ownerId = (await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM deals WHERE id = ${target.deal_id}`)[0]?.owner_id ?? null;
  if (!ownerId && target.lead_id) ownerId = (await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM leads WHERE id = ${target.lead_id}`)[0]?.owner_id ?? null;
  const [type] = await sql<{ key: string }[]>`
    SELECT key FROM activity_types WHERE key IN ('video_call', 'meeting') AND coalesce(is_active, true) ORDER BY key = 'video_call' DESC LIMIT 1`;
  const activityId = await createActivity(actor, {
    type: type?.key ?? "meeting", subject: (n.title || "Reunión").slice(0, 300),
    due_at: (n.started_at ?? new Date()).toISOString(), deal_id: target.deal_id, lead_id: target.lead_id,
    person_id: target.person_ids[0], owner_id: ownerId ?? undefined,
  });
  return applyToActivity(noteId, activityId, reason, actor);
}

// ---------------------------------------------------------------------------
// Bandeja «Reuniones grabadas»

/** Quién mira: cada comercial ve sus notas; los administradores, todas (y las que no tienen dueño). */
export type NoteViewer = { id: string; admin: boolean };
const visible = (v: NoteViewer) => sql`(${v.admin} OR m.owner_id = ${v.id})`;

export type NoteCandidate = { kind: "deal" | "lead"; id: string; label: string; hint: string | null };

export async function listMeetingNotes(viewer: NoteViewer, { status, limit = 100 }: { status?: "matched" | "pending" | "ignored"; limit?: number } = {}) {
  return sql<(MeetingNote & { candidates: NoteCandidate[] })[]>`
    SELECT m.id, m.source, m.title, m.started_at, m.owner_id, u.name AS owner_name, m.organizer_email, m.attendees, m.summary, m.notes,
           length(coalesce(m.transcript, '')) AS transcript_len, m.link, m.status, m.match_reason, m.activity_id,
           m.deal_id, d.title AS deal_title, m.lead_id, l.title AS lead_title,
           coalesce((SELECT array_agg(p.full_name ORDER BY p.full_name) FROM persons p WHERE p.id = ANY(m.person_ids)), '{}') AS person_names,
           coalesce((SELECT jsonb_agg(jsonb_build_object('kind', c->>'kind', 'id', c->>'id',
                       'label', coalesce(cd.title, cl.title), 'hint', coalesce(co.name, clp.full_name)))
                     FROM jsonb_array_elements(m.candidates) c
                     LEFT JOIN deals cd ON c->>'kind' = 'deal' AND cd.id = (c->>'id')::uuid AND cd.status = 'open' AND cd.deleted_at IS NULL
                     LEFT JOIN organizations co ON co.id = cd.organization_id
                     LEFT JOIN leads cl ON c->>'kind' = 'lead' AND cl.id = (c->>'id')::uuid AND cl.status = 'open' AND cl.deleted_at IS NULL
                     LEFT JOIN persons clp ON clp.id = cl.person_id
                     WHERE cd.id IS NOT NULL OR cl.id IS NOT NULL), '[]'::jsonb) AS candidates,
           m.created_at
    FROM meeting_notes m
    LEFT JOIN users u ON u.id = m.owner_id
    LEFT JOIN deals d ON d.id = m.deal_id
    LEFT JOIN leads l ON l.id = m.lead_id
    WHERE (${status ?? null}::text IS NULL OR m.status = ${status ?? null}::text) AND ${visible(viewer)}
    ORDER BY coalesce(m.started_at, m.created_at) DESC
    LIMIT ${limit}`;
}

export async function meetingNoteCounts(viewer: NoteViewer) {
  const rows = await sql<{ status: string; n: number }[]>`
    SELECT status, count(*)::int AS n FROM meeting_notes m WHERE ${visible(viewer)} GROUP BY status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<"matched" | "pending" | "ignored", number>>;
}

export async function getMeetingNote(viewer: NoteViewer, id: string) {
  const [n] = await sql<{ id: string; status: string; title: string | null; deal_id: string | null; lead_id: string | null; deal_title: string | null;
                          lead_title: string | null; activity_id: string | null }[]>`
    SELECT m.id, m.status, m.title, m.deal_id, m.lead_id, d.title AS deal_title, l.title AS lead_title, m.activity_id
    FROM meeting_notes m LEFT JOIN deals d ON d.id = m.deal_id LEFT JOIN leads l ON l.id = m.lead_id
    WHERE m.id = ${id} AND ${visible(viewer)}`;
  return n ?? null;
}

export type AssignTarget = { kind: "deal" | "lead" | "person"; id: string; person_id?: string | null };

/** Asistentes de fuera que no están en el CRM: se dan de alta (en la empresa del deal o lead, si la hay). */
async function createUnknownAttendees(noteId: string, organizationId: string | null, ownerId: string | null) {
  const [n] = await sql<{ attendees: { name: string | null; email: string }[] }[]>`SELECT attendees FROM meeting_notes WHERE id = ${noteId}`;
  const team = await teamEmails();
  const external = (n?.attendees ?? []).filter((a) => !team.users.some((u) => u.email === a.email) && !team.domains.has(a.email.split("@")[1]));
  const known = new Set((await matchContacts(external.map((a) => a.email))).map((m) => m.email));
  const ids: string[] = [];
  for (const a of external.filter((x) => !known.has(x.email)).slice(0, 10)) {
    const [first, ...rest] = (a.name || a.email.split("@")[0]).split(/\s+/);
    ids.push(await createPerson(INTEGRATION_ACTOR, { first_name: first, last_name: rest.join(" ") || undefined, email: a.email,
      organization_id: organizationId ?? undefined, owner_id: ownerId ?? undefined }));
  }
  return ids;
}

/** Asignación a mano desde la bandeja: a un deal, a un lead o solo a un contacto. */
export async function assignMeetingNote(actor: Actor, viewer: NoteViewer, noteId: string, target: AssignTarget) {
  const [n] = await sql<{ status: string; person_ids: string[]; owner_id: string | null; activity_id: string | null }[]>`
    SELECT status, person_ids, owner_id, activity_id FROM meeting_notes m WHERE id = ${noteId} AND ${visible(viewer)}`;
  if (!n) throw new UserError("Esa nota ya no existe.");
  if (!target.id) throw new UserError(target.kind === "deal" ? "Elige el deal." : target.kind === "lead" ? "Elige el lead." : "Elige el contacto.");
  if (n.status === "matched") return moveMeetingNote(noteId, n.activity_id, target);

  const [org] = target.kind === "deal"
    ? await sql<{ organization_id: string | null }[]>`SELECT organization_id FROM deals WHERE id = ${target.id}`
    : target.kind === "lead" ? await sql<{ organization_id: string | null }[]>`SELECT organization_id FROM leads WHERE id = ${target.id}` : [];
  let persons = n.person_ids ?? [];
  const chosen = target.kind === "person" ? target.id : target.person_id;
  if (chosen) persons = [chosen, ...persons.filter((p) => p !== chosen)];
  // Asistentes que aún no están en el CRM: se crean, en vez de suponer que estuvieron otros contactos del deal.
  persons = [...persons, ...(await createUnknownAttendees(noteId, org?.organization_id ?? null, n.owner_id))];
  if (target.kind === "deal") {
    for (const pid of persons) await sql`INSERT INTO deal_participants (deal_id, person_id) VALUES (${target.id}, ${pid}) ON CONFLICT DO NOTHING`;
  }
  return applyTo(noteId, { deal_id: target.kind === "deal" ? target.id : undefined, lead_id: target.kind === "lead" ? target.id : undefined,
    person_ids: persons }, "Asociada a mano.", actor);
}

/** Corrige una nota ya asociada: su reunión pasa al deal, lead o contacto elegido. */
async function moveMeetingNote(noteId: string, activityId: string | null, target: AssignTarget) {
  if (!activityId) throw new UserError("Esa reunión ya no existe.");
  const deal = target.kind === "deal" ? target.id : null;
  const lead = target.kind === "lead" ? target.id : null;
  const [org] = deal ? await sql<{ organization_id: string | null }[]>`SELECT organization_id FROM deals WHERE id = ${deal}`
    : lead ? await sql<{ organization_id: string | null }[]>`SELECT organization_id FROM leads WHERE id = ${lead}` : [];
  const person = target.kind === "person" ? target.id : target.person_id ?? null;
  await transaction(async (tx) => {
    await tx`UPDATE activities SET deal_id = ${deal}, lead_id = ${lead}, organization_id = coalesce(${org?.organization_id ?? null}::uuid, organization_id),
                    person_id = coalesce(${person}::uuid, person_id) WHERE id = ${activityId}`;
    await tx`UPDATE meeting_notes SET deal_id = ${deal}, lead_id = ${lead}, match_reason = 'Cambiada a mano.',
                    person_ids = CASE WHEN ${person}::uuid IS NULL THEN person_ids ELSE array_prepend(${person}::uuid, array_remove(person_ids, ${person}::uuid)) END
             WHERE id = ${noteId}`;
    if (deal && person) await tx`INSERT INTO deal_participants (deal_id, person_id) VALUES (${deal}, ${person}) ON CONFLICT DO NOTHING`;
  });
  return { status: "matched", reason: "Cambiada a mano." };
}

export async function setMeetingNoteIgnored(viewer: NoteViewer, noteId: string, ignored: boolean) {
  const [r] = await sql<{ id: string }[]>`
    UPDATE meeting_notes m SET status = ${ignored ? "ignored" : "pending"}, match_reason = ${ignored ? "Descartada a mano." : "Recuperada: elige a qué va."}
    WHERE id = ${noteId} AND status <> 'matched' AND ${visible(viewer)} RETURNING id`;
  if (!r) throw new UserError("Esa nota ya está asociada.");
}

/** Para la ficha de la reunión: la nota que llegó de fuera, con el enlace al original. */
export async function noteForActivity(activityId: string) {
  const [r] = await sql<{ id: string; source: string; link: string | null }[]>`
    SELECT id, source, link FROM meeting_notes WHERE activity_id = ${activityId} ORDER BY created_at DESC LIMIT 1`;
  return r ?? null;
}

// ---------------------------------------------------------------------------
// Entrada flexible (Zapier, Make, n8n…): acepta los nombres de campo habituales.

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const v = k.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), o);
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
};
const str = (v: unknown) => (v === undefined ? null : typeof v === "string" ? v : Array.isArray(v) ? v.map(String).join("\n") : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Personas en cualquiera de los formatos habituales: lista de objetos, lista de emails o texto «Nombre <email>, …». */
export function parseAttendees(v: unknown): { name: string | null; email: string }[] {
  if (Array.isArray(v)) {
    return v.flatMap((x) => {
      if (typeof x === "string") return parseAttendees(x);
      if (x && typeof x === "object") {
        const o = x as Record<string, unknown>;
        const email = str(o.email ?? o.Email ?? o.address);
        return email ? [{ name: str(o.name ?? o.Name ?? o.displayName ?? o.display_name), email }] : [];
      }
      return [];
    });
  }
  if (typeof v === "string") {
    // Zapier aplana listas de objetos en dos campos separados por comas; aquí llega solo el texto.
    const out: { name: string | null; email: string }[] = [];
    for (const m of v.matchAll(/(?:"?([^",<]+?)"?\s*)?<?([^\s<>,;]+@[^\s<>,;]+)>?/g)) {
      out.push({ name: m[1]?.trim() || null, email: m[2] });
    }
    return out;
  }
  return [];
}

export function noteFromPayload(body: Record<string, unknown>, fallbackSource = "api"): NoteInput {
  const source = String(pick(body, "source") ?? fallbackSource).toLowerCase();
  let attendees = parseAttendees(pick(body, "attendees", "participants", "people", "invitees"));
  // Zapier: «Attendees Name» y «Attendees Email» como dos listas paralelas.
  const names = pick(body, "attendees_name", "attendees_names", "attendee_names");
  const emails = pick(body, "attendees_email", "attendees_emails", "attendee_emails");
  if (!attendees.length && emails) {
    const es = parseAttendees(String(emails));
    const ns = typeof names === "string" ? names.split(",").map((x) => x.trim()) : Array.isArray(names) ? names.map(String) : [];
    attendees = es.map((a, i) => ({ email: a.email, name: ns[i] || a.name }));
  }
  const creator = str(pick(body, "creator_email", "creator.email", "owner_email", "organizer_email", "organizer.email", "user_email"));
  const start = str(pick(body, "started_at", "start", "date", "calendar_event.start", "calendar_event_start", "meeting_date", "created_at"));
  return {
    source,
    external_id: str(pick(body, "id", "note_id", "external_id", "document_id")),
    title: str(pick(body, "title", "meeting_title", "calendar_event.title", "calendar_event_title", "name")),
    started_at: start ? new Date(start) : null,
    organizer_email: creator,
    attendees,
    summary: str(pick(body, "summary", "summary_markdown", "enhanced_notes", "ai_summary")),
    notes: str(pick(body, "notes", "my_notes", "private_notes")),
    transcript: str(pick(body, "transcript", "transcription")),
    link: str(pick(body, "link", "url", "note_url")),
  };
}
