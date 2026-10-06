-- =====================================================================
-- 0003_dashboards.sql — Dashboards personalizables
--
-- Cada dashboard tiene widgets; cada widget guarda su configuración
-- (fuente, métrica, agrupación, periodo, filtros y tipo de gráfico) en
-- jsonb. La aplicación valida esa configuración y la traduce a SQL a
-- partir de una lista cerrada de opciones.
-- =====================================================================

BEGIN;

CREATE TABLE dashboards (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(trim(name)) > 0),
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dashboard_widgets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  title        text NOT NULL CHECK (length(trim(title)) > 0),
  config       jsonb NOT NULL,
  width        smallint NOT NULL DEFAULT 1 CHECK (width IN (1, 2)),  -- 1 = media fila, 2 = fila entera
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dashboard_widgets_dashboard_idx ON dashboard_widgets (dashboard_id, position);

CREATE TRIGGER dashboards_updated_at BEFORE UPDATE ON dashboards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER dashboard_widgets_updated_at BEFORE UPDATE ON dashboard_widgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Dashboards iniciales: se pueden editar o borrar desde la aplicación.
WITH ventas AS (
  INSERT INTO dashboards (name, position) VALUES ('Ventas', 1) RETURNING id
)
INSERT INTO dashboard_widgets (dashboard_id, title, config, width, position)
SELECT ventas.id, w.title, w.config::jsonb, w.width, w.position FROM ventas, (VALUES
  ('Ingresos ganados',            '{"source":"deals","metric":"sum_value","group_by":"none","date_field":"won_at","period":"this_quarter","chart":"number","filters":{"status":"won"}}', 1, 1),
  ('Tasa de cierre',              '{"source":"deals","metric":"win_rate","group_by":"none","date_field":"created_at","period":"90d","chart":"number","filters":{}}', 1, 2),
  ('Ingresos ganados por mes',    '{"source":"deals","metric":"sum_value","group_by":"month","date_field":"won_at","period":"12m","chart":"line","filters":{"status":"won"}}', 2, 3),
  ('Valor abierto por fase',      '{"source":"deals","metric":"sum_value","group_by":"stage","date_field":"created_at","period":"all","chart":"bar","filters":{"status":"open"}}', 1, 4),
  ('Motivos de pérdida',          '{"source":"deals","metric":"count","group_by":"lost_reason","date_field":"lost_at","period":"12m","chart":"bar","filters":{"status":"lost"}}', 1, 5),
  ('Días medios hasta ganar',     '{"source":"deals","metric":"avg_days_to_close","group_by":"none","date_field":"won_at","period":"12m","chart":"number","filters":{"status":"won"}}', 1, 6),
  ('Ausencias en sesiones',       '{"source":"activities","metric":"no_show_rate","group_by":"none","date_field":"done_at","period":"90d","chart":"number","filters":{}}', 1, 7)
) AS w(title, config, width, position);

WITH captacion AS (
  INSERT INTO dashboards (name, position) VALUES ('Captación', 2) RETURNING id
)
INSERT INTO dashboard_widgets (dashboard_id, title, config, width, position)
SELECT captacion.id, w.title, w.config::jsonb, w.width, w.position FROM captacion, (VALUES
  ('Leads nuevos',                '{"source":"leads","metric":"count","group_by":"none","date_field":"created_at","period":"30d","chart":"number","filters":{}}', 1, 1),
  ('Conversión de lead a deal',   '{"source":"leads","metric":"conversion_rate","group_by":"none","date_field":"created_at","period":"90d","chart":"number","filters":{}}', 1, 2),
  ('Leads por semana',            '{"source":"leads","metric":"count","group_by":"week","date_field":"created_at","period":"90d","chart":"line","filters":{}}', 2, 3),
  ('Leads por origen',            '{"source":"leads","metric":"count","group_by":"source","date_field":"created_at","period":"90d","chart":"bar","filters":{}}', 1, 4),
  ('Conversión por origen',       '{"source":"leads","metric":"conversion_rate","group_by":"source","date_field":"created_at","period":"12m","chart":"bar","filters":{}}', 1, 5),
  ('Leads por etapa del funnel',  '{"source":"leads","metric":"count","group_by":"funnel_stage","date_field":"created_at","period":"all","chart":"bar","filters":{"status":"open"}}', 1, 6)
) AS w(title, config, width, position);

COMMIT;
