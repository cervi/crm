-- Automatizaciones generales: nuevos disparadores (fase, alta, ganado/perdido,
-- inactividad, correos, reservas), condiciones y nuevas acciones (nota,
-- responsable, webhook).

-- Nuevo tipo de acción: llamar a un webhook (Zapier, Make, Slack, n8n…).
ALTER TABLE ai_permissions DROP CONSTRAINT ai_permissions_action_type_check;
ALTER TABLE ai_permissions ADD CONSTRAINT ai_permissions_action_type_check CHECK (action_type IN
  ('create_task', 'add_note', 'draft_email', 'move_stage', 'update_deal', 'webhook'));
ALTER TABLE automation_actions DROP CONSTRAINT automation_actions_action_type_check;
ALTER TABLE automation_actions ADD CONSTRAINT automation_actions_action_type_check CHECK (action_type IN
  ('create_task', 'add_note', 'draft_email', 'move_stage', 'update_deal', 'notify', 'webhook'));

INSERT INTO ai_permissions (actor, action_type, autonomy, allowed_autonomy) VALUES
  ('assistant', 'webhook', 'auto', ARRAY['off', 'ask', 'auto']),
  ('external',  'webhook', 'off',  ARRAY['off', 'ask', 'auto'])
ON CONFLICT DO NOTHING;
