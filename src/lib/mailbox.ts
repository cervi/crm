import { sql, json, transaction, type Db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { INTEGRATION_ACTOR, recordEvent, type Actor } from "./events";
import { UserError } from "./errors";
import { isSessionType } from "./format";
import { PROVIDERS, ProviderError, providerMessage, type Provider, type ProviderKey, type Tokens } from "./integrations";
import { apiClient, type ApiClient } from "./integrations/http";
import { DEFAULT_SCHEDULING, formatSlots, freeSlots, NO_SLOTS_TEXT, normalizeScheduling, type Interval, type Scheduling } from "./slots";

// ===========================================================================
// Cuentas conectadas (Microsoft 365 o Google Workspace) de cada usuario:
// enviar desde su correo, leer su calendario para ofrecer huecos, crear
// reuniones, buscar documentos en su Drive y sincronizar correos y reuniones
// con contactos del CRM. Lo específico de cada proveedor está en integrations/.
// ===========================================================================

export type Connection = {
  id: string; user_id: string; user_name: string; provider: ProviderKey; email: string; display_name: string | null;
  status: "active" | "error"; last_error: string | null; scheduling: Scheduling;
  sync_mail: boolean; sync_calendar: boolean; mail_synced_at: Date | null; calendar_synced_at: Date | null; created_at: Date;
};

type Row = Omit<Connection, "scheduling"> & { scheduling: unknown };

const selectConnections = (where = sql``) => sql<Row[]>`
  SELECT m.id, m.user_id, u.name AS user_name, m.provider, m.email, m.display_name, m.status, m.last_error, m.scheduling,
         m.sync_mail, m.sync_calendar, m.mail_synced_at, m.calendar_synced_at, m.created_at
  FROM mailbox_connections m JOIN users u ON u.id = m.user_id
  ${where}
  ORDER BY m.created_at`;

const withScheduling = (rows: Row[]): Connection[] => rows.map((r) => ({ ...r, scheduling: normalizeScheduling(r.scheduling) }));

export const providerOf = (conn: { provider: ProviderKey }): Provider => PROVIDERS[conn.provider];

export async function listConnections(): Promise<Connection[]> {
  return withScheduling(await selectConnections());
}

export async function hasActiveMailbox(): Promise<boolean> {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM mailbox_connections WHERE status = 'active'`;
  return r.n > 0;
}

/** Cuenta desde la que se actúa: la del usuario indicado o, si no tiene, la primera conectada. */
export async function senderFor(ownerId: string | null | undefined): Promise<Connection | null> {
  const rows = withScheduling(await selectConnections(sql`WHERE m.status = 'active'`));
  return rows.find((c) => c.user_id === ownerId) ?? rows[0] ?? null;
}

export async function connectionOf(userId: string): Promise<Connection | null> {
  const [row] = withScheduling(await selectConnections(sql`WHERE m.user_id = ${userId}`));
  return row ?? null;
}

export async function saveConnection(v: {
  userId: string; provider: ProviderKey; email: string; displayName: string | null; tokens: Tokens; scheduling?: Partial<Scheduling>;
}) {
  const scheduling = normalizeScheduling({ ...DEFAULT_SCHEDULING, ...(v.scheduling ?? {}) });
  await sql`
    INSERT INTO mailbox_connections (user_id, provider, email, display_name, tokens, scheduling)
    VALUES (${v.userId}, ${v.provider}, ${v.email}, ${v.displayName}, ${encrypt(JSON.stringify(v.tokens))}, ${json(scheduling)})
    ON CONFLICT (user_id) DO UPDATE SET
      provider = EXCLUDED.provider, email = EXCLUDED.email, display_name = EXCLUDED.display_name, tokens = EXCLUDED.tokens,
      status = 'active', last_error = NULL,
      -- al cambiar de cuenta se empieza a sincronizar de cero; al reconectar la misma, se sigue
      mail_synced_at = CASE WHEN mailbox_connections.email = EXCLUDED.email THEN mailbox_connections.mail_synced_at END,
      calendar_synced_at = CASE WHEN mailbox_connections.email = EXCLUDED.email THEN mailbox_connections.calendar_synced_at END`;
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
  if (res.count === 0) throw new UserError("Ese usuario no tiene ninguna cuenta conectada.");
}

/** Cliente autenticado de una cuenta; guarda los tokens renovados. */
async function clientFor(conn: Connection): Promise<ApiClient> {
  const [row] = await sql<{ tokens: string }[]>`SELECT tokens FROM mailbox_connections WHERE id = ${conn.id}`;
  if (!row) throw new UserError("La cuenta ya no está conectada.");
  const provider = providerOf(conn);
  return apiClient({
    provider: provider.label.split(" ")[0],
    tokens: JSON.parse(decrypt(row.tokens)) as Tokens,
    refresh: provider.refresh,
    save: async (t) => { await sql`UPDATE mailbox_connections SET tokens = ${encrypt(JSON.stringify(t))} WHERE id = ${conn.id}`; },
  });
}

/** Ejecuta algo contra el proveedor; si falla, lo apunta (y marca «reconectar» si se revocó el acceso). */
async function guarded<T>(conn: Connection, fn: (c: ApiClient, p: Provider) => Promise<T>): Promise<T> {
  try {
    return await fn(await clientFor(conn), providerOf(conn));
  } catch (err) {
    if (err instanceof UserError) throw err;
    const reconnect = err instanceof ProviderError && err.needsReconnect;
    await sql`UPDATE mailbox_connections SET last_error = ${providerMessage(err)}, status = ${reconnect ? "error" : "active"}
              WHERE id = ${conn.id}`;
    throw new UserError(providerMessage(err));
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

/** Envía desde el correo de la cuenta (queda en sus «Enviados») y lo registra en el deal. */
export async function sendEmail(conn: Connection, actor: Actor, v: EmailInput) {
  const sent = await guarded(conn, (c, p) => p.send(c, { from: conn.email, to: v.to, subject: v.subject, body: v.body }));
  const activityId = await transaction((tx) => logActivity(tx, actor, {
    type: "email", subject: v.subject, note: `Para: ${v.to.email}\n\n${v.body}`.slice(0, 5000),
    due_at: new Date(), done: true, deal_id: v.dealId ?? null, person_id: v.personId ?? null,
    organization_id: v.organizationId ?? null, owner_id: conn.user_id, external_ref: sent.ref,
  }));
  await sql`UPDATE mailbox_connections SET last_error = NULL WHERE id = ${conn.id}`;
  return { activityId: activityId!, from: conn.email };
}

/** Envía un correo sin registrarlo en ningún deal (p. ej. el parte del día a uno mismo). */
export async function sendPlainEmail(conn: Connection, to: string, subject: string, body: string) {
  await guarded(conn, (c, p) => p.send(c, { from: conn.email, to: { email: to }, subject, body }));
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

/** Huecos libres del calendario de una cuenta según sus preferencias. */
export async function availableSlots(conn: Connection, overrides: Partial<Scheduling> = {}): Promise<Interval[]> {
  const s = normalizeScheduling({ ...conn.scheduling, ...overrides });
  const from = new Date();
  const to = new Date(from.getTime() + (s.horizon_days + 1) * 86400000);
  const events = await guarded(conn, (c, p) => p.events(c, from, to, conn.email.toLowerCase(), s.timezone));
  return freeSlots(events.filter((e) => e.busy).map((e) => ({ start: e.start, end: e.end })), s, from);
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

/** Invita al contacto a una actividad ya creada desde el calendario del responsable (con Teams o Meet si es en línea). */
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
  const minutes = a.duration_minutes ?? conn.scheduling.duration;
  const start = new Date(a.due_at);
  const ev = await guarded(conn, (c, p) => p.createEvent(c, {
    subject: a.subject, start, end: new Date(start.getTime() + minutes * 60000),
    attendees: a.email ? [{ email: a.email, name: a.full_name }] : [], online: a.type !== "meeting" && a.type !== "call",
    body: a.note,
  }));
  await sql`UPDATE activities SET external_ref = ${ev.ref}, meeting_url = coalesce(${ev.joinUrl}, meeting_url),
                                  duration_minutes = ${minutes}
            WHERE id = ${activityId}`;
  return ev;
}

// ---------------------------------------------------------------------------
// Documentos (Drive / OneDrive)

/** Busca archivos por nombre en el almacenamiento de la cuenta del usuario (o de la primera conectada). */
export async function searchDriveFiles(userId: string | null, query: string) {
  const conn = await senderFor(userId);
  if (!conn) throw new UserError("Conecta tu cuenta de Microsoft 365 o Google en Ajustes → Correo, calendario y documentos.");
  const q = query.trim();
  if (q.length < 2) return { provider: conn.provider, files: [] };
  const files = await guarded(conn, (c, p) => p.searchFiles(c, q));
  return { provider: conn.provider, files };
}

// ---------------------------------------------------------------------------
// Sincronización: correos y reuniones con contactos del CRM

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


export type SyncResult = { emails: number; meetings: number; updated: number; error?: string };

export async function syncMailbox(conn: Connection): Promise<SyncResult> {
  const result: SyncResult = { emails: 0, meetings: 0, updated: 0 };
  const own = conn.email.toLowerCase();
  const started = new Date();
  await guarded(conn, async (c, p) => {
    if (conn.sync_mail) {
      const since = conn.mail_synced_at ? new Date(new Date(conn.mail_synced_at).getTime() - 10 * 60000) : new Date(Date.now() - 30 * 86400000);
      for (const m of await p.messages(c, since, own)) {
        const outgoing = m.from === own;
        const others = [...new Set(outgoing ? m.to : [m.from])].filter((e) => e && e !== own);
        const matches = await matchContacts(others);
        const who = others.map((e) => matches.find((x) => x.email === e)).find(Boolean);
        if (!who) continue;
        const id = await transaction((tx) => logActivity(tx, INTEGRATION_ACTOR, {
          type: "email", subject: m.subject || "(sin asunto)",
          note: `${outgoing ? `Enviado a ${others.join(", ")}` : `Recibido de ${m.from}`}\n\n${m.preview ?? ""}`.slice(0, 5000),
          due_at: m.date, done: true, deal_id: who.deal_id, person_id: who.person_id, organization_id: who.organization_id,
          owner_id: conn.user_id, external_ref: m.ref,
        }));
        if (id) result.emails++;
      }
      await sql`UPDATE mailbox_connections SET mail_synced_at = ${started} WHERE id = ${conn.id}`;
    }

    if (conn.sync_calendar) {
      // Reuniones de los dos últimos días (para marcar si se celebraron) y de los próximos 60.
      const events = await p.events(c, new Date(Date.now() - 2 * 86400000), new Date(Date.now() + 60 * 86400000), own, conn.scheduling.timezone);
      for (const e of events) {
        const minutes = Math.max(1, Math.round((e.end.getTime() - e.start.getTime()) / 60000));
        const [existing] = await sql<{ id: string; due_at: Date | null; done: boolean; duration_minutes: number | null; subject: string }[]>`
          SELECT id, due_at, done, duration_minutes, subject FROM activities WHERE external_ref = ${e.ref}`;
        if (existing) {
          if (existing.done) continue;
          if (e.cancelled) {
            await sql`UPDATE activities SET done = true, outcome = 'cancelled' WHERE id = ${existing.id}`;
            result.updated++;
          } else if (existing.due_at?.getTime() !== e.start.getTime() || existing.duration_minutes !== minutes
                     || existing.subject !== (e.subject || existing.subject)) {
            await sql`UPDATE activities SET due_at = ${e.start}, duration_minutes = ${minutes}, subject = ${(e.subject || existing.subject).slice(0, 300)}
                      WHERE id = ${existing.id}`;
            result.updated++;
          }
          continue;
        }
        if (e.cancelled) continue;
        const matches = await matchContacts([...new Set(e.emails.filter((x) => x !== own))]);
        const who = matches.find((m) => m.deal_id) ?? matches[0];
        if (!who) continue;
        // Una reunión futura con el contacto de un deal cuenta como la sesión que pide su fase.
        const type = e.start > new Date() && who.required_activity_type && isSessionType(who.required_activity_type)
          ? who.required_activity_type
          : /\bdemo/i.test(e.subject ?? "") ? "demo" : e.online ? "video_call" : "meeting";
        const id = await transaction((tx) => logActivity(tx, INTEGRATION_ACTOR, {
          type, subject: e.subject || "Reunión", note: null, due_at: e.start, duration_minutes: minutes, done: false,
          deal_id: who.deal_id, person_id: who.person_id, organization_id: who.organization_id, owner_id: conn.user_id,
          external_ref: e.ref, meeting_url: e.joinUrl,
        }));
        if (id) result.meetings++;
      }
      await sql`UPDATE mailbox_connections SET calendar_synced_at = ${started} WHERE id = ${conn.id}`;
    }
  });
  await sql`UPDATE mailbox_connections SET last_error = NULL, status = 'active' WHERE id = ${conn.id}`;
  return result;
}

/** Sincroniza todas las cuentas activas; un fallo en una no para las demás. */
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
