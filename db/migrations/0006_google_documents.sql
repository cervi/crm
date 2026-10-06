-- =====================================================================
-- 0006_google_documents.sql — Google Workspace y documentos de los deals
--
--   * Las cuentas conectadas pueden ser de Microsoft 365 o de Google
--     Workspace (Gmail, Google Calendar y Google Drive).
--   * deal_documents: presentaciones, propuestas y otros archivos enlazados
--     a un deal, desde Google Drive, OneDrive/SharePoint o un enlace a mano.
-- =====================================================================

BEGIN;

ALTER TABLE mailbox_connections DROP CONSTRAINT mailbox_connections_provider_check;
ALTER TABLE mailbox_connections ADD CONSTRAINT mailbox_connections_provider_check
  CHECK (provider IN ('microsoft', 'google'));

CREATE TABLE deal_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id      uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (length(trim(title)) > 0),
  url          text NOT NULL CHECK (url ~* '^https?://'),
  source       text NOT NULL DEFAULT 'link' CHECK (source IN ('link', 'google', 'microsoft')),
  external_id  text,                  -- id del archivo en Drive / OneDrive
  mime_type    text,
  added_by_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deal_documents_url_uq UNIQUE (deal_id, url)
);
CREATE INDEX deal_documents_deal_idx ON deal_documents (deal_id, created_at DESC);

COMMIT;
