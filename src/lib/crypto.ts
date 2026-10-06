import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { UserError } from "./errors";

/**
 * Cifrado de secretos guardados en la base de datos (tokens del correo).
 * Clave: TOKEN_ENCRYPTION_KEY (mínimo 32 caracteres); se deriva con SHA-256.
 */
function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  if (raw.length < 32) throw new UserError("Falta TOKEN_ENCRYPTION_KEY (mínimo 32 caracteres) para guardar la conexión del correo.");
  return createHash("sha256").update(raw).digest();
}

export const encryptionConfigured = () => (process.env.TOKEN_ENCRYPTION_KEY ?? "").length >= 32;

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function decrypt(token: string): string {
  const [v, iv, tag, data] = token.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Formato cifrado no válido");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
