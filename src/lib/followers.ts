import { sql, type Db } from "./db";
import { UserError } from "./errors";

// ===========================================================================
// Seguidores (como en Pipedrive): cualquiera del equipo puede seguir un deal,
// un contacto, una empresa o un lead y le llegan avisos de lo importante.
// ===========================================================================

export type FollowEntity = "deal" | "person" | "organization" | "lead";
export const FOLLOW_ENTITIES: FollowEntity[] = ["deal", "person", "organization", "lead"];
export type Follower = { user_id: string; name: string };

export async function listFollowers(type: FollowEntity, id: string): Promise<Follower[]> {
  return sql<Follower[]>`
    SELECT f.user_id, u.name FROM followers f JOIN users u ON u.id = f.user_id
    WHERE f.entity_type = ${type} AND f.entity_id = ${id} ORDER BY f.created_at`;
}

export async function follow(type: FollowEntity, id: string, userId: string) {
  if (!FOLLOW_ENTITIES.includes(type)) throw new UserError("No se puede seguir eso.");
  await sql`INSERT INTO followers (entity_type, entity_id, user_id) VALUES (${type}, ${id}, ${userId}) ON CONFLICT DO NOTHING`;
}

export async function unfollow(type: FollowEntity, id: string, userId: string) {
  await sql`DELETE FROM followers WHERE entity_type = ${type} AND entity_id = ${id} AND user_id = ${userId}`;
}

/** Qué eventos avisan a los seguidores (y con qué texto). */
export const FOLLOW_EVENTS: Record<string, (p: Record<string, unknown>) => string> = {
  "deal.stage_changed": (p) => `Ha pasado a «${p.to_stage ?? p.stage ?? "otra fase"}»`,
  "deal.won": () => "¡Ganado!",
  "deal.lost": (p) => `Perdido${p.reason ? `: ${p.reason}` : ""}`,
  "deal.reopened": () => "Se ha reabierto",
  "deal.owner_changed": () => "Ha cambiado de responsable",
  "deal.booked": (p) => `${p.name ?? "El contacto"} ha reservado una reunión`,
  "deal.health_red": () => "Está en riesgo",
  "email.received": (p) => `Ha respondido${p.subject ? `: «${p.subject}»` : ""}`,
  "proposal.viewed": () => "El cliente ha abierto la propuesta",
  "proposal.accepted": () => "¡Propuesta aceptada!",
  "proposal.declined": () => "Propuesta rechazada",
  "person.changed_company": (p) => `Ha cambiado de empresa${p.organization ? `: ${p.organization}` : ""}`,
  "account.health_red": () => "La cuenta está en riesgo",
  "lead.converted": () => "Se ha convertido en deal",
  "note.created": (p) => `Nueva nota${p.excerpt ? `: «${String(p.excerpt).slice(0, 80)}»` : ""}`,
  "file.added": (p) => `Nuevo archivo: ${p.name ?? ""}`,
  "call.logged": (p) => `Llamada registrada${p.outcome ? ` (${p.outcome})` : ""}`,
};

const PATH: Record<FollowEntity, string> = { deal: "deals", person: "persons", organization: "organizations", lead: "leads" };

/** Avisa a quien sigue algo (menos a quien lo hizo y a quien ya avisó otra regla). */
export async function notifyFollowers(db: Db, type: string, id: string, eventType: string, payload: Record<string, unknown>,
                                      actorId: string | null, skip: (string | null)[] = []) {
  const text = FOLLOW_EVENTS[eventType];
  if (!text || !FOLLOW_ENTITIES.includes(type as FollowEntity)) return;
  const rows = await db<{ user_id: string }[]>`SELECT user_id FROM followers WHERE entity_type = ${type} AND entity_id = ${id}`;
  const to = rows.map((r) => r.user_id).filter((u) => u !== actorId && !skip.includes(u));
  if (!to.length) return;
  const t = type as FollowEntity;
  if (payload.to_stage_id) {
    const [st] = await db<{ name: string }[]>`SELECT name FROM stages WHERE id = ${String(payload.to_stage_id)}`;
    payload = { ...payload, to_stage: st?.name };
  }
  const [name] = await db<{ n: string }[]>`
    SELECT CASE ${t}::text WHEN 'deal' THEN (SELECT title FROM deals WHERE id = ${id})
                           WHEN 'person' THEN (SELECT full_name FROM persons WHERE id = ${id})
                           WHEN 'organization' THEN (SELECT name FROM organizations WHERE id = ${id})
                           ELSE (SELECT title FROM leads WHERE id = ${id}) END AS n`;
  for (const u of to) {
    await db`INSERT INTO notifications (user_id, kind, title, body, link, actor_id)
             VALUES (${u}, 'follow', ${`${name?.n ?? ""}: ${text(payload)}`.slice(0, 300)}, NULL, ${`/${PATH[t]}/${id}`}, ${actorId})`;
  }
}
