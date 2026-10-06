-- =====================================================================
-- 0028 — Expansión y orquestación de los agentes
--
--   · Detección de upsell y cross-sell (regla del agente de cuenta).
--   · Consumo de la IA por tarea y agente, con presupuesto mensual (global
--     y por agente): aviso al 80 % y, al 100 %, pausa de lo que no es urgente.
--   · Jefe de agentes: como mucho N correos de los agentes por contacto y día.
-- =====================================================================

BEGIN;

CREATE TABLE ai_usage (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  task          text NOT NULL,
  agent         text,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost          numeric(12, 6) NOT NULL DEFAULT 0     -- estimado, en euros
);
CREATE INDEX ai_usage_month_idx ON ai_usage (at);

ALTER TABLE ai_settings
  ADD COLUMN monthly_budget numeric(10, 2) CHECK (monthly_budget IS NULL OR monthly_budget >= 0),
  ADD COLUMN agent_budgets  jsonb NOT NULL DEFAULT '{}'::jsonb,         -- {"captacion": 20, …}
  ADD COLUMN price_in       numeric(10, 4) NOT NULL DEFAULT 3,          -- € por millón de tokens de entrada
  ADD COLUMN price_out      numeric(10, 4) NOT NULL DEFAULT 15,         -- € por millón de tokens de salida
  ADD COLUMN budget_alerts  text[] NOT NULL DEFAULT '{}';               -- avisos ya enviados («2026-10:80»)

ALTER TABLE app_settings ADD COLUMN agent_emails_per_contact_day integer NOT NULL DEFAULT 1 CHECK (agent_emails_per_contact_day BETWEEN 1 AND 10);

INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position, agent) VALUES
  ('expansion_opportunity', 'Detectar upselling y cross-selling',
   'Clientes con licencias casi llenas, uso al alza, equipos nuevos, interés por otro producto o muy contentos y con huecos en el catálogo: propone la oportunidad de expansión con su porqué.',
   'ask', ARRAY['off', 'ask', 'auto'], '{"seats_ratio": 0.85, "growth": 0.3}', 82, 'cuenta');

COMMIT;
