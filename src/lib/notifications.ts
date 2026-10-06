import { sql, type Db } from "./db";
import type { Actor, EntityType } from "./events";

// ===========================================================================
// Avisos para cada persona: menciones en notas y lo que pasa en sus deals
// (se los asignan, el cliente responde, reserva, abre o acepta una propuesta…).
// ===========================================================================

export type Notification = { id: string; kind: string; title: string; body: string | null; link: string | null; read_at: Date | null; created_at: Date; actor_name: string | null };

export async function listNotifications(userId: string, limit = 50): Promise<Notification[]> {
  return sql<Notification[]>`
    SELECT n.id, n.kind, n.title, n.body, n.link, n.read_at, n.created_at, u.name AS actor_name
    FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
    WHERE n.user_id = ${userId} ORDER BY n.created_at DESC LIMIT ${limit}`;
}

export async function unreadCount(userId: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${userId} AND read_at IS NULL`;
  return r.n;
}

export async function markRead(userId: string, id?: string) {
  if (id) await sql`UPDATE notifications SET read_at = now() WHERE id = ${id} AND user_id = ${userId} AND read_at IS NULL`;
  else await sql`UPDATE notifications SET read_at = now() WHERE user_id = ${userId} AND read_at IS NULL`;
}

export async function notify(db: Db, n: { userId: string; kind: string; title: string; body?: string | null; link?: string | null; actorId?: string | null }) {
  await db`INSERT INTO notifications (user_id, kind, title, body, link, actor_id)
           VALUES (${n.userId}, ${n.kind}, ${n.title.slice(0, 300)}, ${n.body?.slice(0, 1000) ?? null}, ${n.link ?? null}, ${n.actorId ?? null})`;
}

/** Eventos de un deal que interesan a su responsable. */
const DEAL_EVENTS: Record<string, (p: Record<string, unknown>) => string> = {
  "email.received": (p) => `Te han respondido${p.subject ? `: «${p.subject}»` : ""}`,
  "deal.booked": (p) => `${p.name ?? "El contacto"} ha reservado una reunión`,
  "proposal.viewed": () => "El cliente ha abierto la propuesta",
  "proposal.accepted": (p) => `¡Propuesta aceptada${p.name ? ` por ${p.name}` : ""}!`,
  "proposal.declined": (p) => `Propuesta rechazada${p.name ? ` por ${p.name}` : ""}`,
};

/** Se llama al registrar cada evento: genera los avisos que tocan. */
export async function notifyForEvent(db: Db, actor: Actor, entityType: EntityType, entityId: string, eventType: string, payload: Record<string, unknown>) {
  if (entityType === "deal" && eventType === "deal.owner_changed") {
    const to = payload.to_owner_id as string | null;
    if (!to || to === actor.id) return;
    const [d] = await db<{ title: string }[]>`SELECT title FROM deals WHERE id = ${entityId}`;
    await notify(db, { userId: to, kind: "assigned", title: `Te han asignado «${d?.title ?? "un deal"}»`, link: `/deals/${entityId}`, actorId: actor.id });
    return;
  }
  if (entityType === "lead" && eventType === "lead.assigned") {
    const to = payload.owner_id as string | null;
    if (!to) return;
    const [l] = await db<{ title: string }[]>`SELECT title FROM leads WHERE id = ${entityId}`;
    await notify(db, { userId: to, kind: "assigned", title: `Nuevo lead para ti: ${l?.title ?? ""}`, link: `/leads/${entityId}` });
    return;
  }
  const text = entityType === "deal" ? DEAL_EVENTS[eventType] : undefined;
  if (!text) return;
  const [d] = await db<{ owner_id: string | null; title: string }[]>`SELECT owner_id, title FROM deals WHERE id = ${entityId}`;
  if (!d?.owner_id || d.owner_id === actor.id) return;
  await notify(db, { userId: d.owner_id, kind: eventType, title: text(payload), body: d.title, link: `/deals/${entityId}` });
}

/** Menciones «@Nombre» en una nota: avisa a esas personas del equipo. */
export async function notifyMentions(db: Db, actor: Actor, content: string, link: string, where: string) {
  if (!content.includes("@")) return;
  const users = await db<{ id: string; name: string }[]>`SELECT id, name FROM users WHERE kind = 'human' AND is_active`;
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const text = norm(content);
  const done = new Set<string>();
  // Primero el nombre completo; si no, el nombre de pila (si no es ambiguo).
  for (const u of [...users].sort((a, b) => b.name.length - a.name.length)) {
    const full = norm(u.name);
    const first = full.split(/\s+/)[0];
    const firstUnique = users.filter((x) => norm(x.name).split(/\s+/)[0] === first).length === 1;
    const hit = text.includes(`@${full}`) || (firstUnique && new RegExp(`@${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "u").test(text));
    if (!hit || done.has(u.id) || u.id === actor.id) continue;
    done.add(u.id);
    await notify(db, { userId: u.id, kind: "mention", title: `Te han mencionado en ${where}`, body: content.slice(0, 300), link, actorId: actor.id });
  }
}
