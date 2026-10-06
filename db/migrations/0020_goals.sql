-- Objetivos de ventas por persona o de equipo, por mes o trimestre.
CREATE TABLE goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,       -- NULL: objetivo del equipo
  metric       text NOT NULL CHECK (metric IN ('won_value', 'won_count', 'new_deals', 'activities_done')),
  period       text NOT NULL DEFAULT 'month' CHECK (period IN ('month', 'quarter')),
  target       numeric(14, 2) NOT NULL CHECK (target > 0),
  pipeline_id  uuid REFERENCES pipelines(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
