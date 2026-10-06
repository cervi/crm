// Mismo formato de contraseña y sesión que src/lib/session.ts, para los scripts
// (demo, pruebas y alta de usuarios desde la terminal).
import { createHash, randomBytes, scryptSync } from "node:crypto";

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", 16384, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Crea una sesión para un usuario y devuelve el valor de la cookie crm_session. */
export async function createSessionToken(sql, userId) {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (${hash}, ${userId}, now() + interval '1 day')`;
  return token;
}
