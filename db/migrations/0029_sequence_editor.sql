-- =====================================================================
-- 0029 — Editor de correos de las secuencias (al estilo de Apollo)
--
--   · Correos con formato (HTML), variables {{contacto.nombre}} con valor
--     por defecto, condiciones y formatos; pruebas A/B por paso (variantes).
--   · Pasos: correo automático, correo manual (lo revisas y lo envías tú),
--     o tarea (llamada, LinkedIn…); responder en el mismo hilo.
--   · Ajustes de envío de cada secuencia: días y horas, seguimiento, firma
--     y enlace de baja. Firma de cada persona.
--   · Si a un correo le falta un dato (sin valor por defecto), no sale: la
--     inscripción queda «en revisión» hasta que se corrija.
--   · Estadísticas por paso y por variante.
-- =====================================================================

BEGIN;

ALTER TABLE sequence_steps DROP CONSTRAINT sequence_steps_kind_check;
ALTER TABLE sequence_steps ADD CONSTRAINT sequence_steps_kind_check CHECK (kind IN ('email', 'manual_email', 'task'));
ALTER TABLE sequence_steps
  ADD COLUMN format       text NOT NULL DEFAULT 'text' CHECK (format IN ('text', 'html')),
  ADD COLUMN thread_reply boolean NOT NULL DEFAULT false,   -- «Re: » del correo anterior, en el mismo hilo
  ADD COLUMN delay_hours  integer NOT NULL DEFAULT 0 CHECK (delay_hours BETWEEN 0 AND 23);

-- Variantes para las pruebas A/B (la A es el propio paso).
CREATE TABLE sequence_step_variants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id    uuid NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
  label      text NOT NULL CHECK (label ~ '^[B-Z]$'),
  subject    text NOT NULL DEFAULT '',
  body       text NOT NULL DEFAULT '',
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (step_id, label)
);

ALTER TABLE sequences
  -- Por defecto, sin restricción (como hasta ahora); en cada secuencia se elige el horario.
  ADD COLUMN send_days        integer[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',
  ADD COLUMN send_from        integer NOT NULL DEFAULT 0 CHECK (send_from BETWEEN 0 AND 23),
  ADD COLUMN send_to          integer NOT NULL DEFAULT 24 CHECK (send_to BETWEEN 1 AND 24),
  ADD COLUMN track            boolean NOT NULL DEFAULT true,
  ADD COLUMN add_signature    boolean NOT NULL DEFAULT true,
  ADD COLUMN unsubscribe_link boolean NOT NULL DEFAULT false;

ALTER TABLE sequence_enrollments DROP CONSTRAINT sequence_enrollments_status_check;
ALTER TABLE sequence_enrollments ADD CONSTRAINT sequence_enrollments_status_check
  CHECK (status IN ('active', 'paused', 'completed', 'stopped', 'failed'));
ALTER TABLE sequence_enrollments ADD COLUMN waiting_activity_id uuid REFERENCES activities(id) ON DELETE SET NULL;

-- Qué paso y qué variante es cada correo enviado (para las estadísticas).
ALTER TABLE emails
  ADD COLUMN sequence_step_id uuid REFERENCES sequence_steps(id) ON DELETE SET NULL,
  ADD COLUMN variant          text,
  ADD COLUMN body_html        text;
CREATE INDEX emails_step_idx ON emails (sequence_step_id) WHERE sequence_step_id IS NOT NULL;

-- Correos manuales: el borrador ya preparado, para revisarlo y enviarlo.
ALTER TABLE activities
  ADD COLUMN draft_subject text,
  ADD COLUMN draft_html    text,
  ADD COLUMN draft_to      text;

ALTER TABLE users ADD COLUMN email_signature text;
ALTER TABLE email_templates ADD COLUMN format text NOT NULL DEFAULT 'text' CHECK (format IN ('text', 'html'));

COMMIT;
