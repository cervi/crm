-- =====================================================================
-- 0010_activity_types_custom_rules.sql
--
--   activity_types   Tipos de actividad configurables (los de serie y los
--                    vuestros: onboarding, kick-off, envío de propuesta…).
--                    «is_session»: es una sesión con el cliente (cuenta como
--                    la sesión de una fase y dispara el resumen tras reunión).
--   Reglas personalizadas: «cuando una actividad de tal tipo se hace (con tal
--   resultado) o sigue sin hacerse N días después, haz tal cosa».
-- =====================================================================

BEGIN;

CREATE TABLE activity_types (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{2,40}$'),
  label       text NOT NULL CHECK (length(trim(label)) > 0),
  is_session  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true,
  is_builtin  boolean NOT NULL DEFAULT false,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_types_label_uq UNIQUE (label)
);
INSERT INTO activity_types (key, label, is_session, is_builtin, position) VALUES
  ('call', 'Llamada', true, true, 1),
  ('meeting', 'Reunión', true, true, 2),
  ('video_call', 'Videollamada', true, true, 3),
  ('demo', 'Demo', true, true, 4),
  ('email', 'Email', false, true, 5),
  ('task', 'Tarea', false, true, 6),
  ('deadline', 'Fecha límite', false, true, 7);

ALTER TABLE activities DROP CONSTRAINT activities_type_check;
ALTER TABLE activities ADD CONSTRAINT activities_type_fkey
  FOREIGN KEY (type) REFERENCES activity_types(key) ON UPDATE CASCADE;
ALTER TABLE stages DROP CONSTRAINT stages_required_activity_type_check;
ALTER TABLE stages ADD CONSTRAINT stages_required_activity_type_fkey
  FOREIGN KEY (required_activity_type) REFERENCES activity_types(key) ON UPDATE CASCADE;

-- Reglas personalizadas: disparador y acción configurables.
ALTER TABLE automation_rules
  ADD COLUMN is_custom boolean NOT NULL DEFAULT false,
  ADD COLUMN trigger   jsonb,
  ADD COLUMN action    jsonb,
  ADD CONSTRAINT automation_rules_custom_check CHECK (NOT is_custom OR (trigger IS NOT NULL AND action IS NOT NULL));

COMMIT;
