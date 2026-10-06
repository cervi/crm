-- =====================================================================
-- 0024 — Lectura de correos al detalle y salud de los deals
--
--   email_opens       Cada apertura de un correo (no solo la primera y la
--                     última): fecha, dispositivo, programa de correo, lugar
--                     aproximado (si el servidor lo sabe) y si parece
--                     automática (escáneres, precarga de Apple Mail…).
--   proposal_views    Lo mismo para las visitas a las propuestas.
--   deal_health       Salud 0–100 de cada deal abierto, con sus señales.
--   deal_health_daily Una foto al día, para ver qué empeora o mejora.
-- =====================================================================

BEGIN;

CREATE TABLE email_opens (
  id         bigserial PRIMARY KEY,
  email_id   uuid NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  device     text CHECK (device IN ('mobile', 'tablet', 'desktop', 'unknown')),
  client     text,                       -- Gmail, Outlook, Apple Mail…
  place      text,                       -- ciudad o país, solo si el proxy lo indica
  reader     text,                       -- huella anónima (IP + navegador, con hash) para distinguir lectores
  automatic  boolean NOT NULL DEFAULT false
);
CREATE INDEX email_opens_email_idx ON email_opens (email_id, at);

ALTER TABLE email_clicks
  ADD COLUMN device    text,
  ADD COLUMN reader    text,
  ADD COLUMN automatic boolean NOT NULL DEFAULT false;

-- Último aviso de apertura enviado (para no repetir el mismo día).
ALTER TABLE emails ADD COLUMN open_alert_at timestamptz;
CREATE INDEX emails_sent_idx ON emails (sent_at DESC) WHERE direction = 'out' AND status = 'sent';
CREATE INDEX emails_in_person_idx ON emails (person_id, sent_at) WHERE direction = 'in';

CREATE TABLE proposal_views (
  id          bigserial PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  device      text,
  place       text,
  reader      text
);
CREATE INDEX proposal_views_idx ON proposal_views (proposal_id, at);

-- Avisos al abrir: «all» (primera apertura y cuando vuelven a abrirlo otro
-- día), «reopen» (solo cuando vuelven a abrirlo) u «off».
ALTER TABLE app_settings
  ADD COLUMN open_alerts text NOT NULL DEFAULT 'all' CHECK (open_alerts IN ('all', 'reopen', 'off')),
  -- Nombres de competidores: si aparecen en correos o notas, es una señal.
  ADD COLUMN competitors text[] NOT NULL DEFAULT '{}';

CREATE TABLE deal_health (
  deal_id     uuid PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  score       integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  signals     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{key, label, detail, tone: risk|good, points}]
  computed_at timestamptz NOT NULL DEFAULT now(),
  red_since   timestamptz                           -- desde cuándo está en rojo (para avisar una sola vez)
);
CREATE INDEX deal_health_score_idx ON deal_health (score);

CREATE TABLE deal_health_daily (
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  day     date NOT NULL,
  score   integer NOT NULL,
  PRIMARY KEY (deal_id, day)
);

COMMIT;
