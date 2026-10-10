-- =====================================================================
-- 0033 — Avisos a medida y resúmenes semanales
--
--   · Cada persona elige qué avisos recibe y por dónde (solo en la app,
--     también por correo al momento, o agrupados en un resumen), y unas
--     horas de silencio.
--   · Cada persona ordena y oculta las secciones del menú lateral.
--   · Resúmenes por correo: el plan del lunes, el balance del viernes y el
--     del equipo para quien lo lleva. La ficha de cada reunión, antes.
-- =====================================================================

BEGIN;

ALTER TABLE users ADD COLUMN notification_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Menú lateral a medida: orden y secciones ocultas ({order: [...], hidden: [...]}).
ALTER TABLE users ADD COLUMN nav_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE notifications
  ADD COLUMN category  text,
  ADD COLUMN email_mode text,          -- 'now' | 'digest' | NULL (solo en la app)
  ADD COLUMN emailed_at timestamptz;
CREATE INDEX notifications_email_pending_idx ON notifications (user_id) WHERE email_mode IS NOT NULL AND emailed_at IS NULL;

-- Correos periódicos ya enviados (para no repetir).
CREATE TABLE summary_log (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind     text NOT NULL,              -- 'week_plan' | 'week_review' | 'team_week' | 'notif_digest' | 'meeting_prep:<id>' | 'no_reply:<id>'
  period   text NOT NULL,              -- semana ISO, día o id
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind, period)
);

COMMIT;
