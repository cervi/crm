-- Inicio de sesión por usuario y permisos por rol.
--   admin:  todo, incluidos los ajustes y la gestión de usuarios.
--   member: trabaja con deals, leads, contactos, correo y la bandeja de la IA.
--   viewer: solo lectura.

ALTER TABLE users
  ADD COLUMN password_hash  text,
  ADD COLUMN last_login_at  timestamptz,
  ADD COLUMN failed_logins  integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until   timestamptz,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- Sesiones: en la cookie va un token aleatorio; aquí solo su hash (SHA-256),
-- para que una copia de la base de datos no permita entrar.
CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text NOT NULL UNIQUE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  user_agent    text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
