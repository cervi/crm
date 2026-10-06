-- Puntuación de leads (0–100, explicada) y reparto automático de leads y deals.
ALTER TABLE leads
  ADD COLUMN score          integer CHECK (score BETWEEN 0 AND 100),
  ADD COLUMN score_reasons  jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN scored_at      timestamptz;
-- Recalcular la puntuación no es «actividad» del lead: no cambia updated_at.
CREATE OR REPLACE FUNCTION leads_set_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'score' - 'score_reasons' - 'scored_at' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'score' - 'score_reasons' - 'scored_at' - 'updated_at') THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER leads_updated_at ON leads;
CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION leads_set_updated_at();

CREATE INDEX leads_score_idx ON leads (score DESC NULLS LAST) WHERE deleted_at IS NULL AND status = 'open';

CREATE TABLE assignment_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position    integer NOT NULL DEFAULT 0,
  entity      text NOT NULL DEFAULT 'both' CHECK (entity IN ('lead', 'deal', 'both')),
  field       text NOT NULL DEFAULT 'any' CHECK (field IN ('any', 'source', 'funnel_stage', 'min_score', 'min_value', 'country')),
  value       text,
  user_ids    uuid[] NOT NULL CHECK (cardinality(user_ids) > 0),   -- se reparte por turnos entre ellos
  last_index  integer NOT NULL DEFAULT -1,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app_settings
  ADD COLUMN assignment_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN assignment_since   timestamptz;
