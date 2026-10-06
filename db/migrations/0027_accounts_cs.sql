-- =====================================================================
-- 0027 — Cuentas de cliente y Customer Success
--
--   · Tipos de pipeline: ventas, onboarding, renovaciones y expansión.
--     Se crean «Onboarding» y «Renovaciones» (editables: fases e hitos los
--     define la persona de CS) y «Expansión».
--   · Contratos: qué tiene cada cliente, importe anual, renovación,
--     licencias y responsable de CS.
--   · Datos de uso del producto (por API) y salud de cada cuenta.
--   · Encuestas cortas de satisfacción (al terminar el onboarding y en QBR).
--   · Tipo y origen de cada deal (nuevo, upsell, cross-sell, renovación;
--     ventas o CS) para los informes.
--   · Acción «crear deal» para los agentes (onboarding, renovación, expansión).
-- =====================================================================

BEGIN;

ALTER TABLE pipelines ADD COLUMN kind text NOT NULL DEFAULT 'sales' CHECK (kind IN ('sales', 'onboarding', 'renewal', 'expansion'));

INSERT INTO pipelines (name, description, position, kind) VALUES
  ('Onboarding', 'Puesta en marcha de los clientes nuevos. Las fases y sus sesiones las define Customer Success.', 50, 'onboarding'),
  ('Renovaciones', 'Contratos que renuevan en los próximos meses.', 51, 'renewal'),
  ('Expansión', 'Upselling y cross-selling a clientes (lo lleva Customer Success).', 52, 'expansion')
ON CONFLICT ((lower(name))) DO NOTHING;
UPDATE pipelines SET kind = 'onboarding' WHERE lower(name) = 'onboarding';
UPDATE pipelines SET kind = 'renewal' WHERE lower(name) = 'renovaciones';
UPDATE pipelines SET kind = 'expansion' WHERE lower(name) = 'expansión';

-- Plantilla de fases (se pueden cambiar o borrar en Ajustes → Pipelines).
INSERT INTO stages (pipeline_id, name, position, win_probability, rotten_after_days, required_activity_type)
SELECT p.id, v.name, v.position, v.prob, v.rotten, v.act
FROM pipelines p, (VALUES
  ('onboarding', 'Kick-off', 1, NULL::int, 7, 'video_call'),
  ('onboarding', 'Configuración', 2, NULL, 14, NULL),
  ('onboarding', 'Formación', 3, NULL, 14, 'video_call'),
  ('onboarding', 'En producción', 4, NULL, 30, NULL),
  ('renewal', 'Por renovar', 1, 70, 30, NULL),
  ('renewal', 'En conversación', 2, 80, 21, 'call'),
  ('renewal', 'Propuesta de renovación', 3, 90, 14, NULL),
  ('expansion', 'Oportunidad detectada', 1, 20, 14, NULL),
  ('expansion', 'Conversación', 2, 40, 14, 'video_call'),
  ('expansion', 'Propuesta', 3, 60, 14, NULL),
  ('expansion', 'Negociación', 4, 80, 14, 'call')
) AS v(kind, name, position, prob, rotten, act)
WHERE p.kind = v.kind AND NOT EXISTS (SELECT 1 FROM stages s WHERE s.pipeline_id = p.id);

ALTER TABLE deals
  ADD COLUMN deal_type text NOT NULL DEFAULT 'new' CHECK (deal_type IN ('new', 'upsell', 'cross_sell', 'renewal', 'onboarding')),
  ADD COLUMN origin    text NOT NULL DEFAULT 'sales' CHECK (origin IN ('sales', 'cs')),
  ADD COLUMN contract_id uuid;

-- Responsable de Customer Success de cada cliente (además del email de traspaso que ya había).
ALTER TABLE organizations ADD COLUMN cs_owner_id uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE contracts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id          uuid REFERENCES deals(id) ON DELETE SET NULL,      -- deal con el que se ganó
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'cancelled')),
  start_date       date NOT NULL DEFAULT current_date,
  renewal_date     date,
  annual_value     numeric(14, 2) NOT NULL DEFAULT 0,
  currency         char(3) NOT NULL DEFAULT 'EUR',
  seats            integer CHECK (seats IS NULL OR seats > 0),          -- licencias contratadas
  auto_renew       boolean NOT NULL DEFAULT true,
  cs_owner_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contracts_org_idx ON contracts (organization_id, status);
