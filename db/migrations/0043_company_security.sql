-- =====================================================================
-- 0043 — Ajustes de empresa, preferencias personales y centro de seguridad
-- =====================================================================

BEGIN;
ALTER TABLE app_settings
  ADD COLUMN company_name      text,
  ADD COLUMN company_logo      text,                    -- data:image/… (pequeño, se enseña en la entrada y los correos)
  ADD COLUMN default_currency  char(3) NOT NULL DEFAULT 'EUR',
  ADD COLUMN company_timezone  text NOT NULL DEFAULT 'Europe/Madrid',
  -- Reglas de seguridad
  ADD COLUMN session_days      integer NOT NULL DEFAULT 30 CHECK (session_days BETWEEN 1 AND 90),
  ADD COLUMN idle_hours        integer CHECK (idle_hours IS NULL OR idle_hours BETWEEN 1 AND 720),
  ADD COLUMN export_admin_only boolean NOT NULL DEFAULT false,
  ADD COLUMN alert_new_device  boolean NOT NULL DEFAULT true;

-- Preferencias de cada persona (página de inicio, densidad de las tablas…)
ALTER TABLE users ADD COLUMN ui_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Alertas de seguridad (intentos fallidos, nuevos administradores, exportaciones, dispositivos nuevos…)
CREATE TABLE security_alerts (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  kind             text NOT NULL,
  severity         text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'high')),
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,     -- a quién afecta
  actor_id         uuid REFERENCES users(id) ON DELETE SET NULL,     -- quién lo hizo
  title            text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX security_alerts_at_idx ON security_alerts (at DESC);
CREATE INDEX security_alerts_open_idx ON security_alerts (at DESC) WHERE acknowledged_at IS NULL;

-- Quién descarga qué
CREATE TABLE export_log (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  dataset   text NOT NULL,
  rows      integer NOT NULL DEFAULT 0,
  ip        text
);
CREATE INDEX export_log_at_idx ON export_log (at DESC);
COMMIT;
