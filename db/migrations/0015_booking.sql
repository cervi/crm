-- Enlace de reserva: página pública donde un contacto elige un hueco libre del
-- calendario de una persona del equipo. La reunión se crea en su calendario con
-- invitación y queda en el deal.
CREATE TABLE booking_pages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,40}$'),
  title             text NOT NULL DEFAULT 'Reunión' CHECK (length(title) BETWEEN 1 AND 120),
  description       text,
  duration_minutes  integer NOT NULL DEFAULT 30 CHECK (duration_minutes BETWEEN 10 AND 240),
  activity_type     text NOT NULL DEFAULT 'video_call' REFERENCES activity_types(key) ON UPDATE CASCADE,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Enlaces personales para un contacto de un deal (la reserva queda en ese deal).
CREATE TABLE booking_links (
  token       text PRIMARY KEY,
  page_id     uuid NOT NULL REFERENCES booking_pages(id) ON DELETE CASCADE,
  deal_id     uuid REFERENCES deals(id) ON DELETE CASCADE,
  person_id   uuid REFERENCES persons(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, deal_id, person_id)
);

-- Qué actividades llegaron por el enlace de reserva.
ALTER TABLE activities ADD COLUMN booked_via uuid REFERENCES booking_pages(id) ON DELETE SET NULL;
