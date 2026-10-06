import { sql, json, transaction, type Db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { INTEGRATION_ACTOR, recordEvent, type Actor } from "./events";
import { UserError } from "./errors";
import { graphClient, microsoftMessage, MicrosoftError, type GraphClient, type Tokens } from "./microsoft";
import { DEFAULT_SCHEDULING, formatSlots, freeSlots, NO_SLOTS_TEXT, normalizeScheduling, type Interval, type Scheduling } from "./slots";

// ===========================================================================
// Buzones conectados: enviar desde Outlook, leer la disponibilidad del
// calendario, crear reuniones y sincronizar correos y reuniones con contactos.
// ===========================================================================

export type Connection = {
  id: string; user_id: string; user_name: string; email: string; display_name: string | null;
  status: "active" | "error"; last_error: string | null; scheduling: Scheduling;
  sync_mail: boolean; sync_calendar: boolean; mail_synced_at: Date | null; calendar_synced_at: Date | null; created_at: Date;
};

const selectConnections = (where = sql``) => sql<(Omit<Connection, "scheduling"> & { scheduling: unknown })[]>`
  SELECT m.id, m.user_id, u.name AS user_name, m.email, m.display_name, m.status, m.last_error, m.scheduling,
         m.sync_mail, m.sync_calendar, m.mail_synced_at, m.calendar_synced_at, m.created_at
  FROM mailbox_connections m JOIN users u ON u.id = m.user_id
  ${where}
  ORDER BY m.created_at`;

const withScheduling = (rows: (Omit<Connection, "scheduling"> & { scheduling: unknown })[]): Connection[] =>
  rows.map((r) => ({ ...r, scheduling: normalizeScheduling(r.scheduling) }));

export async function listConnections(): Promise<Connection[]> {
  return withScheduling(await selectConnections());
}

export async function hasActiveMailbox(): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mailbox_connections WHERE status = 'active'`;
  return r.n > 0;
}

/** Buzón desde el que sale un correo: el del responsable del deal o, si no tiene, el primero conectado. */
export async function senderFor(ownerId: string | null | undefined): Promise<Connection | null> {
  const rows = withScheduling(await selectConnections(sql`WHERE m.status = 'active'`));
  return rows.find((c) => c.user_id === ownerId) ?? rows[0] ?? null;
}

export async function saveConnection(v: { userId: string; email: string; displayName: string | null; tokens: Tokens; scheduling?: Partial<Scheduling> }) {
  const scheduling = normalizeScheduling({ ...DEFAULT_SCHEDULING, ...(v.scheduling ?? {}) });
  await sql`
    INSERT INTO mailbox_connections (user_id, email, display_name, tokens, scheduling)
    VALUES (${v.userId}, ${v.email}, ${v.displayName}, ${encrypt(JSON.stringify(v.tokens))}, ${json(scheduling)})
    ON CONFLICT (user_id) DO UPDATE SET
      email = EXCLUDED.email, display_name = EXCLUDED.display_name, tokens = EXCLUDED.tokens,
      status = 'active', last_error = NULL,
      -- al reconectar se respetan las preferencias guardadas
      scheduling = CASE WHEN mailbox_connections.scheduling = '{}'::jsonb THEN EXCLUDED.scheduling ELSE mailbox_connections.scheduling END`;
}

export async function disconnect(userId: string) {
  await sql`DELETE FROM mailbox_connections WHERE user_id = ${userId}`;
}

export async function updateConnectionSettings(userId: string, data: Record<string, unknown>) {
  const days = Object.keys(data).filter((k) => k.startsWith("day_")).map((k) => Number(k.slice(4)));
  const s = normalizeScheduling({
    days, start: data.start, end: data.end, duration: data.duration, buffer: data.buffer,
    notice_hours: data.notice_hours, horizon_days: data.horizon_days, count: data.count, per_day: data.per_day,
    timezone: data.timezone,
  });
  if (days.length === 0) throw new UserError("Elige al menos un día disponible.");
  if (s.start >= s.end) throw new UserError("La hora de fin debe ser posterior a la de inicio.");
  const res = await sql`
    UPDATE mailbox_connections SET scheduling = ${json(s)},
           sync_mail = ${data.sync_mail === "on"}, sync_calendar = ${data.sync_calendar === "on"}
    WHERE user_id = ${userId}`;
  if (res.count === 0) throw new UserError("Ese usuario no tiene el correo conectado.");
}

/** Cliente de Graph de un buzón; guarda los tokens renovados. */
async function clientFor(conn: { id: string }): Promise<GraphClient> {
  const [row] = await sql<{ tokens: string }[]>`SELECT tokens FROM mailbox_connections WHERE id = ${conn.id}`;
  if (!row) throw new UserError("El buzón ya no está conectado.");
  const tokens = JSON.parse(decrypt(row.tokens)) as Tokens;
  return graphClient(tokens, async (t) => {
    await sql`UPDATE mailbox_connections SET tokens = ${encrypt(JSON.stringify(t))} WHERE id = ${conn.id}`;
  });
}

async function markError(conn: { id: string }, err: unknown) {
  const reconnect = err instanceof MicrosoftError && err.needsReconnect;
  await sql`UPDATE mailbox_connections SET last_error = ${microsoftMessage(err)}, status = ${reconnect ? "error" : "active"}
            WHERE id = ${conn.id}`;
}

async function guarded<T>(conn: { id: string }, fn: (c: GraphClient) => Promise<T>): Promise<T> {
  try {
    return await fn(await clientFor(conn));
  } catch (err) {
    if (!(err instanceof UserError)) await markError(conn, err);
    throw err instanceof UserError ? err : new UserError(microsoftMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Enviar

type EmailInput = {
  to: { email: string; name?: string | null };
  subject: string;
  body: string;
  dealId?: string | null;
  personId?: string | null;
  organizationId?: string | null;
};

/**
 * Envía un correo desde el buzón (queda en «Enviados» de Outlook) y lo
 * registra como actividad del deal.
 */
export async function sendEmail(conn: Connection, actor: Actor, v: EmailInput) {
  const msg = await guarded(conn, async (c) => {
    const draft = await c.call<{ id: string; internetMessageId: string }>("/me/messages", {
      method: "POST",
      json: {
        subject: v.subject,
        body: { contentType: "Text", content: v.body },
        toRecipients: [{ emailAddress: { address: v.to.email, name: v.to.name ?? undefined } }],
      },
    });
    await c.call(`/me/messages/${encodeURIComponent(draft.id)}/send`, { method: "POST" });
    return draft;
  });
  const activityId = await transaction((tx) => logActivity(tx, actor, {
    type: "email", subject: v.subject, note: `Para: ${v.to.email}\n\n${v.body}`.slice(0, 5000),
    due_at: new Date(), done: true, deal_id: v.dealId ?? null, person_id: v.personId ?? null,
    organization_id: v.organizationId ?? null, owner_id: conn.user_id, external_ref: `msg:${msg.internetMessageId}`,
  }));
  await sql`UPDATE mailbox_connections SET last_error = NULL WHERE id = ${conn.id}`;
  return { activityId: activityId!, from: conn.email };
}

type ActivityRow = {
  type: string; subject: string; note: string | null; due_at: Date; duration_minutes?: number | null; done: boolean;
  deal_id: string | null; person_id: string | null; organization_id: string | null; owner_id: string | null;
  external_ref: string; meeting_url?: string | null;
};

/** Inserta una actividad (si no existía ya por su referencia externa) con sus eventos. */
async function logActivity(db: Db, actor: Actor, a: ActivityRow): Promise<string | null> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO activities ${db({
      type: a.type, subject: a.subject.slice(0, 300), note: a.note, due_at: a.due_at, duration_minutes: a.duration_minutes ?? null,
      done: a.done, done_at: a.done ? a.due_at : null, deal_id: a.deal_id, person_id: a.person_id,
      organization_id: a.organization_id, owner_id: a.owner_id, created_by_id: actor.id, external_ref: a.external_ref,
      meeting_url: a.meeting_url ?? null,
    })}
    ON CONFLICT (external_ref) WHERE external_ref IS NOT NULL DO NOTHING
    RETURNING id`;
  if (!row) return null;
  const payload = { activity_id: row.id, type: a.type, subject: a.subject, deal_id: a.deal_id, due_at: a.due_at };
  await recordEvent(db, actor, "activity", row.id, "activity.created", payload);
  if (a.deal_id) await recordEvent(db, actor, "deal", a.deal_id, "activity.created", payload);
  return row.id;
}

