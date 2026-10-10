// Datos del Pipedrive simulado (scripts/mock-providers.mjs).
const H = (n) => n.toString(16).padStart(40, "0");
export const PD_TOKEN = "token-pipedrive-de-pruebas-0123456789";
const OLD = "2026-09-01T10:00:00Z";

export function pipedriveData() {
  const fieldTamano = H(1), fieldPresupuesto = H(2), fieldLinkedin = H(3), fieldIntereses = H(4);
  return {
    me: { id: 1, name: "Jesús PD", email: "jesus@aikit.example", company_name: "Aikit (simulado)" },
    users: [
      { id: 1, name: "Jesús PD", email: "jesus@aikit.example", active_flag: true },
      { id: 2, name: "Laura PD", email: "laura@aikit.example", active_flag: true },
    ],
    activityTypes: [
      { key_string: "call", name: "Llamada", active_flag: true }, { key_string: "meeting", name: "Reunión", active_flag: true },
      { key_string: "task", name: "Tarea", active_flag: true }, { key_string: "lunch", name: "Comida", active_flag: true },
      { key_string: "kickoff_call", name: "Kick-off PD", active_flag: true },
      { key_string: "demo_ventas", name: "Demo", active_flag: true }, // mismo nombre que un tipo del CRM con otra clave
    ],
    pipelines: [{ id: 10, name: "Ventas PD", order_nr: 1, is_deleted: false }],
    stages: [
      { id: 101, pipeline_id: 10, name: "Cualificado", order_nr: 1, deal_probability: 10, is_deal_rot_enabled: true, days_to_rotten: 7 },
      { id: 102, pipeline_id: 10, name: "Demo hecha", order_nr: 2, deal_probability: 40, is_deal_rot_enabled: false },
      { id: 103, pipeline_id: 10, name: "Propuesta", order_nr: 3, deal_probability: 70, is_deal_rot_enabled: true, days_to_rotten: 14 },
    ],
    dealFields: [
      { field_code: "title", field_name: "Title", field_type: "varchar", is_custom_field: false },
      { field_code: fieldTamano, field_name: "Tamaño", field_type: "enum", is_custom_field: true, options: [{ id: 1, label: "Pyme" }, { id: 2, label: "Grande" }] },
      { field_code: fieldPresupuesto, field_name: "Presupuesto aprobado", field_type: "monetary", is_custom_field: true },
      { field_code: H(9), field_name: "Personas", field_type: "people", is_custom_field: true },
    ],
    personFields: [{ field_code: fieldLinkedin, field_name: "LinkedIn PD", field_type: "varchar", is_custom_field: true }],
    organizationFields: [{ field_code: fieldIntereses, field_name: "Intereses", field_type: "set", is_custom_field: true, options: [{ id: 7, label: "IA" }, { id: 8, label: "CRM" }] }],
    organizations: [
      { id: 201, name: "Acme PD", owner_id: 1, address: { value: "Calle Mayor 1, Madrid", locality: "Madrid", country: "España" }, add_time: "2025-01-10T09:00:00Z", update_time: OLD, custom_fields: { [fieldIntereses]: [7, 8] } },
      { id: 202, name: "Beta PD", owner_id: 2, address: null, add_time: "2025-02-10T09:00:00Z", update_time: OLD, custom_fields: {} },
      { id: 203, name: "Gamma PD", owner_id: 1, add_time: "2025-03-10T09:00:00Z", update_time: OLD, custom_fields: {} },
    ],
    persons: [
      { id: 301, name: "Pedro Pérez", first_name: "Pedro", last_name: "Pérez", org_id: 201, owner_id: 1, emails: [{ value: "pedro@acme-pd.example", primary: true, label: "work" }], phones: [{ value: "+34 600 000 001", primary: true, label: "mobile" }], add_time: "2025-01-11T09:00:00Z", update_time: OLD, custom_fields: { [fieldLinkedin]: "https://linkedin.example/pedro" } },
      { id: 302, name: "Marta Gil", org_id: 202, owner_id: 2, emails: [{ value: "marta@beta-pd.example", primary: true, label: "work" }], phones: [], add_time: "2025-02-11T09:00:00Z", update_time: OLD, custom_fields: {} },
      { id: 303, name: "Ana Repetida", org_id: 203, owner_id: 1, emails: [{ value: "ana@paco.example", primary: true, label: "work" }], phones: [], add_time: "2025-03-11T09:00:00Z", update_time: OLD, custom_fields: {} },
      { id: 304, name: "Luis Solo", org_id: null, owner_id: 1, emails: [], phones: [], add_time: "2025-03-12T09:00:00Z", update_time: OLD, custom_fields: {} },
    ],
    leads: [
      { id: "aaaaaaaa-0000-4000-8000-000000000001", title: "Lead de Luis", person_id: 304, organization_id: null, owner_id: 1, source_name: "Web", is_archived: false, add_time: "2025-04-01 10:00:00" },
      { id: "aaaaaaaa-0000-4000-8000-000000000002", title: "Lead sin nadie", person_id: null, organization_id: null, owner_id: 1, source_name: "Web", is_archived: false, add_time: "2025-04-02 10:00:00" },
    ],
    deals: [
      { id: 401, title: "Acme — licencias", value: 12000, currency: "EUR", status: "open", pipeline_id: 10, stage_id: 103, person_id: 301, org_id: 201, owner_id: 1, expected_close_date: "2026-12-01", add_time: "2026-06-01T10:00:00Z", stage_change_time: "2026-08-01T10:00:00Z", update_time: OLD, custom_fields: { [fieldTamano]: 2, [fieldPresupuesto]: { value: 15000, currency: "EUR" } } },
      { id: 402, title: "Beta — piloto", value: 3000, currency: "EUR", status: "won", pipeline_id: 10, stage_id: 103, person_id: 302, org_id: 202, owner_id: 2, add_time: "2026-03-01T10:00:00Z", won_time: "2026-05-01T10:00:00Z", update_time: OLD, custom_fields: { [fieldTamano]: 1 } },
      { id: 403, title: "Gamma — ampliación", value: 5000, currency: "EUR", status: "lost", pipeline_id: 10, stage_id: 102, person_id: 303, org_id: 203, owner_id: 1, add_time: "2026-02-01T10:00:00Z", lost_time: "2026-04-01T10:00:00Z", lost_reason: "Precio demasiado alto", update_time: OLD, custom_fields: {} },
      { id: 404, title: "Huérfano", value: 100, currency: "EUR", status: "lost", pipeline_id: 99, stage_id: 999, person_id: null, org_id: null, owner_id: 1, add_time: "2026-02-01T10:00:00Z", lost_time: "2026-02-02T10:00:00Z", update_time: OLD, custom_fields: {} },
      { id: 405, title: "Borrado", value: 1, currency: "EUR", status: "deleted", is_deleted: true, pipeline_id: 10, stage_id: 101, add_time: "2026-02-01T10:00:00Z", update_time: OLD, custom_fields: {} },
    ],
    activities: [
      { id: 501, subject: "Llamada de cualificación", type: "call", owner_id: 1, deal_id: 401, person_id: 301, org_id: 201, due_date: "2026-06-02", due_time: "09:30:00", duration: "00:30:00", done: true, done_time: "2026-06-02T10:00:00Z", note: "<p>Interesados en <b>40 licencias</b></p>", add_time: "2026-06-01T10:00:00Z", update_time: OLD },
      { id: 502, subject: "Kick-off", type: "kickoff_call", owner_id: 2, deal_id: 402, person_id: 302, due_date: "2026-05-02", due_time: "", done: true, add_time: "2026-05-01T10:00:00Z", update_time: OLD },
      { id: 503, subject: "Comida con Pedro", type: "lunch", owner_id: 1, deal_id: 401, person_id: 301, due_date: "2030-01-15", due_time: "12:00:00", done: false, add_time: "2026-06-01T10:00:00Z", update_time: OLD },
      { id: 504, subject: "Sin nada", type: "task", owner_id: 1, done: false, due_date: "2026-06-01", add_time: "2026-06-01T10:00:00Z", update_time: OLD },
      { id: 505, subject: "Llamar a Luis", type: "demo_ventas", owner_id: 1, lead_id: "aaaaaaaa-0000-4000-8000-000000000001", due_date: "2030-02-01", due_time: "08:00:00", done: false, add_time: "2026-06-01T10:00:00Z", update_time: OLD },
    ],
    notes: [
      { id: 601, content: "<p>Primera reunión: buena sintonía.<br>Piden <i>descuento</i> &amp; plazos</p>", deal_id: 401, person_id: 301, org_id: 201, user_id: 1, add_time: "2026-06-03 10:00:00" },
      { id: 602, content: "<div>Nota de la empresa</div>", deal_id: null, person_id: null, org_id: 202, user_id: 2, add_time: "2026-03-03 10:00:00" },
      { id: 603, content: "", deal_id: 401, user_id: 1, add_time: "2026-06-03 10:00:00" },
    ],
    files: [{ id: 701, name: "Propuesta Acme.pdf", deal_id: 401, url: "https://pd-files.example/701", file_type: "pdf", active_flag: true, add_time: "2026-06-05 10:00:00" }],
    flow: {
      401: [
        { object: "dealChange", data: { field_key: "stage_id", old_value: "101", new_value: "102", log_time: "2026-06-10 10:00:00" } },
        { object: "dealChange", data: { field_key: "stage_id", old_value: "102", new_value: "103", log_time: "2026-08-01 10:00:00" } },
        { object: "activity", data: {} },
      ],
    },
  };
}
