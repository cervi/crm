-- Vistas guardadas de los listados: filtros, orden y columnas con un nombre.
-- Pueden ser de una persona o compartidas con todo el equipo.
CREATE TABLE saved_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity      text NOT NULL CHECK (entity IN ('deals', 'leads', 'organizations', 'persons', 'activities')),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  query       text NOT NULL DEFAULT '',          -- parámetros de la URL (sin la vista ni el panel abierto)
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,   -- NULL: compartida
  position    integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_views_entity_idx ON saved_views (entity, user_id);

-- Vistas de serie, compartidas: lo que más se mira en un CRM.
INSERT INTO saved_views (entity, name, query, position) VALUES
  ('deals', 'Parados', 'flag=rotten&sort=days&dir=desc', 1),
  ('deals', 'Sin próxima actividad', 'flag=no_activity', 2),
  ('deals', 'Actividad vencida', 'flag=overdue&sort=next_activity', 3),
  ('deals', 'Cierran este mes', 'flag=closing_month&sort=close', 4),
  ('deals', 'Más grandes', 'sort=value&dir=desc', 5);
