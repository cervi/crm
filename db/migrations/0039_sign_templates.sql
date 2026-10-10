-- =====================================================================
-- 0039 — Plantillas de firma
--   Un contrato que se manda a menudo (con sus campos ya colocados) se
--   guarda como plantilla: al usarla, los campos van solos a cada firmante.
-- =====================================================================

BEGIN;
CREATE TABLE sign_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  file_name   text NOT NULL,
  original    bytea NOT NULL,
  pages       jsonb NOT NULL DEFAULT '[]'::jsonb,
  roles       jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{ "label": "Tu empresa", "kind": "internal" }, { "label": "Cliente", "kind": "external" }]
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{ role: 0, type, page, x, y, w, h, required, hint }]
  language    text NOT NULL DEFAULT 'es',
  subject     text,
  message     text,
  sequential  boolean NOT NULL DEFAULT false,
  require_code boolean NOT NULL DEFAULT false,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
COMMIT;
