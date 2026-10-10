import { json, safely, type Db } from "./db";
import { notifyForEvent } from "./notifications";

export type EntityType = "organization" | "person" | "lead" | "deal" | "activity" | "note";
export type Actor = { type: "user" | "ai_agent" | "system" | "integration"; id: string | null };

// Hasta que haya inicio de sesión por usuario, las acciones de la interfaz se
// atribuyen a "usuario" sin identificar.
export const UI_ACTOR: Actor = { type: "user", id: null };
export const INTEGRATION_ACTOR: Actor = { type: "integration", id: null };
/** Usuario con el que actúa el asistente de IA interno (migración 0004). */
export const AI_USER_ID = "00000000-0000-0000-0000-0000000000a1";
export const AI_ACTOR: Actor = { type: "ai_agent", id: AI_USER_ID };

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
  // Los avisos no deben romper nunca la acción que los provoca: dentro de una
  // transacción van en un «savepoint», para que un fallo no la anule.
  await safely(db, "avisos", (d) => notifyForEvent(d, actor, entityType, entityId, eventType, payload));
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
  "lead.updated": "Lead actualizado",
  "deal.created": "Deal creado",
  "deal.updated": "Deal actualizado",
  "deal.owner_changed": "Cambio de responsable",
  "deal.booked": "Reunión reservada por el contacto",
  "sequence.enrolled": "Añadido a una secuencia",
  "lead.assigned": "Asignado automáticamente",
  "proposal.created": "Propuesta creada",
  "deal.deleted": "Deal borrado", "deal.restored": "Deal recuperado de la papelera",
  "person.merged": "Fusionado con duplicados", "organization.merged": "Fusionada con duplicados",
  "proposal.viewed": "El cliente abrió la propuesta",
  "proposal.accepted": "Propuesta aceptada por el cliente",
  "proposal.declined": "Propuesta rechazada por el cliente",
  "sequence.stopped": "Secuencia parada",
  "email.opened": "Abrió un correo",
  "email.reopened": "Volvió a abrir un correo",
  "proposal.reviewed": "El cliente volvió a abrir la propuesta",
  "deal.health_red": "Salud del deal en rojo",
  "deal.close_date_changed": "Cambio de fecha de cierre",
  "deal.plan_created": "Plan de cierre creado",
  "deal.onboarding_started": "Cliente en marcha: contrato y onboarding creados",
  "survey.answered": "El cliente respondió la encuesta",
  "contract.created": "Contrato creado",
  "contract.updated": "Contrato actualizado",
  "account.health_red": "Salud de la cuenta en rojo",
  "person.unsubscribed": "Se dio de baja de las comunicaciones",
  "campaign.interested": "Interesado en una campaña de outbound",
  "deal.plan_step_done": "Paso del plan de cierre hecho",
  "deal.discount_requested": "Descuento pendiente de aprobación",
  "deal.discount_approved": "Descuento aprobado",
  "deal.discount_rejected": "Descuento rechazado (ajustado al límite)",
  "email.clicked": "Hizo clic en un enlace de un correo",
  "email.received": "Correo recibido",
  "email.scheduled": "Correo programado",
  "deal.stage_changed": "Cambio de fase",
  "deal.pipeline_changed": "Cambio de pipeline",
  "deal.won": "Deal ganado",
  "deal.lost": "Deal perdido",
  "deal.reopened": "Deal reabierto",
  "deal.participant_added": "Contacto añadido al deal",
  "deal.participant_removed": "Contacto quitado del deal",
  "activity.created": "Actividad creada",
  "activity.completed": "Actividad completada",
  "activity.deleted": "Actividad borrada",
  "note.created": "Nota añadida",
  "ai.action_undone": "Acción de la IA deshecha",
  "deal.document_added": "Documento enlazado",
  "deal.document_removed": "Documento quitado",
  "file.added": "Archivo añadido",
  "file.removed": "Archivo borrado",
  "call.logged": "Llamada registrada",
  "person.tags_changed": "Etiquetas cambiadas",
  "organization.tags_changed": "Etiquetas cambiadas",
  "deal.tags_changed": "Etiquetas cambiadas",
  "lead.tags_changed": "Etiquetas cambiadas",
  "person.owner_changed": "Cambio de responsable",
  "organization.owner_changed": "Cambio de responsable",
};

export const eventLabel = (type: string) => LABELS[type] ?? type;
