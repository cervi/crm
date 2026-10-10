-- =====================================================================
-- 0036 — Biblioteca de documentos, enlaces con seguimiento y adjuntos
--
--   · Biblioteca del equipo: presentaciones, casos de éxito, tarifas…
--   · Cada documento se comparte con un enlace personal por contacto: se
--     sabe cuántas veces lo abre, cuándo y cuánto tiempo lo mira.
--   · Los correos del CRM pueden llevar adjuntos (archivos del deal o de la
--     biblioteca).
-- =====================================================================

BEGIN;

CREATE TABLE library_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description text,
  folder      text NOT NULL DEFAULT 'General',
  kind        text NOT NULL CHECK (kind IN ('file', 'link')),
  file_name   text,
  mime        text,
  size        integer,
  data        bytea,
  url         text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK ((kind = 'file' AND data IS NOT NULL) OR (kind = 'link' AND url IS NOT NULL))
);

-- Un enlace por documento y destinatario (o genérico): /d/<token>
CREATE TABLE doc_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token           text NOT NULL UNIQUE,
  library_id      uuid REFERENCES library_items(id) ON DELETE CASCADE,
  file_id         uuid REFERENCES files(id) ON DELETE CASCADE,
  deal_id         uuid REFERENCES deals(id) ON DELETE SET NULL,
  person_id       uuid REFERENCES persons(id) ON DELETE SET NULL,
  email_id        uuid REFERENCES emails(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  view_count      integer NOT NULL DEFAULT 0,
  seconds         integer NOT NULL DEFAULT 0,
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  disabled_at     timestamptz,
  CHECK (library_id IS NOT NULL OR file_id IS NOT NULL)
);
CREATE INDEX doc_links_library_idx ON doc_links (library_id);
CREATE INDEX doc_links_deal_idx ON doc_links (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX doc_links_person_idx ON doc_links (person_id) WHERE person_id IS NOT NULL;

CREATE TABLE doc_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id    uuid NOT NULL REFERENCES doc_links(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  seconds    integer NOT NULL DEFAULT 0,
  max_page   integer,
  ip         text,
  user_agent text
);
CREATE INDEX doc_views_link_idx ON doc_views (link_id, at DESC);

CREATE TABLE email_attachments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id   uuid NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  file_id    uuid REFERENCES files(id) ON DELETE SET NULL,
  library_id uuid REFERENCES library_items(id) ON DELETE SET NULL,
  name       text NOT NULL,
  size       integer NOT NULL DEFAULT 0
);
CREATE INDEX email_attachments_email_idx ON email_attachments (email_id);

COMMIT;
