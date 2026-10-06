-- Avisos para cada persona (menciones, deals que le asignan, respuestas de
-- clientes…) y papelera (lo borrado se puede recuperar durante 30 días).
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text,
  link        text,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- Quién borró cada cosa (para la papelera).
ALTER TABLE deals ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE persons ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE leads ADD COLUMN deleted_by uuid REFERENCES users(id) ON DELETE SET NULL;
-- Al fusionar duplicados, a cuál se unió.
ALTER TABLE persons ADD COLUMN merged_into uuid REFERENCES persons(id) ON DELETE SET NULL;
ALTER TABLE organizations ADD COLUMN merged_into uuid REFERENCES organizations(id) ON DELETE SET NULL;
