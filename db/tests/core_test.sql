-- =====================================================================
-- core_test.sql — Comprobaciones del modelo de datos.
-- Requiere haber cargado db/seed/demo.sql. Todo se deshace al final.
-- Uso: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/core_test.sql
-- =====================================================================

BEGIN;

CREATE FUNCTION pg_temp.expect_error(sql text, what text) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE sql;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'OK  · %', what;
    RETURN;
  END;
  RAISE EXCEPTION 'FALLO · se esperaba un error: %', what;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION pg_temp.expect(cond boolean, what text) RETURNS void AS $$
BEGIN
  IF cond IS NOT TRUE THEN RAISE EXCEPTION 'FALLO · %', what; END IF;
  RAISE NOTICE 'OK  · %', what;
END;
$$ LANGUAGE plpgsql;

-- 1. Un deal no puede estar en una fase de otro pipeline.
SELECT pg_temp.expect_error($q$
  INSERT INTO deals (title, pipeline_id, stage_id)
  VALUES ('x', '10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000011')
$q$, 'la fase debe pertenecer al pipeline del deal');

-- 2. Un email no puede repetirse entre contactos (deduplicación).
SELECT pg_temp.expect_error($q$
  INSERT INTO person_emails (person_id, email)
  VALUES ('70000000-0000-0000-0000-000000000002', 'ANA@paco.example')
$q$, 'email duplicado (sin distinguir mayúsculas)');

-- 3. Dominio de empresa único.
SELECT pg_temp.expect_error($q$
  INSERT INTO organizations (name, domain) VALUES ('Paco bis', 'PACO.example')
$q$, 'dominio de empresa duplicado');

-- 4. Mover un deal de fase registra el historial y reinicia el contador.
UPDATE deals SET stage_id = '20000000-0000-0000-0000-000000000032'
 WHERE id = '90000000-0000-0000-0000-000000000002';
SELECT pg_temp.expect(
  (SELECT count(*) FROM deal_stage_history WHERE deal_id = '90000000-0000-0000-0000-000000000002') = 2,
  'el cambio de fase queda en el historial');
SELECT pg_temp.expect(
  (SELECT stage_entered_at > now() - interval '1 minute' FROM deals WHERE id = '90000000-0000-0000-0000-000000000002'),
  'stage_entered_at se actualiza al cambiar de fase');

-- 5. Cambiar de pipeline obliga a usar una fase de ese pipeline.
SELECT pg_temp.expect_error($q$
  UPDATE deals SET pipeline_id = '10000000-0000-0000-0000-000000000002'
  WHERE id = '90000000-0000-0000-0000-000000000002'
$q$, 'cambiar de pipeline sin cambiar de fase falla');
UPDATE deals SET pipeline_id = '10000000-0000-0000-0000-000000000002',
                 stage_id    = '20000000-0000-0000-0000-000000000022'
 WHERE id = '90000000-0000-0000-0000-000000000002';
SELECT pg_temp.expect(
  (SELECT pipeline_id = '10000000-0000-0000-0000-000000000002' FROM deals WHERE id = '90000000-0000-0000-0000-000000000002'),
  'mover un deal a otro pipeline con su fase funciona');

-- 6. Reabrir un deal perdido limpia el motivo y la fecha de pérdida.
UPDATE deals SET status = 'open' WHERE id = '90000000-0000-0000-0000-000000000003';
SELECT pg_temp.expect(
  (SELECT lost_at IS NULL AND lost_reason_id IS NULL FROM deals WHERE id = '90000000-0000-0000-0000-000000000003'),
  'reabrir un deal limpia los datos de pérdida');

-- 7. La importación puede fijar fechas históricas.
INSERT INTO deals (title, pipeline_id, stage_id, status, won_at, stage_entered_at, pipedrive_id)
VALUES ('Importado', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000014',
        'won', '2023-03-01', '2023-02-01', 12345);
SELECT pg_temp.expect(
  (SELECT won_at::date = '2023-03-01' FROM deals WHERE pipedrive_id = 12345),
  'se respetan las fechas históricas al importar');

-- 8. Un contacto antiguo puede tener relación actual con otra empresa.
INSERT INTO organizations (id, name, domain) VALUES ('60000000-0000-0000-0000-000000000099', 'Nueva S.A.', 'nueva.example');
INSERT INTO person_organizations (person_id, organization_id, job_title)
VALUES ('70000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000099', 'CMO');
SELECT pg_temp.expect(
  (SELECT count(*) FROM person_organizations WHERE person_id = '70000000-0000-0000-0000-000000000002') = 2,
  'el historial laboral del contacto se conserva al cambiar de empresa');

-- 9. Un lead convertido debe apuntar a su deal, y viceversa.
SELECT pg_temp.expect_error($q$
  UPDATE leads SET converted_deal_id = NULL WHERE id = '80000000-0000-0000-0000-000000000001'
$q$, 'un lead convertido necesita su deal');

-- 10. Las opciones son obligatorias en campos de selección.
SELECT pg_temp.expect_error($q$
  INSERT INTO custom_field_definitions (entity_type, key, label, field_type)
  VALUES ('deal', 'prioridad', 'Prioridad', 'single_option')
$q$, 'un campo de selección necesita opciones');

-- 11. El deal parado sin sesión agendada aparece en la vista de seguimiento.
SELECT pg_temp.expect(
  (SELECT count(*) FROM open_deals_status WHERE is_rotten AND NOT has_upcoming_session) >= 1,
  'la vista detecta deals parados sin sesión agendada');

ROLLBACK;
