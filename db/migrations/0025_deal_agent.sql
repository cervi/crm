-- =====================================================================
-- 0025 — Agente ejecutivo de deal
--
--   · Cada regla pertenece a un agente (captación, prospección, ejecutivo
--     de deal, riesgo, onboarding, cuenta) para verlas agrupadas.
--   · agent_jobs: trabajos de los agentes que no son propuestas (preparar
--     reuniones, cualificar leads…), con su interruptor.
--   · Preparación de reuniones y lo extraído de cada llamada (necesidades,
--     decisores, presupuesto, plazos, objeciones) por deal.
--   · Plan de cierre por deal, compartible con el cliente.
--   · Límite de descuento sin aprobación (global y por producto).
-- =====================================================================

BEGIN;

ALTER TABLE automation_rules ADD COLUMN agent text
  CHECK (agent IN ('captacion', 'prospeccion', 'ejecutivo', 'riesgo', 'onboarding', 'cuenta'));
UPDATE automation_rules SET agent = 'ejecutivo'
  WHERE key IN ('meeting_recap', 'advance_after_session', 'offer_session_slots', 'missing_stage_session', 'stale_deal_followup', 'no_show_rebook');
UPDATE automation_rules SET agent = 'riesgo' WHERE key = 'stale_deal_escalate';
UPDATE automation_rules SET agent = 'onboarding' WHERE key IN ('won_handoff', 'won_handoff_email');

CREATE TABLE agent_jobs (
  key          text PRIMARY KEY,
  agent        text NOT NULL,
  name         text NOT NULL,
  description  text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  position     integer NOT NULL DEFAULT 0,
  last_run_at  timestamptz,
  last_result  text
);
INSERT INTO agent_jobs (key, agent, name, description, params, position) VALUES
  ('meeting_prep', 'ejecutivo', 'Preparar las reuniones',
   'Antes de cada sesión con el cliente deja en la actividad una ficha: quién viene, la historia, lo que se sabe, las dudas abiertas y el objetivo. Avisa una hora antes.',
   '{"hours_ahead": 36, "notify_minutes": 60}', 10),
  ('call_extraction', 'ejecutivo', 'Extraer lo importante de cada reunión',
   'Con la transcripción o tus notas, apunta en el deal necesidades, decisores, presupuesto, plazos y objeciones (necesita la IA configurada).',
   '{}', 20);

-- Ficha de preparación y lo extraído de la reunión, en la propia actividad.
ALTER TABLE activities
  ADD COLUMN prep             text,
  ADD COLUMN prep_at          timestamptz,
  ADD COLUMN prep_notified_at timestamptz,
  ADD COLUMN extraction       jsonb;

-- Lo que sabemos del deal (se completa con cada reunión; se puede editar).
CREATE TABLE deal_insights (
  deal_id         uuid PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  needs           text[] NOT NULL DEFAULT '{}',
  decision_makers jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{nombre, cargo, rol}]
  budget          text,
  timeline        text,
  objections      text[] NOT NULL DEFAULT '{}',
  competitors     text[] NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  source          text                                   -- de dónde salió lo último
);

-- Plan de cierre: los pasos hasta la firma, con fecha y responsable.
CREATE TABLE close_plans (
  deal_id    uuid PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  token      text NOT NULL UNIQUE,                       -- para compartirlo con el cliente
  shared     boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE close_plan_steps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id    uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  position   integer NOT NULL DEFAULT 0,
  title      text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  side       text NOT NULL DEFAULT 'us' CHECK (side IN ('us', 'client', 'both')),
  owner_name text,
  due_date   date,
  done       boolean NOT NULL DEFAULT false,
  done_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX close_plan_steps_deal_idx ON close_plan_steps (deal_id, position);

-- Descuentos: por encima del límite, la línea espera aprobación de un administrador.
ALTER TABLE app_settings ADD COLUMN max_discount_pct numeric(5, 2) CHECK (max_discount_pct BETWEEN 0 AND 100);
ALTER TABLE products ADD COLUMN max_discount_pct numeric(5, 2) CHECK (max_discount_pct BETWEEN 0 AND 100);
ALTER TABLE deal_products
  ADD COLUMN discount_status text NOT NULL DEFAULT 'ok' CHECK (discount_status IN ('ok', 'pending', 'approved', 'rejected')),
  ADD COLUMN discount_limit  numeric(5, 2),
  ADD COLUMN discount_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN discount_at     timestamptz,
  ADD COLUMN requested_by    uuid REFERENCES users(id) ON DELETE SET NULL;

-- Reglas nuevas del agente ejecutivo de deal.
INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position, agent) VALUES
  ('call_next_steps', 'Tareas con los próximos pasos de cada reunión',
   'Tras una reunión con notas o transcripción, crea las tareas de los próximos pasos acordados (necesita la IA).',
   'ask', ARRAY['off', 'ask', 'auto'], '{}', 60, 'ejecutivo'),
  ('call_deal_update', 'Actualizar importe y fecha de cierre tras una reunión',
   'Si en la reunión se habló de presupuesto o de plazos distintos a los del deal, propone cambiarlos (necesita la IA).',
   'ask', ARRAY['off', 'ask', 'auto'], '{}', 61, 'ejecutivo'),
  ('multithread', 'Implicar a más personas',
   'Deals con un solo contacto: propone a quién más implicar de la empresa (decisor, usuario, compras) o pide identificarlo.',
   'ask', ARRAY['off', 'ask', 'auto'], '{"min_age_days": 7, "cooldown_days": 21}', 62, 'ejecutivo'),
  ('close_date_past', 'Fecha de cierre pasada',
   'Si la fecha de cierre prevista ya pasó y el deal sigue abierto, propone una nueva para que la previsión sea realista.',
   'ask', ARRAY['off', 'ask', 'auto'], '{"push_days": 14, "cooldown_days": 7}', 63, 'riesgo'),
  ('proposal_stage', 'Fase coherente con la propuesta',
   'Si el cliente ya abrió la propuesta y el deal sigue en una fase anterior a «Propuesta enviada», propone moverlo.',
   'ask', ARRAY['off', 'ask', 'auto'], '{}', 64, 'ejecutivo');

COMMIT;
