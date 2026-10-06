-- =====================================================================
-- 0009_export.sql — Preferencias de exportación a CSV
-- =====================================================================

BEGIN;

CREATE TABLE app_settings (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- «;» es lo que espera Excel en español (la coma es el separador decimal).
  csv_separator  text NOT NULL DEFAULT ';' CHECK (csv_separator IN (';', ',', 'tab')),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_settings DEFAULT VALUES;

COMMIT;
