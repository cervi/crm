-- =====================================================================
-- 0034 — Objetivo mensual de cada comercial
--   Lo pone un administrador en Usuarios; «Hoy» enseña cómo se va.
-- =====================================================================

BEGIN;
ALTER TABLE users ADD COLUMN monthly_target numeric(14, 2) CHECK (monthly_target IS NULL OR monthly_target >= 0);
COMMIT;
