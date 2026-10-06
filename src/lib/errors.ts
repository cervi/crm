/** Error con mensaje pensado para mostrarse al usuario. */
export class UserError extends Error {}

// Mensajes legibles para las restricciones de la base de datos.
const CONSTRAINT_MESSAGES: Record<string, string> = {
  organizations_domain_uq: "Ya existe una empresa con ese dominio.",
  person_emails_email_uq: "Ya existe un contacto con ese email.",
  pipelines_name_uq: "Ya existe un pipeline con ese nombre.",
  tags_name_uq: "Ya existe una etiqueta con ese nombre.",
  lost_reasons_label_key: "Ya existe un motivo de pérdida con ese texto.",
  custom_field_definitions_entity_type_key_key: "Ya existe un campo con esa clave.",
  deals_stage_id_pipeline_id_fkey: "La fase no pertenece al pipeline elegido.",
  person_organizations_current_uq: "El contacto ya trabaja en esa empresa.",
  deal_documents_url_uq: "Ese documento ya está enlazado a este deal.",
};

/** Traduce un error (de validación o de PostgreSQL) a un mensaje para la interfaz. */
export function toUserMessage(err: unknown): string {
  if (err instanceof UserError) return err.message;
  const e = err as { code?: string; constraint_name?: string; message?: string };
  if (e?.constraint_name && CONSTRAINT_MESSAGES[e.constraint_name]) {
    return CONSTRAINT_MESSAGES[e.constraint_name];
  }
  switch (e?.code) {
    case "23505": return "Ya existe un registro con esos datos.";
    case "23503": return "Hay datos relacionados que impiden la operación.";
    case "23514":
    case "23502": return "Algún dato no es válido.";
  }
  console.error(err);
  return "Ha ocurrido un error inesperado.";
}

export type ActionState = { error?: string; ok?: boolean } | undefined;

/** Ejecuta una acción de formulario y convierte los errores en estado para la interfaz. */
export async function attempt(fn: () => Promise<unknown>): Promise<ActionState> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}
