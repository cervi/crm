-- =====================================================================
-- demo.sql — Datos de ejemplo para desarrollo (NO usar en producción)
-- Refleja los casos hablados: la empresa Paco con varios contactos y
-- varios deals en estados distintos, varios pipelines y un lead previo.
-- =====================================================================

BEGIN;

INSERT INTO users (id, name, email, kind, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Gestor de cuentas', 'ventas@example.com', 'human', 'admin'),
  ('00000000-0000-0000-0000-000000000002', 'Generación de leads', 'leads@example.com', 'human', 'member'),
  ('00000000-0000-0000-0000-000000000003', 'Customer Success', 'cs@example.com', 'human', 'member'),
  ('00000000-0000-0000-0000-0000000000a1', 'Agente de seguimiento', NULL, 'ai_agent', 'member');

-- Pipelines y fases (inspirados en Pipedrive) -------------------------
INSERT INTO pipelines (id, name, position) VALUES
  ('10000000-0000-0000-0000-000000000001', 'Inbound', 1),
  ('10000000-0000-0000-0000-000000000002', 'Outbound', 2),
  ('10000000-0000-0000-0000-000000000003', 'Ampliaciones', 3);

INSERT INTO stages (id, pipeline_id, name, position, win_probability, rotten_after_days, required_activity_type) VALUES
  ('20000000-0000-0000-0000-000000000011', '10000000-0000-0000-0000-000000000001', 'Demo solicitada',   1, 20, 3,  'demo'),
  ('20000000-0000-0000-0000-000000000012', '10000000-0000-0000-0000-000000000001', 'Demo realizada',    2, 40, 7,  'video_call'),
  ('20000000-0000-0000-0000-000000000013', '10000000-0000-0000-0000-000000000001', 'Propuesta enviada', 3, 60, 14, 'call'),
  ('20000000-0000-0000-0000-000000000014', '10000000-0000-0000-0000-000000000001', 'Negociación',       4, 80, 14, 'call'),
  ('20000000-0000-0000-0000-000000000021', '10000000-0000-0000-0000-000000000002', 'Primer contacto',   1, 10, 7,  NULL),
  ('20000000-0000-0000-0000-000000000022', '10000000-0000-0000-0000-000000000002', 'Reunión agendada',  2, 30, 7,  'video_call'),
  ('20000000-0000-0000-0000-000000000023', '10000000-0000-0000-0000-000000000002', 'Propuesta enviada', 3, 60, 14, 'call'),
  ('20000000-0000-0000-0000-000000000031', '10000000-0000-0000-0000-000000000003', 'Necesidad detectada', 1, 30, 14, 'video_call'),
  ('20000000-0000-0000-0000-000000000032', '10000000-0000-0000-0000-000000000003', 'Propuesta enviada',   2, 60, 14, 'call');

INSERT INTO lost_reasons (id, label, followup_days) VALUES
  ('30000000-0000-0000-0000-000000000001', 'Sin presupuesto ahora', 90),
  ('30000000-0000-0000-0000-000000000002', 'Eligió a la competencia', 180),
  ('30000000-0000-0000-0000-000000000003', 'No es buen momento', 60),
  ('30000000-0000-0000-0000-000000000004', 'No encaja con el producto', NULL);

INSERT INTO products (id, name, code, unit_price, billing) VALUES
  ('40000000-0000-0000-0000-000000000001', 'Plataforma — licencia anual', 'PLAT-Y', 12000, 'yearly'),
  ('40000000-0000-0000-0000-000000000002', 'Ampliación de servicio', 'EXT-SVC', 4000, 'yearly'),
  ('40000000-0000-0000-0000-000000000003', 'Segunda plataforma', 'PLAT-2', 9000, 'yearly');

-- Campos personalizados de ejemplo -------------------------------------
INSERT INTO custom_field_definitions (entity_type, key, label, field_type, options, position) VALUES
  ('organization', 'segmento', 'Segmento', 'single_option',
     '[{"key":"retail","label":"Retail"},{"key":"saas","label":"SaaS"},{"key":"industria","label":"Industria"}]', 1),
  ('deal', 'competidor', 'Competidor principal', 'text', NULL, 1),
  ('deal', 'fecha_renovacion', 'Fecha de renovación', 'date', NULL, 2),
  ('person', 'idioma', 'Idioma preferido', 'single_option',
     '[{"key":"es","label":"Español"},{"key":"en","label":"Inglés"}]', 1);

-- Etiquetas -------------------------------------------------------------
INSERT INTO tags (id, name, color) VALUES
  ('50000000-0000-0000-0000-000000000001', 'webinar', '#2f6fde'),
  ('50000000-0000-0000-0000-000000000002', 'ebook', '#2a9d8f');

-- Empresa Paco con dos contactos (uno antiguo) -------------------------
INSERT INTO organizations (id, name, domain, website, industry, employee_count, country, owner_id, custom) VALUES
  ('60000000-0000-0000-0000-000000000001', 'Paco S.L.', 'paco.example', 'https://paco.example', 'Retail', 120, 'ES',
   '00000000-0000-0000-0000-000000000001', '{"segmento":"retail"}');

INSERT INTO persons (id, first_name, last_name, owner_id, marketing_consent, marketing_consent_at, custom) VALUES
  ('70000000-0000-0000-0000-000000000001', 'Ana', 'García', '00000000-0000-0000-0000-000000000001', true, now() - interval '200 days', '{"idioma":"es"}'),
  ('70000000-0000-0000-0000-000000000002', 'Luis', 'Martín', '00000000-0000-0000-0000-000000000001', true, now() - interval '700 days', '{}');

INSERT INTO person_emails (person_id, email, is_primary) VALUES
  ('70000000-0000-0000-0000-000000000001', 'ana@paco.example', true),
  ('70000000-0000-0000-0000-000000000002', 'luis@paco.example', true);
INSERT INTO person_phones (person_id, phone, label, is_primary) VALUES
  ('70000000-0000-0000-0000-000000000001', '+34 600 000 001', 'mobile', true);

INSERT INTO person_organizations (person_id, organization_id, job_title, status, started_at, ended_at) VALUES
  ('70000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001', 'Directora de Marketing', 'current', '2024-06-01', NULL),
  ('70000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', 'Director de Marketing', 'former', '2021-01-01', '2024-05-31');

-- Ana llegó como lead por un webinar y luego pidió una demo ------------
INSERT INTO leads (id, title, person_id, organization_id, source, source_detail, funnel_stage, owner_id, created_at) VALUES
  ('80000000-0000-0000-0000-000000000001', 'Ana García — webinar captación', '70000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000001', 'webinar', 'Webinar: automatizar la captación', 'mofu',
   '00000000-0000-0000-0000-000000000002', now() - interval '120 days');
INSERT INTO lead_tags (lead_id, tag_id) VALUES
  ('80000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001');

-- Tres deals de Paco: ganado, abierto y perdido ------------------------
INSERT INTO deals (id, title, organization_id, pipeline_id, stage_id, status, value, owner_id, lead_id, source, stage_entered_at, created_at) VALUES
  ('90000000-0000-0000-0000-000000000001', 'Paco — contrato anual', '60000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000014', 'open', 12000,
   '00000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001', 'webinar',
   now() - interval '40 days', now() - interval '90 days'),
  ('90000000-0000-0000-0000-000000000002', 'Paco — ampliación de servicio', '60000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000031', 'open', 4000,
   '00000000-0000-0000-0000-000000000001', NULL, 'cliente',
   now() - interval '20 days', now() - interval '20 days'),
  ('90000000-0000-0000-0000-000000000003', 'Paco — otra plataforma', '60000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000013', 'open', 9000,
   '00000000-0000-0000-0000-000000000001', NULL, 'formulario demo',
   now() - interval '30 days', now() - interval '45 days');

UPDATE leads SET status = 'converted', converted_deal_id = '90000000-0000-0000-0000-000000000001',
                 converted_at = now() - interval '90 days'
 WHERE id = '80000000-0000-0000-0000-000000000001';

UPDATE deals SET status = 'won' WHERE id = '90000000-0000-0000-0000-000000000001';
UPDATE deals SET status = 'lost', lost_reason_id = '30000000-0000-0000-0000-000000000002',
                 lost_note = 'Se quedan con su proveedor actual este año'
 WHERE id = '90000000-0000-0000-0000-000000000003';

INSERT INTO deal_participants (deal_id, person_id, role, is_primary) VALUES
  ('90000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001', 'decisora', true),
  ('90000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001', 'decisora', true),
  ('90000000-0000-0000-0000-000000000003', '70000000-0000-0000-0000-000000000001', 'decisora', true);

INSERT INTO deal_products (deal_id, product_id, unit_price) VALUES
  ('90000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 12000),
  ('90000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', 4000),
  ('90000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000003', 9000);

-- Una demo a la que no se presentaron (caso del seguimiento automático)
INSERT INTO activities (type, subject, due_at, duration_minutes, done, outcome, deal_id, person_id, organization_id, owner_id) VALUES
  ('video_call', 'Revisión de necesidades — ampliación', now() - interval '2 days', 30, true, 'no_show',
   '90000000-0000-0000-0000-000000000002', '70000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001');

INSERT INTO notes (content, organization_id, author_id) VALUES
  ('Cliente desde el contrato anual. Interés en ampliar a más tiendas.',
   '60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001');

COMMIT;

-- ---------------------------------------------------------------------
-- Histórico de ejemplo para los dashboards: ~80 deals, 200 leads y 120
-- actividades repartidos en los últimos 12 meses. Determinista (setseed).
-- ---------------------------------------------------------------------
BEGIN;
SELECT setseed(0.42);

DO $$
DECLARE
  owners uuid[] := ARRAY['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002']::uuid[];
  sources text[] := ARRAY['webinar', 'ebook', 'formulario demo', 'referido', 'evento', 'blog'];
  details text[] := ARRAY['Webinar: automatizar la captación', 'Guía de ventas B2B', 'Webinar: IA en ventas', 'Plantilla de propuesta', 'Feria SaaS', 'Artículo: funnel'];
  reasons uuid[] := ARRAY(SELECT id FROM lost_reasons ORDER BY label);
  inbound_stages uuid[] := ARRAY(SELECT id FROM stages WHERE pipeline_id = '10000000-0000-0000-0000-000000000001' ORDER BY position);
  outbound_stages uuid[] := ARRAY(SELECT id FROM stages WHERE pipeline_id = '10000000-0000-0000-0000-000000000002' ORDER BY position);
  orgs uuid[] := '{}';
  deals_ids uuid[] := '{}';
  org uuid; person uuid; deal uuid; pipeline uuid; stage_list uuid[];
  created timestamptz; closed timestamptz; r float8; st text; i int;
BEGIN
  FOR i IN 1..40 LOOP
    INSERT INTO organizations (name, domain, industry, employee_count, country, owner_id)
    VALUES ('Empresa Demo ' || i, 'demo' || i || '.example',
            (ARRAY['Retail', 'SaaS', 'Industria', 'Logística', 'Salud'])[1 + floor(random() * 5)::int],
            (10 + floor(random() * 490))::int, 'ES', owners[1 + floor(random() * 2)::int])
    RETURNING id INTO org;
    orgs := orgs || org;
  END LOOP;

  FOR i IN 1..80 LOOP
    created := now() - make_interval(days => floor(random() * 360)::int, hours => floor(random() * 10)::int);
    IF random() < 0.75 THEN pipeline := '10000000-0000-0000-0000-000000000001'; stage_list := inbound_stages;
    ELSE pipeline := '10000000-0000-0000-0000-000000000002'; stage_list := outbound_stages; END IF;
    r := random();
    st := CASE WHEN r < 0.32 THEN 'won' WHEN r < 0.58 THEN 'lost' ELSE 'open' END;
    closed := least(now(), created + make_interval(days => (6 + floor(random() * 70))::int));
    IF st <> 'open' AND closed >= now() THEN st := 'open'; END IF;
    INSERT INTO deals (title, organization_id, pipeline_id, stage_id, status, value, owner_id, source,
                       stage_entered_at, created_at, won_at, lost_at, lost_reason_id)
    VALUES ('Oportunidad ' || i, orgs[1 + floor(random() * 40)::int], pipeline,
            CASE WHEN st = 'won' THEN stage_list[array_length(stage_list, 1)]
                 ELSE stage_list[1 + floor(random() * array_length(stage_list, 1))::int] END,
            st, (2000 + floor(random() * 56) * 500)::numeric, owners[1 + floor(random() * 2)::int],
            sources[1 + floor(random() * 6)::int],
            CASE WHEN st = 'open' THEN greatest(created, now() - make_interval(days => floor(random() * 25)::int)) ELSE created END,
            created,
            CASE WHEN st = 'won' THEN closed END,
            CASE WHEN st = 'lost' THEN closed END,
            CASE WHEN st = 'lost' THEN reasons[1 + floor(random() * array_length(reasons, 1))::int] END)
    RETURNING id INTO deal;
    deals_ids := deals_ids || deal;
  END LOOP;

  FOR i IN 1..200 LOOP
    created := now() - make_interval(days => floor(power(random(), 1.3) * 360)::int);
    INSERT INTO persons (first_name, last_name, marketing_consent, created_at)
    VALUES ('Contacto', 'Demo ' || i, random() < 0.7, created) RETURNING id INTO person;
    INSERT INTO person_emails (person_id, email, is_primary) VALUES (person, 'contacto' || i || '@demo' || (1 + i % 40) || '.example', true);
    r := random();
    st := CASE WHEN r < 0.16 THEN 'converted' WHEN r < 0.26 THEN 'archived' ELSE 'open' END;
    INSERT INTO leads (title, person_id, organization_id, source, source_detail, funnel_stage, status,
                       converted_deal_id, converted_at, owner_id, created_at)
    SELECT 'Contacto Demo ' || i, person, orgs[1 + i % 40], sources[k], details[k],
           (ARRAY['tofu', 'tofu', 'tofu', 'mofu', 'mofu', 'bofu'])[1 + floor(random() * 6)::int], st,
           CASE WHEN st = 'converted' THEN deals_ids[1 + floor(random() * 80)::int] END,
           CASE WHEN st = 'converted' THEN created + interval '9 days' END,
           owners[2], created
    FROM (SELECT 1 + floor(power(random(), 1.6) * 6)::int AS k) pick;
  END LOOP;

  FOR i IN 1..120 LOOP
    created := now() - make_interval(days => floor(random() * 180)::int);
    r := random();
    INSERT INTO activities (type, subject, due_at, done, done_at, outcome, deal_id, owner_id, created_at)
    VALUES ((ARRAY['call', 'video_call', 'demo', 'meeting', 'task'])[1 + floor(random() * 5)::int],
            'Seguimiento ' || i, created + interval '2 days', r < 0.7,
            CASE WHEN r < 0.7 THEN least(now(), created + interval '2 days') END,
            CASE WHEN r < 0.7 THEN (ARRAY['held', 'held', 'held', 'held', 'held', 'no_show', 'rescheduled'])[1 + floor(random() * 7)::int] END,
            deals_ids[1 + floor(random() * 80)::int], owners[1 + floor(random() * 2)::int], created);
  END LOOP;
END $$;

COMMIT;
