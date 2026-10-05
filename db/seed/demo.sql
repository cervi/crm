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
  ('organization', 'sector_cliente', 'Sector', 'single_option',
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
   '00000000-0000-0000-0000-000000000001', '{"sector_cliente":"retail"}');

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
