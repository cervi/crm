-- =====================================================================
-- 0035 — Firma electrónica de contratos (como «Smart Docs» de Pipedrive)
--
--   Se sube un PDF, se eligen los firmantes (de tu empresa y del cliente),
--   se colocan sus campos (firma, iniciales, nombre, fecha, texto, casilla)
--   y se envía. Cada firmante abre su enlace, rellena y firma; al terminar
--   todos, les llega a todos el PDF firmado con el registro de auditoría.
-- =====================================================================

BEGIN;

CREATE TABLE sign_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id         uuid REFERENCES deals(id) ON DELETE SET NULL,
  title           text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  file_name       text NOT NULL,
  original        bytea NOT NULL,                 -- el PDF que se firma (con la página de firmas si se añadió)
  original_sha256 text NOT NULL,
  pages           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{w, h}] en puntos, por página
  signed          bytea,                          -- PDF final con los campos y el registro de auditoría
  signed_sha256   text,
  status          text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'sent', 'completed', 'declined', 'expired', 'cancelled')),
  language        text NOT NULL DEFAULT 'es',
  subject         text,
  message         text,
  sequential      boolean NOT NULL DEFAULT false, -- firmar en orden
  require_code    boolean NOT NULL DEFAULT false, -- código de un solo uso por correo antes de firmar
  reminder_days   integer NOT NULL DEFAULT 3 CHECK (reminder_days BETWEEN 0 AND 30),
  expires_days    integer NOT NULL DEFAULT 60 CHECK (expires_days BETWEEN 1 AND 365),
  expires_at      timestamptz,
  sender_id       uuid REFERENCES users(id) ON DELETE SET NULL,  -- desde qué cuenta salen los correos
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  completed_at    timestamptz,
  cancelled_at    timestamptz,
  owner_alerted_at timestamptz
);
CREATE INDEX sign_requests_deal_idx ON sign_requests (deal_id, created_at DESC);
CREATE INDEX sign_requests_open_idx ON sign_requests (status) WHERE status = 'sent';

CREATE TABLE sign_signers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id      uuid NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE,
  position        integer NOT NULL DEFAULT 1,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  email           text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  kind            text NOT NULL DEFAULT 'external' CHECK (kind IN ('internal', 'external')),
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  person_id       uuid REFERENCES persons(id) ON DELETE SET NULL,
  color           integer NOT NULL DEFAULT 1,
  token           text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'waiting'
                    CHECK (status IN ('waiting', 'pending', 'signed', 'declined')),
  invited_at      timestamptz,
  last_reminded_at timestamptz,
  first_viewed_at timestamptz,
  last_viewed_at  timestamptz,
  view_count      integer NOT NULL DEFAULT 0,
  signed_at       timestamptz,
  declined_at     timestamptz,
  decline_reason  text,
  ip              text,
  user_agent      text,
  code_hash       text,
  code_expires_at timestamptz,
  code_attempts   integer NOT NULL DEFAULT 0,
  code_verified_at timestamptz
);
CREATE INDEX sign_signers_request_idx ON sign_signers (request_id, position);

CREATE TABLE sign_fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  uuid NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE,
  signer_id   uuid NOT NULL REFERENCES sign_signers(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('signature', 'initials', 'name', 'date', 'text', 'checkbox')),
  page        integer NOT NULL CHECK (page >= 1),
  x           real NOT NULL, y real NOT NULL, w real NOT NULL, h real NOT NULL,   -- fracciones de la página (0–1), desde arriba a la izquierda
  required    boolean NOT NULL DEFAULT true,
  hint        text,
  value       text                                                          -- texto, «true», o la imagen (data:image/png) de la firma
);
CREATE INDEX sign_fields_request_idx ON sign_fields (request_id);

-- Registro de auditoría: todo lo que pasa con el documento.
CREATE TABLE sign_events (
  id          bigserial PRIMARY KEY,
  request_id  uuid NOT NULL REFERENCES sign_requests(id) ON DELETE CASCADE,
  signer_id   uuid REFERENCES sign_signers(id) ON DELETE SET NULL,
  kind        text NOT NULL,      -- created, sent, invited, viewed, code_sent, code_verified, signed, declined, reminded, completed, cancelled, expired
  detail      text,
  ip          text,
  user_agent  text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sign_events_request_idx ON sign_events (request_id, at);

COMMIT;
