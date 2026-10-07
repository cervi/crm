-- =====================================================================
-- 0031 — Ficha de contacto y empresa como en Pipedrive
--
--   · Seguidores de deals, contactos, empresas y leads: reciben avisos de lo
--     que pasa (respuestas, cambios de fase, notas…).
--   · Archivos subidos a un deal, contacto, empresa o lead (se guardan en la
--     base de datos: sin depender de un almacenamiento aparte).
--   · Registro de llamadas: resultado (contestó, no contestó, buzón…).
--   · Etiquetas de colores (las tablas ya existían): color por defecto.
-- =====================================================================

BEGIN;

CREATE TABLE followers (
  entity_type text NOT NULL CHECK (entity_type IN ('deal', 'person', 'organization', 'lead')),
  entity_id   uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, user_id)
);
CREATE INDEX followers_user_idx ON followers (user_id);

CREATE TABLE files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  mime            text NOT NULL DEFAULT 'application/octet-stream',
  size            integer NOT NULL CHECK (size >= 0),
  data            bytea NOT NULL,
  deal_id         uuid REFERENCES deals(id) ON DELETE CASCADE,
  person_id       uuid REFERENCES persons(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES leads(id) ON DELETE CASCADE,
  uploaded_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (deal_id IS NOT NULL OR person_id IS NOT NULL OR organization_id IS NOT NULL OR lead_id IS NOT NULL)
);
CREATE INDEX files_deal_idx ON files (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX files_person_idx ON files (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX files_org_idx ON files (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX files_lead_idx ON files (lead_id) WHERE lead_id IS NOT NULL;

ALTER TABLE activities ADD COLUMN call_outcome text
  CHECK (call_outcome IN ('answered', 'no_answer', 'voicemail', 'busy', 'wrong_number'));

UPDATE tags SET color = 'blue' WHERE color IS NULL;
ALTER TABLE tags ALTER COLUMN color SET DEFAULT 'blue';

COMMIT;
