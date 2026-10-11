-- =====================================================================
-- 0041 — Ciclo de vida de los usuarios
--   Invitación por correo, «¿Has olvidado tu contraseña?», baja con
--   traspaso de lo que llevaba, reactivación, anonimización y su historial.
-- =====================================================================

BEGIN;
-- Enlaces de un solo uso: invitar (crear su contraseña) o restablecerla. Se guarda solo el hash.
CREATE TABLE user_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('invite', 'reset')),
  token_hash  text NOT NULL UNIQUE,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  sent_from   text,            -- buzón desde el que salió el correo (si salió)
  ip          text
);
CREATE INDEX user_tokens_user_idx ON user_tokens (user_id, purpose, created_at DESC);

-- Historial de altas, bajas, cambios de rol y de contraseña.
CREATE TABLE user_audit (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  user_id   uuid REFERENCES users(id) ON DELETE CASCADE,
  action    text NOT NULL,
  detail    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX user_audit_user_idx ON user_audit (user_id, at DESC);
CREATE INDEX user_audit_at_idx ON user_audit (at DESC);

ALTER TABLE users
  ADD COLUMN invited_at      timestamptz,
  ADD COLUMN invited_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN deactivated_at  timestamptz,
  ADD COLUMN deactivated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN anonymized_at   timestamptz;

-- Buzón desde el que salen los correos del sistema (invitaciones, contraseñas).
ALTER TABLE app_settings ADD COLUMN system_mail_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
COMMIT;
