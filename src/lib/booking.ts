import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "./db";
import { UserError } from "./errors";
import { publicBase } from "./email-track";
import { recordEvent, INTEGRATION_ACTOR } from "./events";
import { ingestLead } from "./leads";
import { addActivityToCalendar, availableSlots, connectionOf } from "./mailbox";
import { createActivity } from "./activities";
import type { SessionUser } from "./session";
import type { Interval } from "./slots";
import { parse, text } from "./validation";

// ===========================================================================
// Enlace de reserva: cada persona del equipo tiene una página pública
// (/book/<nombre>) con sus huecos libres. Quien reserva recibe la invitación
// del calendario y la reunión queda en su deal (o se crea uno si es nuevo).
// ===========================================================================

export type BookingPage = {
  id: string; user_id: string; slug: string; title: string; description: string | null;
  duration_minutes: number; activity_type: string; is_active: boolean; user_name: string;
};

const selectPage = (where: ReturnType<typeof sql>) => sql<BookingPage[]>`
  SELECT b.id, b.user_id, b.slug, b.title, b.description, b.duration_minutes, b.activity_type, b.is_active, u.name AS user_name
  FROM booking_pages b JOIN users u ON u.id = b.user_id ${where}`;

export async function myBookingPage(userId: string): Promise<BookingPage | null> {
  const [p] = await selectPage(sql`WHERE b.user_id = ${userId}`);
  return p ?? null;
}

export async function pageBySlug(slug: string): Promise<BookingPage | null> {
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(slug)) return null;
  const [p] = await selectPage(sql`WHERE b.slug = ${slug} AND b.is_active AND u.is_active`);
  return p ?? null;
}

export const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

const pageSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{2,40}$/, "La dirección: entre 3 y 41 letras, números o guiones, sin tildes."),
  title: text("El título", 120),
  description: z.string().trim().max(1000).optional(),
  duration_minutes: z.coerce.number().int().min(10, "Mínimo 10 minutos").max(240, "Máximo 4 horas"),
  activity_type: z.string().trim().min(1),
  is_active: z.string().optional(),
});

export async function saveBookingPage(user: SessionUser, data: unknown) {
  const v = parse(pageSchema, data);
  const [taken] = await sql`SELECT 1 FROM booking_pages WHERE slug = ${v.slug} AND user_id <> ${user.id}`;
  if (taken) throw new UserError("Esa dirección ya la usa otra persona.");
  await sql`
    INSERT INTO booking_pages (user_id, slug, title, description, duration_minutes, activity_type, is_active)
    VALUES (${user.id}, ${v.slug}, ${v.title}, ${v.description || null}, ${v.duration_minutes}, ${v.activity_type}, ${v.is_active === "on"})
    ON CONFLICT (user_id) DO UPDATE SET slug = EXCLUDED.slug, title = EXCLUDED.title, description = EXCLUDED.description,
      duration_minutes = EXCLUDED.duration_minutes, activity_type = EXCLUDED.activity_type, is_active = EXCLUDED.is_active`;
}

/** Huecos que se ofrecen en la página (más que en un correo: hasta dos semanas). */
export async function bookingSlots(page: BookingPage): Promise<{ slots: Interval[]; timezone: string } | null> {
  const conn = await connectionOf(page.user_id);
  if (!conn || conn.status !== "active") return null;
  const slots = await availableSlots(conn, { duration: page.duration_minutes, count: 60, per_day: 8, horizon_days: 14 });
  return { slots, timezone: conn.scheduling.timezone };
}

/** Enlace personal de reserva para un contacto de un deal (o null si el responsable no tiene página). */
export async function bookingLinkFor(userId: string | null, dealId: string, personId: string | null): Promise<string | null> {
  const base = publicBase();
  if (!userId || !base) return null;
  const page = await myBookingPage(userId);
  if (!page?.is_active) return null;
  const [existing] = await sql<{ token: string }[]>`
    SELECT token FROM booking_links WHERE page_id = ${page.id} AND deal_id = ${dealId} AND person_id IS NOT DISTINCT FROM ${personId}`;
  let token = existing?.token;
  if (!token) {
    token = randomBytes(12).toString("base64url");
    await sql`INSERT INTO booking_links (token, page_id, deal_id, person_id) VALUES (${token}, ${page.id}, ${dealId}, ${personId})
              ON CONFLICT DO NOTHING`;
    const [again] = await sql<{ token: string }[]>`
      SELECT token FROM booking_links WHERE page_id = ${page.id} AND deal_id = ${dealId} AND person_id IS NOT DISTINCT FROM ${personId}`;
    token = again?.token ?? token;
  }
  return `${base}/book/${page.slug}?r=${token}`;
}

