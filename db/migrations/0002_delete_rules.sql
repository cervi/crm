-- =====================================================================
-- 0002_delete_rules.sql — Borrados coherentes con las restricciones
--
-- En 0001, algunas claves foráneas ponían a NULL una columna que un CHECK
-- exigía, así que borrar físicamente un deal, contacto o empresa fallaba
-- (p. ej. al limpiar tras una importación o al suprimir datos por RGPD).
--
--   * Un lead convertido no puede quedarse sin su deal: no se permite borrar
--     un deal que convirtió un lead (los deals se borran de forma lógica).
--   * Leads y actividades pueden quedar sin contacto/empresa si estos se
--     borran físicamente: la asociación obligatoria se valida al crearlos
--     en la aplicación, no en la base de datos.
-- =====================================================================

BEGIN;

ALTER TABLE leads DROP CONSTRAINT leads_converted_deal_fk;
ALTER TABLE leads
  ADD CONSTRAINT leads_converted_deal_fk
  FOREIGN KEY (converted_deal_id) REFERENCES deals(id) ON DELETE RESTRICT;

ALTER TABLE leads DROP CONSTRAINT leads_check;
ALTER TABLE activities DROP CONSTRAINT activities_check;

COMMIT;