// ---------------------------------------------------------------------------
// Calendario

type GraphEvent = {
  id: string; subject: string | null; isCancelled: boolean; isOnlineMeeting?: boolean; showAs?: string;
  start: { dateTime: string }; end: { dateTime: string };
  onlineMeeting?: { joinUrl?: string } | null;
  attendees?: { emailAddress: { address: string; name?: string } }[];
  organizer?: { emailAddress: { address: string; name?: string } };
};

const utc = (s: string) => new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);

async function calendarView(c: GraphClient, from: Date, to: Date, select: string, max = 500) {
  const q = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $select: select, $top: "100" });
  return c.all<GraphEvent>(`/me/calendarView?${q}`, max, { Prefer: 'outlook.timezone="UTC"' });
}

/** Huecos libres del calendario de un buzón según sus preferencias. */
export async function availableSlots(conn: Connection, overrides: Partial<Scheduling> = {}): Promise<Interval[]> {
  const s = normalizeScheduling({ ...conn.scheduling, ...overrides });
  const from = new Date();
  const to = new Date(from.getTime() + (s.horizon_days + 1) * 86400000);
  const events = await guarded(conn, (c) => calendarView(c, from, to, "start,end,showAs,isCancelled"));
  const busy = events
    .filter((e) => !e.isCancelled && e.showAs !== "free" && e.showAs !== "workingElsewhere")
    .map((e) => ({ start: utc(e.start.dateTime), end: utc(e.end.dateTime) }));
  return freeSlots(busy, s, from);
}