export type LinkContext = { deal_id: string | null; person_id: string | null; name: string | null; email: string | null; deal_title: string | null };

export async function linkContext(page: BookingPage, token: string | null | undefined): Promise<LinkContext | null> {
  if (!token || !/^[A-Za-z0-9_-]{10,40}$/.test(token)) return null;
  const [r] = await sql<LinkContext[]>`
    SELECT l.deal_id, l.person_id, p.full_name AS name, d.title AS deal_title,
           (SELECT email FROM person_emails WHERE person_id = l.person_id ORDER BY is_primary DESC, created_at LIMIT 1) AS email
    FROM booking_links l LEFT JOIN persons p ON p.id = l.person_id LEFT JOIN deals d ON d.id = l.deal_id AND d.deleted_at IS NULL
    WHERE l.token = ${token} AND l.page_id = ${page.id}`;
  return r ?? null;
}

const bookSchema = z.object({
  name: text("Tu nombre", 200),
  email: z.string().trim().toLowerCase().pipe(z.email("Email no válido")),
  company: z.string().trim().max(200).optional(),
  start: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "Elige un hueco."),
  note: z.string().trim().max(2000).optional(),
  r: z.string().optional(),
});

export type BookingDone = { start: Date; end: Date; timezone: string; joinUrl: string | null };

/** Reserva un hueco: comprueba que sigue libre, crea la reunión con invitación y la deja en el deal. */
export async function book(slug: string, data: unknown): Promise<BookingDone> {
  const page = await pageBySlug(slug);
  if (!page) throw new UserError("Esta página de reservas ya no está disponible.");
  const v = parse(bookSchema, data);

  // Límite sencillo contra abusos.
  const [{ recent }] = await sql<{ recent: number }[]>`
    SELECT count(*)::int AS recent FROM activities a
    LEFT JOIN person_emails pe ON pe.person_id = a.person_id
    WHERE a.booked_via = ${page.id} AND a.created_at > now() - interval '1 day' AND lower(pe.email) = ${v.email}`;
  if (recent >= 3) throw new UserError("Ya tienes varias reuniones reservadas hoy. Si necesitas otra, escríbenos.");

  const available = await bookingSlots(page);
  if (!available) throw new UserError("Ahora mismo no se pueden hacer reservas. Inténtalo más tarde.");
  const start = new Date(v.start);
  const slot = available.slots.find((s) => s.start.getTime() === start.getTime());
  if (!slot) throw new UserError("Ese hueco ya no está libre: elige otro.");

  const ctx = await linkContext(page, v.r);
  let dealId = ctx?.deal_id ?? null;
  let personId = ctx?.email && ctx.email.toLowerCase() === v.email ? ctx.person_id : null;
  let leadId: string | null = null;
  if (!personId) {
    // Contacto nuevo o distinto: entra como solicitud de reunión (crea o reutiliza contacto, lead y deal).
    const r = await ingestLead(INTEGRATION_ACTOR, {
      email: v.email, full_name: v.name, company: v.company || undefined, source: "enlace de reserva",
      source_detail: page.title, intent: "demo_request", message: v.note || undefined,
    });
    personId = r.person_id;
    leadId = r.lead_id;
    dealId ??= r.deal_id;
    if (r.deal_id) await sql`UPDATE deals SET owner_id = coalesce(owner_id, ${page.user_id}) WHERE id = ${r.deal_id}`;
  }

  const activityId = await createActivity(INTEGRATION_ACTOR, {
    type: page.activity_type, subject: `${page.title} con ${v.name}`.slice(0, 300),
    note: [`Reservada por ${v.name} (${v.email}) desde el enlace de reserva.`, v.note].filter(Boolean).join("\n\n"),
    due_at: start.toISOString(), duration_minutes: page.duration_minutes,
    deal_id: dealId ?? undefined, lead_id: dealId ? undefined : leadId ?? undefined, person_id: personId, owner_id: page.user_id,
  });
  await sql`UPDATE activities SET booked_via = ${page.id} WHERE id = ${activityId}`;
  let joinUrl: string | null = null;
  try {
    const ev = await addActivityToCalendar(activityId);
    joinUrl = ev.joinUrl ?? null;
  } catch (err) {
    console.error("[reserva] no se pudo crear la reunión en el calendario", err);
  }
  if (dealId) await recordEvent(sql, INTEGRATION_ACTOR, "deal", dealId, "deal.booked", { activity_id: activityId, start: start.toISOString(), name: v.name });
  return { start: slot.start, end: slot.end, timezone: available.timezone, joinUrl };
}