CREATE INDEX contracts_renewal_idx ON contracts (renewal_date) WHERE status = 'active';
ALTER TABLE deals ADD CONSTRAINT deals_contract_fk FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL;

CREATE TABLE contract_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  uuid NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity     numeric(12, 2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price   numeric(14, 2) NOT NULL DEFAULT 0,
  discount_pct numeric(5, 2) NOT NULL DEFAULT 0
);
CREATE INDEX contract_items_contract_idx ON contract_items (contract_id);

-- Datos de uso del producto (por API): usuarios activos, licencias en uso, tickets…
CREATE TABLE account_usage (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric          text NOT NULL CHECK (length(metric) BETWEEN 1 AND 60),
  value           numeric NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),
  source          text
);
CREATE INDEX account_usage_idx ON account_usage (organization_id, metric, at DESC);

CREATE TABLE account_health (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  score           integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  signals         jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  red_since       timestamptz
);

CREATE TABLE surveys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token           text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN ('onboarding', 'qbr', 'nps')),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id         uuid REFERENCES deals(id) ON DELETE SET NULL,
  person_id       uuid REFERENCES persons(id) ON DELETE SET NULL,
  score           integer CHECK (score BETWEEN 0 AND 10),
  comment         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  answered_at     timestamptz
);
CREATE INDEX surveys_org_idx ON surveys (organization_id, answered_at DESC);

-- Usuario de CS por defecto para clientes sin responsable (opcional).
ALTER TABLE app_settings ADD COLUMN default_cs_owner_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- Nueva acción de los agentes: crear un deal (onboarding, renovación o expansión).
ALTER TABLE automation_actions DROP CONSTRAINT automation_actions_action_type_check;
ALTER TABLE automation_actions ADD CONSTRAINT automation_actions_action_type_check CHECK (action_type IN
  ('create_task', 'add_note', 'draft_email', 'move_stage', 'update_deal', 'notify', 'webhook', 'create_deal'));
ALTER TABLE ai_permissions DROP CONSTRAINT ai_permissions_action_type_check;
ALTER TABLE ai_permissions ADD CONSTRAINT ai_permissions_action_type_check CHECK (action_type IN
  ('create_task', 'add_note', 'draft_email', 'move_stage', 'update_deal', 'webhook', 'create_deal'));
INSERT INTO ai_permissions (actor, action_type, autonomy, allowed_autonomy) VALUES
  ('assistant', 'create_deal', 'auto', ARRAY['off', 'ask', 'auto']),
  ('external',  'create_deal', 'ask',  ARRAY['off', 'ask', 'auto'])
ON CONFLICT DO NOTHING;

INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position, agent) VALUES
  ('won_onboarding', 'Poner en marcha al cliente nuevo',
   'Deal ganado: crea el contrato con sus productos, el onboarding en su pipeline (con el plan de hitos) y la ficha del kick-off con lo prometido en la venta.',
   'auto', ARRAY['off', 'ask', 'auto'], '{"plan": "Kick-off con el cliente\nAccesos y configuración\nFormación del equipo\nPrimer uso real\nRevisión a los 30 días"}', 70, 'onboarding'),
  ('onboarding_survey', 'Encuesta al terminar el onboarding',
   'Al completar el onboarding, correo con una encuesta de una pregunta (0 a 10) y un comentario.',
   'ask', ARRAY['off', 'ask', 'auto'], '{}', 72, 'onboarding'),
  ('renewal_deal', 'Preparar las renovaciones',
   'Crea el deal de renovación 120 días antes de que venza el contrato, con la salud de la cuenta.',
   'auto', ARRAY['off', 'ask', 'auto'], '{"days_before": 120}', 80, 'cuenta'),
  ('qbr_prepare', 'Revisiones periódicas (QBR)',
   'Cada trimestre por cliente: tarea para agendar la revisión con un resumen de uso, salud, satisfacción y oportunidades.',
   'auto', ARRAY['off', 'ask', 'auto'], '{"every_days": 90}', 81, 'cuenta');

COMMIT;
