-- Secuencias de correo: varios pasos (correos y tareas) separados por días,
-- que se paran solos cuando el contacto responde, reserva o el deal se cierra.
CREATE TABLE sequences (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description      text,
  is_active        boolean NOT NULL DEFAULT true,
  stop_on_reply    boolean NOT NULL DEFAULT true,
  stop_on_meeting  boolean NOT NULL DEFAULT true,   -- al reservar o agendar una sesión
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequence_steps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id   uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  position      integer NOT NULL,
  delay_days    integer NOT NULL DEFAULT 0 CHECK (delay_days BETWEEN 0 AND 90),  -- días desde el paso anterior
  kind          text NOT NULL CHECK (kind IN ('email', 'task')),
  subject       text NOT NULL DEFAULT '',
  body          text NOT NULL DEFAULT '',
  task_type     text REFERENCES activity_types(key) ON UPDATE CASCADE
);
CREATE INDEX sequence_steps_seq_idx ON sequence_steps (sequence_id, position);

CREATE TABLE sequence_enrollments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id     uuid NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  deal_id         uuid REFERENCES deals(id) ON DELETE CASCADE,
  person_id       uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,     -- buzón desde el que salen los correos
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'stopped', 'failed')),
  next_step       integer NOT NULL DEFAULT 0,      -- índice del siguiente paso (por posición)
  next_run_at     timestamptz,
  stopped_reason  text,
  error           text,
  attempts        integer NOT NULL DEFAULT 0,      -- intentos fallidos seguidos del paso actual
  enrolled_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE UNIQUE INDEX sequence_enrollments_active_uq ON sequence_enrollments (sequence_id, person_id) WHERE status = 'active';
CREATE INDEX sequence_enrollments_due_idx ON sequence_enrollments (next_run_at) WHERE status = 'active';
CREATE INDEX sequence_enrollments_deal_idx ON sequence_enrollments (deal_id);

ALTER TABLE emails ADD COLUMN enrollment_id uuid REFERENCES sequence_enrollments(id) ON DELETE SET NULL;
-- Actividades que crea la propia secuencia (no cuentan como «agendó una reunión»).
ALTER TABLE activities ADD COLUMN enrollment_id uuid REFERENCES sequence_enrollments(id) ON DELETE SET NULL;

-- Una secuencia de ejemplo.
WITH s AS (
  INSERT INTO sequences (name, description) VALUES
    ('Seguimiento tras la propuesta', 'Tres toques en dos semanas si el contacto no responde.')
  RETURNING id
)
INSERT INTO sequence_steps (sequence_id, position, delay_days, kind, subject, body, task_type)
SELECT s.id, v.position, v.delay_days, v.kind, v.subject, v.body, v.task_type FROM s, (VALUES
  (1, 0, 'email', '¿Qué te ha parecido la propuesta?', E'Hola {nombre},\n\n¿Has podido revisar la propuesta para {empresa}? Si quieres, la repasamos juntos en 20 minutos:\n\n{huecos}\n\nUn saludo,\n{responsable}', NULL),
  (2, 3, 'email', 'Re: propuesta para {empresa}', E'Hola {nombre},\n\nTe escribo de nuevo por si se perdió mi correo anterior. ¿Te encaja que hablemos esta semana?\n\nUn saludo,\n{responsable}', NULL),
  (3, 4, 'task', 'Llamar a {nombre} por la propuesta', '', 'call'),
  (4, 7, 'email', '¿Lo dejamos para más adelante?', E'Hola {nombre},\n\nNo quiero insistir más de la cuenta. Si ahora no es el momento, dímelo y lo retomamos más adelante.\n\nUn saludo,\n{responsable}', NULL)
) AS v(position, delay_days, kind, subject, body, task_type);
