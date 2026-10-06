import { sql } from "./db";

export type UserRow = { id: string; name: string; kind: "human" | "ai_agent" };

export async function listUsers(): Promise<UserRow[]> {
  return sql<UserRow[]>`
    SELECT id, name, kind FROM users WHERE is_active ORDER BY kind, name`;
}
