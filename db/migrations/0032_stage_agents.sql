-- =====================================================================
-- 0032 — Instrucciones a la IA por fase del funnel (en lenguaje natural)
--
--   · En cada fase de cada pipeline (o en todo un pipeline, o en todos)
--     se escribe qué debe hacer la IA con los deals: «cuando entre aquí,
--     escríbele para agendar con mis huecos», «muévelo a Propuesta si ya
--     han confirmado presupuesto»…
--   · La IA lo convierte en reglas (cuándo → si → qué hace) que se enseñan
--     antes de activarlas; las condiciones en lenguaje natural las evalúa
--     la IA en cada deal (y el resultado se guarda para no repetir).
--   · Cada instrucción tiene su autonomía: preguntarme, hacerlo sola o en pausa.
-- =====================================================================

BEGIN;

CREATE TABLE stage_instructions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid REFERENCES pipelines(id) ON DELETE CASCADE,   -- NULL: todos los pipelines
  stage_id    uuid REFERENCES stages(id) ON DELETE CASCADE,      -- NULL: todo el pipeline
  text        text NOT NULL CHECK (length(text) BETWEEN 3 AND 2000),
  autonomy    text NOT NULL DEFAULT 'ask' CHECK (autonomy IN ('off', 'ask', 'auto')),
  summary     text,                                              -- cómo lo ha entendido la IA
  doubts      text[] NOT NULL DEFAULT '{}',
  compiled_by text NOT NULL DEFAULT 'ai' CHECK (compiled_by IN ('ai', 'rules')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (stage_id IS NULL OR pipeline_id IS NOT NULL)
);
CREATE INDEX stage_instructions_scope_idx ON stage_instructions (pipeline_id, stage_id);

ALTER TABLE automation_rules
  ADD COLUMN instruction_id uuid REFERENCES stage_instructions(id) ON DELETE CASCADE,
  ADD COLUMN condition      text;   -- condición en lenguaje natural que evalúa la IA en cada deal

-- Lo que la IA ya decidió sobre una condición (por regla, deal y «versión» del deal).
CREATE TABLE ai_condition_checks (
  rule_id    uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  deal_id    uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  key        text NOT NULL,
  result     boolean NOT NULL,
  reason     text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, deal_id, key)
);

COMMIT;
