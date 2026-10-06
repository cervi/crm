-- =====================================================================
-- 0011_pipedrive_import.sql — Importación (repetible) desde Pipedrive
--
--   import_jobs   Cada importación: por pasos y reanudable (se procesa a
--                 trozos, así funciona también en alojamientos sin procesos
--                 permanentes), con contadores, avisos y la comprobación final.
--   app_settings  Token de Pipedrive (cifrado) y sincronización periódica
--                 mientras se convive con Pipedrive.
-- =====================================================================

BEGIN;

ALTER TABLE app_settings
  ADD COLUMN pipedrive_token   text,          -- cifrado con TOKEN_ENCRYPTION_KEY
  ADD COLUMN pipedrive_company text,
  ADD COLUMN pipedrive_sync    boolean NOT NULL DEFAULT false;

CREATE TABLE import_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source      text NOT NULL DEFAULT 'pipedrive' CHECK (source IN ('pipedrive')),
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
  step        text NOT NULL,
  cursor      text,
  options     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { flow, files, since }
  counts      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- por entidad: creados / actualizados / omitidos
  warnings    text[] NOT NULL DEFAULT '{}',
  verify      jsonb,                                -- totales de Pipedrive frente al CRM
  error       text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- Una sola importación en marcha a la vez.
CREATE UNIQUE INDEX import_jobs_one_running ON import_jobs (source) WHERE status = 'running';

CREATE UNIQUE INDEX custom_field_definitions_pipedrive_uq
  ON custom_field_definitions (entity_type, pipedrive_key) WHERE pipedrive_key IS NOT NULL;
CREATE UNIQUE INDEX deal_documents_pipedrive_uq ON deal_documents (external_id) WHERE external_id LIKE 'pd:%';

COMMIT;
