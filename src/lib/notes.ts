import { z } from "zod";
import { sql, transaction } from "./db";
import { recordEvent, type Actor, type EntityType } from "./events";
import { UserError } from "./errors";
import { optId, parse, text } from "./validation";

export type Note = {
  id: string;
  content: string;
  author_name: string | null;
  created_at: Date;
  deal_id: string | null;
  deal_title: string | null;
  person_id: string | null;
  person_name: string | null;
};

export async function listNotesFor(ref: { dealId?: string; leadId?: string; personId?: string; organizationId?: string }) {
  return sql<Note[]>`
    SELECT n.id, n.content, u.name AS author_name, n.created_at, n.deal_id, d.title AS deal_title,
           n.person_id, p.full_name AS person_name
    FROM notes n
    LEFT JOIN users u ON u.id = n.author_id
    LEFT JOIN deals d ON d.id = n.deal_id
    LEFT JOIN persons p ON p.id = n.person_id
    WHERE (${ref.dealId ?? null}::uuid IS NULL OR n.deal_id = ${ref.dealId ?? null}::uuid)
      AND (${ref.leadId ?? null}::uuid IS NULL OR n.lead_id = ${ref.leadId ?? null}::uuid)
      AND (${ref.personId ?? null}::uuid IS NULL OR n.person_id = ${ref.personId ?? null}::uuid)
      AND (${ref.organizationId ?? null}::uuid IS NULL OR n.organization_id = ${ref.organizationId ?? null}::uuid
           OR n.deal_id IN (SELECT id FROM deals WHERE organization_id = ${ref.organizationId ?? null}::uuid))
    ORDER BY n.is_pinned DESC, n.created_at DESC
    LIMIT 200`;
}

const noteSchema = z.object({
  content: text("La nota", 20000),
  deal_id: optId,
  lead_id: optId,
  person_id: optId,
  organization_id: optId,
});

export async function createNote(actor: Actor, data: unknown) {
  const v = parse(noteSchema, data);
  const target: [EntityType, string] | null =
    v.deal_id ? ["deal", v.deal_id] : v.lead_id ? ["lead", v.lead_id]
    : v.person_id ? ["person", v.person_id] : v.organization_id ? ["organization", v.organization_id] : null;
  if (!target) throw new UserError("La nota debe estar asociada a algo.");
  await transaction(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO notes (content, deal_id, lead_id, person_id, organization_id, author_id)
      VALUES (${v.content}, ${v.deal_id ?? null}, ${v.lead_id ?? null}, ${v.person_id ?? null},
              ${v.organization_id ?? null}, ${actor.id})
      RETURNING id`;
    await recordEvent(tx, actor, target[0], target[1], "note.created", {
      note_id: row.id, excerpt: v.content.slice(0, 140),
    });
  });
}