/** Texto con los huecos para un correo, o una frase alternativa si no hay calendario. */
export async function slotsText(conn: Connection | null): Promise<string> {
  if (!conn) return NO_SLOTS_TEXT;
  try {
    const slots = await availableSlots(conn);
    return slots.length ? formatSlots(slots, conn.scheduling.timezone) : NO_SLOTS_TEXT;
  } catch {
    return NO_SLOTS_TEXT;
  }
}

/** Crea la reunión en el calendario (con Teams si es en línea) e invita a los asistentes. */
export async function createCalendarEvent(conn: Connection, v: {
  subject: string; start: Date; durationMinutes: number; attendees: { email: string; name?: string | null }[]; online: boolean; body?: string | null;
}) {
  const end = new Date(v.start.getTime() + v.durationMinutes * 60000);
  const iso = (d: Date) => d.toISOString().replace(/Z$/, "");
  const ev = await guarded(conn, (c) => c.call<GraphEvent>("/me/events", {
    method: "POST",
    json: {
      subject: v.subject,
      body: v.body ? { contentType: "Text", content: v.body } : undefined,
      start: { dateTime: iso(v.start), timeZone: "UTC" },
      end: { dateTime: iso(end), timeZone: "UTC" },
      attendees: v.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name ?? undefined }, type: "required" })),
      ...(v.online ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
    },
  }));
  return { eventId: ev.id, joinUrl: ev.onlineMeeting?.joinUrl ?? null };
}

/** Invita al contacto a una actividad ya creada desde el calendario del responsable. */
export async function addActivityToCalendar(activityId: string) {
  const [a] = await sql<{ type: string; subject: string; note: string | null; due_at: Date | null; duration_minutes: number | null;
                         owner_id: string | null; deal_owner: string | null; email: string | null; full_name: string | null }[]>`
    SELECT a.type, a.subject, a.note, a.due_at, a.duration_minutes, a.owner_id, d.owner_id AS deal_owner,
           (SELECT email FROM person_emails WHERE person_id = a.person_id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           p.full_name
    FROM activities a LEFT JOIN deals d ON d.id = a.deal_id LEFT JOIN persons p ON p.id = a.person_id
    WHERE a.id = ${activityId}`;
  if (!a) throw new UserError("La actividad no existe.");
  if (!a.due_at) throw new UserError("Para invitar desde el calendario, la actividad necesita fecha y hora.");
  const conn = await senderFor(a.owner_id ?? a.deal_owner);
  if (!conn) throw new UserError("No hay ningún calendario conectado.");
  const ev = await createCalendarEvent(conn, {
    subject: a.subject, start: new Date(a.due_at), durationMinutes: a.duration_minutes ?? conn.scheduling.duration,
    attendees: a.email ? [{ email: a.email, name: a.full_name }] : [], online: a.type !== "meeting" && a.type !== "call",
    body: a.note,
  });
  await sql`UPDATE activities SET external_ref = ${`evt:${ev.eventId}`}, meeting_url = coalesce(${ev.joinUrl}, meeting_url),
                                  duration_minutes = coalesce(duration_minutes, ${conn.scheduling.duration})
            WHERE id = ${activityId}`;
  return ev;
}

