-- Agentes externos (Grok Bot u otros) conectados por MCP: cada uno con su
-- clave; lo que hacen pasa por los permisos de «Agentes externos».
CREATE TABLE agent_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  key_hash      text NOT NULL UNIQUE,
  prefix        text NOT NULL,             -- primeros caracteres, para reconocerla
  can_write     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
