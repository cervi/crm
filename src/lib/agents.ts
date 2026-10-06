import { createHash, randomBytes } from "node:crypto";
import { sql } from "./db";
import { UserError } from "./errors";

// Claves de los agentes externos (MCP). Se guarda solo su hash.
export type AgentKey = { id: string; name: string; prefix: string; can_write: boolean; created_at: Date; last_used_at: Date | null; revoked_at: Date | null; creator: string | null };

const hash = (k: string) => createHash("sha256").update(k).digest("hex");

export const listAgentKeys = () => sql<AgentKey[]>`
  SELECT k.id, k.name, k.prefix, k.can_write, k.created_at, k.last_used_at, k.revoked_at, u.name AS creator
  FROM agent_keys k LEFT JOIN users u ON u.id = k.created_by ORDER BY k.revoked_at NULLS FIRST, k.created_at DESC`;

/** Crea una clave y la devuelve (solo esta vez). */
export async function createAgentKey(userId: string, name: string, canWrite: boolean): Promise<string> {
  const n = name.trim();
  if (!n) throw new UserError("Ponle un nombre al agente (p. ej. «Grok Bot»).");
  const key = `crm_${randomBytes(24).toString("base64url")}`;
  await sql`INSERT INTO agent_keys (name, key_hash, prefix, can_write, created_by)
            VALUES (${n.slice(0, 80)}, ${hash(key)}, ${key.slice(0, 10)}, ${canWrite}, ${userId})`;
  return key;
}

export async function revokeAgentKey(id: string) {
  await sql`UPDATE agent_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL`;
}

export type Agent = { id: string; name: string; can_write: boolean };

/** El agente de una clave enviada en «Authorization: Bearer …», o null. */
export async function agentFromHeaders(headers: Headers): Promise<Agent | null> {
  const auth = headers.get("authorization") ?? "";
  const key = (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : headers.get("x-api-key") ?? "").trim();
  if (!/^crm_[A-Za-z0-9_-]{20,64}$/.test(key)) return null;
  const [a] = await sql<Agent[]>`
    UPDATE agent_keys SET last_used_at = now() WHERE key_hash = ${hash(key)} AND revoked_at IS NULL
    RETURNING id, name, can_write`;
  return a ?? null;
}
