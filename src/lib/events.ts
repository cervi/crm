import { json, type Db } from "./db";

export type EntityType = "organization" | "person" | "lead" | "deal" | "activity" | "note";
export type Actor = { type: "user" | "ai_agent" | "system" | "integration"; id: string | null };

// Hasta que haya inicio de sesión por usuario, las acciones de la interfaz se
// atribuyen a "usuario" sin identificar.
export const UI_ACTOR: Actor = { type: "user", id: null };
export const INTEGRATION_ACTOR: Actor = { type: "integration", id: null };

/**
 * Registra un evento. Es el historial de cada ficha, la auditoría de lo que
 * hace la IA y la entrada del futuro motor de automatizaciones.
 */
export async function recordEvent(
  db: Db,
  actor: Actor,
  entityType: EntityType,
  entityId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
) {
  await db`
    INSERT INTO events (entity_type, entity_id, event_type, actor_type, actor_id, payload)
    VALUES (${entityType}, ${entityId}, ${eventType}, ${actor.type}, ${actor.id}, ${json(payload)})`;
}

export type TimelineEvent = {
  id: string;
  occurred_at: Date;
  entity_type: EntityType;
  event_type: string;
  actor_type: Actor["type"];
  actor_name: string | null;
  payload: Record<string, unknown>;
};

/** Historial de una o varias entidades, más reciente primero. */
export async function timeline(db: Db, refs: { type: EntityType; id: string }[], limit = 50) {
  if (refs.length === 0) return [];
  const keys = refs.map((r) => `${r.type}:${r.id}`);
  return db<TimelineEvent[]>`
    SELECT e.id::text, e.occurred_at, e.entity_type, e.event_type, e.actor_type,
           u.name AS actor_name, e.payload
    FROM events e LEFT JOIN users u ON u.id = e.actor_id
    WHERE (e.entity_type || ':' || e.entity_id::text) IN ${db(keys)}
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ${limit}`;
}

const LABELS: Record<string, string> = {
  "organization.created": "Empresa creada",
  "organization.updated": "Empresa actualizada",
  "person.created": "Contacto creado",
  "person.updated": "Contacto actualizado",
  "person.changed_company": "Cambio de empresa",
  "lead.created": "Lead creado",
  "lead.form_submitted": "Formulario recibido",
  "lead.converted": "Lead convertido en deal",
  "lead.archived": "Lead archivado",
  "deal.created": "Deal creado",
  "deal.updated": "Deal actualizado",
  "deal.stage_changed": "Cambio de fase",
  "deal.pipeline_changed": "Cambio de pipeline",
  "deal.won": "Deal ganado",
  "deal.lost": "Deal perdido",
  "deal.reopened": "Deal reabierto",
  "deal.participant_added": "Contacto añadido al deal",
  "deal.participant_removed": "Contacto quitado del deal",
  "activity.created": "Actividad creada",
  "activity.completed": "Actividad completada",
  "note.created": "Nota añadida",
};

export const eventLabel = (type: string) => LABELS[type] ?? type;