// ---------------------------------------------------------------------------
// Sincronización: correos y reuniones con contactos del CRM

type GraphMessage = {
  id: string; internetMessageId?: string; subject: string | null; bodyPreview: string | null; isDraft?: boolean;
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients?: { emailAddress: { address: string; name?: string } }[];
  ccRecipients?: { emailAddress: { address: string; name?: string } }[];
  sentDateTime?: string; receivedDateTime: string;
};

type Match = { person_id: string; email: string; full_name: string; organization_id: string | null; deal_id: string | null;
               required_activity_type: string | null };

/** Contactos del CRM con esos emails, con su empresa actual y su deal abierto más reciente. */
async function matchContacts(emails: string[]): Promise<Match[]> {
  if (emails.length === 0) return [];
  return sql<Match[]>`
    SELECT DISTINCT ON (lower(pe.email)) p.id AS person_id, lower(pe.email) AS email, p.full_name,
           cur.organization_id, dl.id AS deal_id, dl.required_activity_type
    FROM person_emails pe
    JOIN persons p ON p.id = pe.person_id AND p.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT organization_id FROM person_organizations WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1
    ) cur ON true
    LEFT JOIN LATERAL (
      SELECT d.id, s.required_activity_type FROM deal_participants dp
      JOIN deals d ON d.id = dp.deal_id AND d.status = 'open' AND d.deleted_at IS NULL
      JOIN stages s ON s.id = d.stage_id
      WHERE dp.person_id = p.id ORDER BY d.updated_at DESC LIMIT 1
    ) dl ON true
    WHERE lower(pe.email) = ANY(${emails}::text[])
    ORDER BY lower(pe.email), pe.is_primary DESC`;
}

const SESSION_TYPES = new Set(["call", "meeting", "video_call", "demo"]);

export type SyncResult = { emails: number; meetings: number; updated: number; error?: string };

