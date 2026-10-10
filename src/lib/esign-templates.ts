import { randomBytes } from "node:crypto";
import { sql, transaction } from "./db";
import { UserError } from "./errors";
import type { Actor } from "./events";
import { getRequest } from "./esign";
import { sha256 } from "./esign-pdf";
import { isId } from "./validation";

// ===========================================================================
// Plantillas de firma: el contrato de siempre, con sus campos colocados por
// «papel» (tu empresa, cliente 1, cliente 2…). Al usarla en un deal, cada
// papel se rellena solo: tú y los contactos del deal, por orden.
// ===========================================================================

export type SignTemplate = {
  id: string; name: string; file_name: string; pages: { w: number; h: number }[];
  roles: { label: string; kind: "internal" | "external" }[]; fields: { role: number; type: string; page: number; x: number; y: number; w: number; h: number; required: boolean; hint: string | null }[];
  language: string; sequential: boolean; require_code: boolean; creator: string | null; created_at: Date; uses: number;
};

export async function listSignTemplates(): Promise<SignTemplate[]> {
  return sql<SignTemplate[]>`
    SELECT t.id, t.name, t.file_name, t.pages, t.roles, t.fields, t.language, t.sequential, t.require_code, u.name AS creator, t.created_at,
           0 AS uses
    FROM sign_templates t LEFT JOIN users u ON u.id = t.created_by WHERE t.archived_at IS NULL ORDER BY t.name`.catch(() => []);
}

export async function saveAsTemplate(actor: Actor, requestId: string, name: string) {
  const g = await getRequest(requestId);
  if (!g) throw new UserError("Ese documento ya no existe.");
  const n = name.trim().slice(0, 200) || g.request.title;
  let ext = 0, int = 0;
  const roles = g.signers.map((s) => (s.kind === "internal"
    ? { label: int++ === 0 ? "Tu empresa" : `Tu empresa ${int}`, kind: "internal" as const }
    : { label: ext++ === 0 ? "Cliente" : `Cliente ${ext}`, kind: "external" as const }));
  const idx = new Map(g.signers.map((s, i) => [s.id, i]));
  const fields = g.fields.map((f) => ({ role: idx.get(f.signer_id) ?? 0, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, hint: f.hint }));
  const [orig] = await sql<{ original: Buffer }[]>`SELECT original FROM sign_requests WHERE id = ${requestId}`;
  const [t] = await sql<{ id: string }[]>`
    INSERT INTO sign_templates (name, file_name, original, pages, roles, fields, language, subject, message, sequential, require_code, created_by)
    VALUES (${n}, ${g.request.file_name}, ${orig.original}, ${sql.json(g.request.pages as never)}, ${sql.json(roles as never)}, ${sql.json(fields as never)},
            ${g.request.language}, ${g.request.subject}, ${g.request.message}, ${g.request.sequential}, ${g.request.require_code}, ${actor.id})
    RETURNING id`;
  return t.id;
}

export async function archiveTemplate(id: string) {
  await sql`UPDATE sign_templates SET archived_at = now() WHERE id = ${id}`;
}

/** Documento nuevo a partir de una plantilla: «Tu empresa» eres tú; los clientes, los contactos del deal por orden. */
export async function createFromTemplate(actor: Actor, templateId: string, dealId: string | null) {
  if (!actor.id || !isId(templateId)) throw new UserError("Plantilla no válida.");
  const [t] = await sql<(SignTemplate & { original: Buffer; subject: string | null; message: string | null })[]>`
    SELECT * FROM sign_templates WHERE id = ${templateId} AND archived_at IS NULL`;
  if (!t) throw new UserError("Esa plantilla ya no existe.");
  const [me] = await sql<{ name: string; email: string | null }[]>`SELECT name, email FROM users WHERE id = ${actor.id}`;
  const [deal] = dealId && isId(dealId) ? await sql<{ id: string; title: string }[]>`SELECT id, title FROM deals WHERE id = ${dealId} AND deleted_at IS NULL` : [];
  const contacts = deal ? await sql<{ id: string; full_name: string; email: string | null }[]>`
    SELECT p.id, p.full_name, (SELECT e.email FROM person_emails e WHERE e.person_id = p.id ORDER BY e.is_primary DESC LIMIT 1) AS email
    FROM deal_participants dp JOIN persons p ON p.id = dp.person_id WHERE dp.deal_id = ${deal.id} ORDER BY dp.is_primary DESC, dp.created_at` : [];
  const withEmail = contacts.filter((c) => c.email);
  return transaction(async (tx) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO sign_requests (deal_id, title, file_name, original, original_sha256, pages, language, subject, message, sequential, require_code, sender_id, created_by)
      VALUES (${deal?.id ?? null}, ${deal ? `${t.name} · ${deal.title}`.slice(0, 200) : t.name}, ${t.file_name}, ${t.original}, ${sha256(new Uint8Array(t.original))},
              ${tx.json(t.pages as never)}, ${t.language}, ${t.subject}, ${t.message}, ${t.sequential}, ${t.require_code}, ${actor.id}, ${actor.id})
      RETURNING id`;
    let ext = 0, usedMe = false, pos = 1;
    const roleSigner = new Map<number, string>();
    for (const [i, role] of t.roles.entries()) {
      let who: { name: string; email: string; user_id?: string | null; person_id?: string | null } | null = null;
      if (role.kind === "internal" && !usedMe && me?.email) { who = { name: me.name, email: me.email, user_id: actor.id }; usedMe = true; }
      else if (role.kind === "external" && withEmail[ext]) { const c = withEmail[ext++]; who = { name: c.full_name, email: c.email!.toLowerCase(), person_id: c.id }; }
      if (!who) continue;   // papel sin persona: se añade a mano en el editor
      const [s] = await tx<{ id: string }[]>`
        INSERT INTO sign_signers (request_id, position, name, email, kind, user_id, person_id, color, token)
        VALUES (${r.id}, ${pos}, ${who.name}, ${who.email}, ${role.kind}, ${who.user_id ?? null}, ${who.person_id ?? null}, ${pos}, ${randomBytes(24).toString("base64url")})
        RETURNING id`;
      roleSigner.set(i, s.id);
      pos++;
    }
    for (const f of t.fields) {
      const sid = roleSigner.get(f.role);
      if (!sid) continue;
      await tx`INSERT INTO sign_fields (request_id, signer_id, type, page, x, y, w, h, required, hint)
               VALUES (${r.id}, ${sid}, ${f.type}, ${f.page}, ${f.x}, ${f.y}, ${f.w}, ${f.h}, ${f.required}, ${f.hint})`;
    }
    await tx`INSERT INTO sign_events (request_id, kind, detail) VALUES (${r.id}, 'created', ${`desde la plantilla «${t.name}»`})`;
    const missing = t.roles.filter((_, i) => !roleSigner.has(i)).map((x) => x.label);
    return { id: r.id, missing };
  });
}
