-- =====================================================================
-- 0040 — Notas de reuniones grabadas (Granola, Google Meet / Gemini…)
--   Cada nota que llega se asocia sola a su reunión, contacto, deal o lead;
--   si hay dudas, espera en «Reuniones grabadas» a que alguien la asigne.
-- =====================================================================

BEGIN;
CREATE TABLE meeting_notes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source         text NOT NULL,                 -- granola | meet | api | manual
  external_id    text,
  title          text,
  started_at     timestamptz,
  owner_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  organizer_email text,
  attendees      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ name, email }]
  summary        text,
  notes          text,
  transcript     text,
  link           text,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('matched', 'pending', 'ignored')),
  match_reason   text,
  activity_id    uuid REFERENCES activities(id) ON DELETE SET NULL,
  deal_id        uuid REFERENCES deals(id) ON DELETE SET NULL,
  lead_id        uuid REFERENCES leads(id) ON DELETE SET NULL,
  person_ids     uuid[] NOT NULL DEFAULT '{}',
  candidates     jsonb NOT NULL DEFAULT '[]'::jsonb,  -- deals o leads posibles cuando hay dudas: [{ kind, id }]
  created_at     timestamptz NOT NULL DEFAULT now(),
  matched_at     timestamptz
);
CREATE UNIQUE INDEX meeting_notes_ext_idx ON meeting_notes (source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX meeting_notes_status_idx ON meeting_notes (status, created_at DESC);
-- Si falta el permiso para leer las notas de Gemini en Drive, se avisa en «Reuniones grabadas».
ALTER TABLE mailbox_connections ADD COLUMN notes_error text;
COMMIT;
