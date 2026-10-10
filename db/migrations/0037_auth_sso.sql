-- =====================================================================
-- 0037 — Entrar con Google o Microsoft y registro de accesos
--
--   · Cada usuario puede entrar con su cuenta de Google o Microsoft (la del
--     mismo correo). Si se permite, puede no tener contraseña.
--   · Opcional: quien tenga correo del dominio de la empresa puede entrar
--     sin que nadie le dé de alta (entra con el rol elegido).
--   · Registro de accesos: cada entrada (y cada intento fallido).
-- =====================================================================

BEGIN;

ALTER TABLE users ADD COLUMN sso_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN last_login_method text;

ALTER TABLE app_settings ADD COLUMN sso_domain text;
ALTER TABLE app_settings ADD COLUMN sso_default_role text NOT NULL DEFAULT 'member' CHECK (sso_default_role IN ('member', 'viewer'));
ALTER TABLE app_settings ADD COLUMN password_login boolean NOT NULL DEFAULT true;

CREATE TABLE login_events (
  id         bigserial PRIMARY KEY,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  email      text,
  method     text NOT NULL,          -- password | google | microsoft
  success    boolean NOT NULL,
  reason     text,
  ip         text,
  user_agent text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_events_at_idx ON login_events (at DESC);
CREATE INDEX login_events_user_idx ON login_events (user_id, at DESC);

COMMIT;
