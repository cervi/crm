-- Productos en los deals y propuestas (con IA) que el cliente abre y acepta en una página.
ALTER TABLE products ADD COLUMN description text;

CREATE TABLE proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  token         text NOT NULL UNIQUE,
  title         text NOT NULL,
  intro         text NOT NULL DEFAULT '',          -- texto de la propuesta (redactado por la IA o a mano)
  lines         jsonb NOT NULL DEFAULT '[]'::jsonb, -- productos en el momento de crearla
  total         numeric(14, 2) NOT NULL DEFAULT 0,
  currency      char(3) NOT NULL DEFAULT 'EUR',
  valid_until   date,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined')),
  view_count    integer NOT NULL DEFAULT 0,
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  decided_at    timestamptz,
  decided_name  text,
  decision_note text,
  ai            boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proposals_deal_idx ON proposals (deal_id, created_at DESC);
