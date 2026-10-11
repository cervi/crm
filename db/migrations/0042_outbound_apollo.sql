-- =====================================================================
-- 0042 — Secuencias de outbound al estilo Apollo
--   Horarios de envío reutilizables (hora local del contacto, festivos),
--   ritmo por buzón, reglas (clic, misma empresa, aperturas → llamada,
--   límite diario, CC/BCC), pasos multicanal que esperan a la tarea,
--   gestión de contactos (pausa con reanudación, quitar, cambiar buzón),
--   hilos de correo de verdad y organización (carpetas, archivo).
-- =====================================================================

BEGIN;

-- Horarios de envío
CREATE TABLE send_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  timezone        text NOT NULL DEFAULT 'Europe/Madrid',
  use_contact_tz  boolean NOT NULL DEFAULT true,      -- en la hora local del contacto (si se sabe su país)
  -- Franjas por día de la semana (1 = lunes … 7 = domingo): {"1": [["09:00","13:30"],["15:00","18:00"]], …}
  blocks          jsonb NOT NULL DEFAULT '{"1":[["09:00","18:00"]],"2":[["09:00","18:00"]],"3":[["09:00","18:00"]],"4":[["09:00","18:00"]],"5":[["09:00","15:00"]]}'::jsonb,
  skip_holidays   boolean NOT NULL DEFAULT true,
  holidays        date[] NOT NULL DEFAULT '{}',        -- festivos propios, además de los nacionales
  is_default      boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX send_schedules_default_uq ON send_schedules (is_default) WHERE is_default;
INSERT INTO send_schedules (name, is_default) VALUES ('Horario laboral (España)', true);

-- Sequences: horario, reglas y organización
ALTER TABLE sequences
  ADD COLUMN schedule_id          uuid REFERENCES send_schedules(id) ON DELETE SET NULL,
  ADD COLUMN folder               text,
  ADD COLUMN archived_at          timestamptz,
  ADD COLUMN owner_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN daily_limit          integer CHECK (daily_limit IS NULL OR daily_limit BETWEEN 1 AND 5000),  -- correos en 24 h
  ADD COLUMN pause_on_ooo         boolean NOT NULL DEFAULT true,
  ADD COLUMN finish_on_click      boolean NOT NULL DEFAULT false,
  ADD COLUMN same_account         text NOT NULL DEFAULT 'none' CHECK (same_account IN ('none', 'stop', 'delay')),
  ADD COLUMN same_account_days    integer NOT NULL DEFAULT 7 CHECK (same_account_days BETWEEN 1 AND 90),
  ADD COLUMN call_after_opens     integer CHECK (call_after_opens IS NULL OR call_after_opens BETWEEN 1 AND 50),
  ADD COLUMN cc                   text,
  ADD COLUMN bcc                  text;
UPDATE sequences SET owner_id = created_by;

-- Pasos multicanal
ALTER TABLE sequence_steps DROP CONSTRAINT sequence_steps_kind_check;
ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_kind_check CHECK (kind IN (
  'email', 'manual_email', 'task', 'call', 'linkedin_connect', 'linkedin_message', 'linkedin_view', 'linkedin_interact', 'action_item'));
ALTER TABLE sequence_steps
  ADD COLUMN priority   text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  ADD COLUMN is_active  boolean NOT NULL DEFAULT true;      -- un paso desactivado se salta

-- Inscripciones: quitar, reanudación automática, motivo de pausa
ALTER TABLE sequence_enrollments DROP CONSTRAINT sequence_enrollments_status_check;
ALTER TABLE sequence_enrollments ADD CONSTRAINT sequence_enrollments_status_check
  CHECK (status IN ('active', 'paused', 'completed', 'stopped', 'failed', 'removed'));
ALTER TABLE sequence_enrollments
  ADD COLUMN resume_at          timestamptz,
  ADD COLUMN paused_reason      text,
  ADD COLUMN call_task_created  boolean NOT NULL DEFAULT false,
  ADD COLUMN timezone           text;                         -- zona horaria del contacto (por su país), si se sabe
CREATE INDEX sequence_enrollments_resume_idx ON sequence_enrollments (resume_at) WHERE status = 'paused' AND resume_at IS NOT NULL;

-- Ritmo por buzón (además del límite diario y el calentamiento)
ALTER TABLE mailbox_connections
  ADD COLUMN hourly_limit     integer NOT NULL DEFAULT 20 CHECK (hourly_limit BETWEEN 1 AND 200),
  ADD COLUMN min_gap_seconds  integer NOT NULL DEFAULT 90 CHECK (min_gap_seconds BETWEEN 0 AND 3600),
  ADD COLUMN last_sent_at     timestamptz;

-- Hilos de correo: referencia del proveedor para responder en el mismo hilo
ALTER TABLE emails
  ADD COLUMN thread_ref      text,          -- gmail: threadId · microsoft: conversationId
  ADD COLUMN message_id_hdr  text,          -- cabecera Message-ID
  ADD COLUMN reply_to_email  uuid REFERENCES emails(id) ON DELETE SET NULL;
CREATE INDEX emails_enrollment_idx ON emails (enrollment_id, sent_at DESC) WHERE enrollment_id IS NOT NULL;
CREATE INDEX emails_mailbox_sent_idx ON emails (mailbox_id, sent_at DESC) WHERE direction = 'out' AND enrollment_id IS NOT NULL;

-- Tareas: prioridad y resultado de la llamada
ALTER TABLE activities
  ADD COLUMN priority      text CHECK (priority IS NULL OR priority IN ('high', 'medium', 'low')),
  ADD COLUMN step_kind     text;          -- tipo de paso de la secuencia que la creó (call, linkedin_connect…)

-- Tipo de actividad para LinkedIn
INSERT INTO activity_types (key, label, is_session, is_builtin, position)
VALUES ('linkedin', 'LinkedIn', false, true, 8) ON CONFLICT DO NOTHING;

COMMIT;