export async function syncMailbox(conn: Connection): Promise<SyncResult> {
  const result: SyncResult = { emails: 0, meetings: 0, updated: 0 };
  const own = conn.email.toLowerCase();
  const started = new Date();
  await guarded(conn, async (c) => {
    if (conn.sync_mail) {
      const since = conn.mail_synced_at ? new Date(new Date(conn.mail_synced_at).getTime() - 10 * 60000) : new Date(Date.now() - 30 * 86400000);
      const q = new URLSearchParams({
        $select: "id,internetMessageId,subject,bodyPreview,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,isDraft",
        $filter: `receivedDateTime ge ${since.toISOString()}`,
        $orderby: "receivedDateTime desc",
        $top: "50",
      });
      const messages = (await c.all<GraphMessage>(`/me/messages?${q}`, 1000)).filter((m) => !m.isDraft && m.internetMessageId);
      for (const m of messages) {
        const from = m.from?.emailAddress.address.toLowerCase() ?? "";
        const outgoing = from === own;
        const others = (outgoing ? [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map((r) => r.emailAddress.address) : [from])
          .map((e) => e.toLowerCase()).filter((e) => e && e !== own);
        const matches = await matchContacts([...new Set(others)]);
        const who = others.map((e) => matches.find((x) => x.email === e)).find(Boolean);
        if (!who) continue;
        const at = new Date((outgoing ? m.sentDateTime : m.receivedDateTime) ?? m.receivedDateTime);
        const id = await transaction((tx) => logActivity(tx, INTEGRATION_ACTOR, {
          type: "email", subject: m.subject || "(sin asunto)",
          note: `${outgoing ? `Enviado a ${others.join(", ")}` : `Recibido de ${from}`}\n\n${m.bodyPreview ?? ""}`.slice(0, 5000),
          due_at: at, done: true, deal_id: who.deal_id, person_id: who.person_id, organization_id: who.organization_id,
          owner_id: conn.user_id, external_ref: `msg:${m.internetMessageId}`,
        }));
        if (id) result.emails++;
      }
      await sql`UPDATE mailbox_connections SET mail_synced_at = ${started} WHERE id = ${conn.id}`;
    }

    if (conn.sync_calendar) {
      // Reuniones de los dos últimos días (para marcar si se celebraron) y de los próximos 60.
      const events = await calendarView(c, new Date(Date.now() - 2 * 86400000), new Date(Date.now() + 60 * 86400000),
        "id,subject,start,end,isCancelled,isOnlineMeeting,onlineMeeting,attendees,organizer", 2000);
      for (const e of events) {
        const emails = [...(e.attendees ?? []).map((a) => a.emailAddress.address), e.organizer?.emailAddress.address ?? ""]
          .map((x) => x.toLowerCase()).filter((x) => x && x !== own);
        const ref = `evt:${e.id}`;
        const start = utc(e.start.dateTime), end = utc(e.end.dateTime);
        const minutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000));
        const [existing] = await sql<{ id: string; due_at: Date | null; done: boolean; duration_minutes: number | null; subject: string }[]>`
          SELECT id, due_at, done, duration_minutes, subject FROM activities WHERE external_ref = ${ref}`;
        if (existing) {
          if (existing.done) continue;
          if (e.isCancelled) {
            await sql`UPDATE activities SET done = true, outcome = 'cancelled' WHERE id = ${existing.id}`;
            result.updated++;
          } else if (existing.due_at?.getTime() !== start.getTime() || existing.duration_minutes !== minutes || existing.subject !== (e.subject || existing.subject)) {
            await sql`UPDATE activities SET due_at = ${start}, duration_minutes = ${minutes}, subject = ${(e.subject || existing.subject).slice(0, 300)}
                      WHERE id = ${existing.id}`;
            result.updated++;
          }
          continue;
        }
        if (e.isCancelled) continue;
        const matches = await matchContacts([...new Set(emails)]);
        const who = matches.find((m) => m.deal_id) ?? matches[0];
        if (!who) continue;
        // Una reunión futura con el contacto de un deal cuenta como la sesión que pide su fase.
        const type = start > new Date() && who.required_activity_type && SESSION_TYPES.has(who.required_activity_type)
          ? who.required_activity_type
          : /\bdemo/i.test(e.subject ?? "") ? "demo" : e.isOnlineMeeting ? "video_call" : "meeting";
        const id = await transaction((tx) => logActivity(tx, INTEGRATION_ACTOR, {
          type, subject: e.subject || "Reunión", note: null, due_at: start, duration_minutes: minutes, done: false,
          deal_id: who.deal_id, person_id: who.person_id, organization_id: who.organization_id, owner_id: conn.user_id,
          external_ref: ref, meeting_url: e.onlineMeeting?.joinUrl ?? null,
        }));
        if (id) result.meetings++;
      }
      await sql`UPDATE mailbox_connections SET calendar_synced_at = ${started} WHERE id = ${conn.id}`;
    }
  });
  await sql`UPDATE mailbox_connections SET last_error = NULL, status = 'active' WHERE id = ${conn.id}`;
  return result;
}

/** Sincroniza todos los buzones activos; un fallo en uno no para los demás. */
export async function syncAllMailboxes(): Promise<SyncResult> {
  const total: SyncResult = { emails: 0, meetings: 0, updated: 0 };
  const conns = withScheduling(await selectConnections(sql`WHERE m.status = 'active'`));
  for (const conn of conns) {
    try {
      const r = await syncMailbox(conn);
      total.emails += r.emails; total.meetings += r.meetings; total.updated += r.updated;
    } catch (err) {
      total.error = err instanceof Error ? err.message : String(err);
    }
  }
  return total;
}
