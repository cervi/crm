-- Interruptores del CRM: encender o apagar módulos enteros desde Ajustes.
-- El servidor puede bloquear algunos apagados (OUTBOUND_DISABLED, SWITCHES_OFF) y entonces no se encienden desde aquí.
ALTER TABLE app_settings ADD COLUMN switches jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Lo que no ha salido porque un interruptor lo impedía: prueba de que no se envió nada.
CREATE TABLE outbound_blocked (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  switch   text NOT NULL,
  kind     text NOT NULL,          -- correo, invitación, webhook…
  target   text,                   -- a quién o adónde iba
  subject  text,
  source   text                    -- qué lo intentó (secuencia, aviso, manual…)
);
CREATE INDEX outbound_blocked_at_idx ON outbound_blocked (at DESC);
