-- =====================================================================
-- 0030 — Firma de los correos
--
--   · Cada persona tiene su firma (users.email_signature, de la 0029).
--   · Cada buzón puede tener la suya (p. ej. los de outbound, con otro
--     dominio y otro nombre): si la tiene, manda sobre la de la persona.
-- =====================================================================

BEGIN;
ALTER TABLE mailbox_connections ADD COLUMN signature text;
COMMIT;
