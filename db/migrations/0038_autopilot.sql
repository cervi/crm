-- =====================================================================
-- 0038 — Piloto automático
--   Lo que el CRM hace solo para que nada se quede parado: siguiente paso
--   cuando un deal se queda sin nada, llamadas cuando el cliente abre una y
--   otra vez un correo o un documento, ganar el deal al firmar el contrato…
-- =====================================================================

BEGIN;
ALTER TABLE automation_settings ADD COLUMN autopilot jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE autopilot_log (
  id        bigserial PRIMARY KEY,
  kind      text NOT NULL,
  ref       text,                  -- para no repetir (p. ej. el correo o el enlace)
  deal_id   uuid REFERENCES deals(id) ON DELETE CASCADE,
  detail    text,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX autopilot_log_at_idx ON autopilot_log (at DESC);
CREATE INDEX autopilot_log_ref_idx ON autopilot_log (kind, ref);
COMMIT;
