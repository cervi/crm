-- =====================================================================
-- 0004_automations.sql — Motor de automatizaciones con autonomía configurable
--
--   automation_rules    Reglas («cuando pase X, haz Y») y su nivel de
--                       autonomía: off (desactivada), ask (propone y espera
--                       aprobación en la bandeja) o auto (actúa sola).
--   automation_actions  Cada propuesta o acción de la IA: es a la vez la
--                       bandeja de decisiones y el registro de lo que hizo,
--                       con lo necesario para deshacerlo.
--   automation_settings Interruptor general.
-- =====================================================================

BEGIN;

-- Usuario con el que actúa la IA (aparece como autor en el historial).
INSERT INTO users (id, name, kind, role)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'Asistente IA', 'ai_agent', 'member')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE automation_settings (
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),   -- una sola fila
  paused     boolean NOT NULL DEFAULT false,
  last_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO automation_settings DEFAULT VALUES;

CREATE TABLE automation_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,              -- identifica el comportamiento en el código
  name         text NOT NULL,
  description  text NOT NULL,
  autonomy     text NOT NULL DEFAULT 'ask' CHECK (autonomy IN ('off', 'ask', 'auto')),
  -- Niveles que admite la regla (p. ej. un correo no puede ser automático
  -- hasta que haya un buzón conectado).
  allowed_autonomy text[] NOT NULL DEFAULT ARRAY['off', 'ask', 'auto'],
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (autonomy = ANY (allowed_autonomy))
);
CREATE TRIGGER automation_rules_updated_at BEFORE UPDATE ON automation_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE automation_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id      uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  -- Sobre qué actúa (la deduplicación y el «enfriamiento» usan esta clave).
  subject_type text NOT NULL CHECK (subject_type IN ('deal', 'lead', 'person', 'organization')),
  subject_id   uuid NOT NULL,
  deal_id      uuid REFERENCES deals(id) ON DELETE CASCADE,
  action_type  text NOT NULL CHECK (action_type IN ('create_task', 'draft_email', 'move_stage', 'notify')),
  title        text NOT NULL,                    -- lo que propone, en una frase
  reason       text NOT NULL,                    -- por qué lo propone
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN
                 ('pending',    -- esperando decisión en la bandeja
                  'done',       -- ejecutada (automática o aprobada)
                  'dismissed',  -- descartada por una persona
                  'expired',    -- ya no aplica (el deal cambió antes de decidir)
                  'failed',     -- se intentó y falló
                  'undone')),   -- ejecutada y deshecha
  mode         text NOT NULL CHECK (mode IN ('ask', 'auto')),
  result       jsonb,                            -- lo creado/cambiado, para poder deshacerlo
  error        text,
  decided_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz,
  executed_at  timestamptz
);
-- Nunca dos propuestas pendientes de la misma regla sobre lo mismo.
CREATE UNIQUE INDEX automation_actions_one_pending
  ON automation_actions (rule_id, subject_type, subject_id) WHERE status = 'pending';
CREATE INDEX automation_actions_status_idx ON automation_actions (status, created_at DESC);
CREATE INDEX automation_actions_deal_idx ON automation_actions (deal_id, created_at DESC);
CREATE INDEX automation_actions_rule_idx ON automation_actions (rule_id, subject_id, created_at DESC);

-- Reglas incluidas de serie (se pueden ajustar o desactivar en la aplicación).
INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position) VALUES
  ('missing_stage_session',
   'Fase sin su sesión agendada',
   'Si un deal lleva en una fase que requiere una sesión (demo, videollamada…) y no la tiene agendada, crea una tarea para agendarla.',
   'auto', ARRAY['off', 'ask', 'auto'],
   '{"grace_days": 1, "cooldown_days": 5}', 1),
  ('stale_deal_followup',
   'Deal parado: escribir al contacto',
   'Si un deal supera los días máximos de su fase sin actividad agendada, prepara un correo de seguimiento para su contacto principal.',
   'ask', ARRAY['off', 'ask'],
   '{"cooldown_days": 7, "subject": "¿Seguimos con {deal}?", "body": "Hola {nombre},\n\nTe escribo para retomar lo que hablamos sobre {deal}. ¿Te viene bien que busquemos un hueco esta semana para avanzar?\n\nUn saludo,\n{responsable}"}', 2),
  ('no_show_rebook',
   'No se presentó: proponer otra fecha',
   'Cuando una sesión de un deal se marca como «No se presentó», prepara un correo para reagendarla.',
   'ask', ARRAY['off', 'ask'],
   '{"subject": "¿Buscamos otro hueco?", "body": "Hola {nombre},\n\nNo coincidimos en la {sesion} de hoy, no pasa nada. ¿Te encaja que la movamos a otro día? Dime un par de huecos que te vengan bien.\n\nUn saludo,\n{responsable}"}', 3),
  ('stale_deal_escalate',
   'Deal muy parado: pedir una decisión',
   'Si un deal lleva más del doble de los días máximos de su fase, te pide decidir: insistir, cambiar de enfoque o darlo por perdido.',
   'ask', ARRAY['off', 'ask'],
   '{"factor": 2, "cooldown_days": 14}', 4),
  ('won_handoff',
   'Deal ganado: traspaso a Customer Success',
   'Al ganar un deal, crea la tarea de traspaso a Customer Success con el resumen de lo ocurrido.',
   'auto', ARRAY['off', 'ask', 'auto'],
   '{"due_days": 1}', 5);

COMMIT;
