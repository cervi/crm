-- =====================================================================
-- 0008_cs_handoff_email.sql — Traspaso a Customer Success por correo
--
--   * Cada empresa puede tener su responsable de Customer Success.
--   * Regla nueva: al ganar un deal, enviar el resumen por correo a ese
--     responsable o, si la empresa no tiene, a la dirección de CS por
--     defecto (en los ajustes de la regla). Empieza en «Preguntar».
-- =====================================================================

BEGIN;

ALTER TABLE organizations
  ADD COLUMN cs_manager_name  text,
  ADD COLUMN cs_manager_email text CHECK (cs_manager_email IS NULL OR position('@' IN cs_manager_email) > 1);

INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position) VALUES
  ('won_handoff_email',
   'Deal ganado: enviar el resumen a Customer Success',
   'Al ganar un deal, envía por correo el resumen del traspaso al responsable de Customer Success de la empresa o, si no tiene, a la dirección de CS por defecto.',
   'ask', ARRAY['off', 'ask', 'auto'],
   '{"cs_email": "", "cs_name": "", "subject": "Nuevo cliente: {empresa} — {deal}", "body": "Hola {cs_nombre},\n\nHemos ganado {deal} ({empresa}). Te paso el resumen para el traspaso:\n\n{resumen}\n\nFicha en el CRM: {enlace}\n\nCualquier duda, me dices.\n\nUn saludo,\n{responsable}"}',
   6);

COMMIT;
