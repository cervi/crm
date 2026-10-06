import { randomBytes } from "node:crypto";
import { sql } from "./db";
import { UserError } from "./errors";
import { recordEvent, INTEGRATION_ACTOR, type Actor } from "./events";
import { generate, parseJsonReply } from "./ai";
import { publicBase } from "./email-track";
import { dealLines } from "./products";
import { BILLING_LABELS } from "./products";

// ===========================================================================
// Propuestas: una página con el texto (redactado por la IA con lo que sabemos
// del deal) y los productos, que el cliente abre y acepta. Sabemos cuándo la
// abre y cuántas veces.
// ===========================================================================

export type ProposalLine = { name: string; billing: string; quantity: number; unit_price: number; discount_pct: number; subtotal: number };
export type Proposal = {
  id: string; deal_id: string; token: string; title: string; intro: string; lines: ProposalLine[]; total: string; currency: string;
  valid_until: string | null; status: "draft" | "sent" | "accepted" | "declined"; view_count: number; first_viewed_at: Date | null;
  last_viewed_at: Date | null; decided_at: Date | null; decided_name: string | null; decision_note: string | null; ai: boolean; created_at: Date;
};

const cols = sql`id, deal_id, token, title, intro, lines, total::text, currency, valid_until::text, status, view_count, first_viewed_at,
                 last_viewed_at, decided_at, decided_name, decision_note, ai, created_at`;

export const listProposals = (dealId: string) => sql<Proposal[]>`SELECT ${cols} FROM proposals WHERE deal_id = ${dealId} ORDER BY created_at DESC`;
export const proposalUrl = (p: { token: string }) => `${publicBase() ?? ""}/p/${p.token}`;

export async function proposalByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(token)) return null;
  const [p] = await sql<(Proposal & { deal_title: string; organization: string | null; owner: string | null; owner_email: string | null })[]>`
    SELECT ${sql.unsafe("p.id, p.deal_id, p.token, p.title, p.intro, p.lines, p.total::text, p.currency, p.valid_until::text, p.status, p.view_count, p.first_viewed_at, p.last_viewed_at, p.decided_at, p.decided_name, p.decision_note, p.ai, p.created_at")},
           d.title AS deal_title, o.name AS organization, u.name AS owner, u.email AS owner_email
    FROM proposals p JOIN deals d ON d.id = p.deal_id LEFT JOIN organizations o ON o.id = d.organization_id LEFT JOIN users u ON u.id = d.owner_id
    WHERE p.token = ${token}`;
  return p ?? null;
}

/** Crea una propuesta con los productos del deal y un texto de la IA (o una plantilla si no hay IA). */
export async function createProposal(actor: Actor, dealId: string): Promise<string> {
  const [d] = await sql<{ title: string; organization: string | null; person: string | null; owner: string | null; currency: string; stage: string }[]>`
    SELECT d.title, o.name AS organization, d.currency, s.name AS stage, u.name AS owner,
           (SELECT p.full_name FROM deal_participants dp JOIN persons p ON p.id = dp.person_id WHERE dp.deal_id = d.id ORDER BY dp.is_primary DESC LIMIT 1) AS person
    FROM deals d JOIN stages s ON s.id = d.stage_id LEFT JOIN organizations o ON o.id = d.organization_id LEFT JOIN users u ON u.id = d.owner_id
    WHERE d.id = ${dealId} AND d.deleted_at IS NULL`;
  if (!d) throw new UserError("El deal no existe.");
  const raw = await dealLines(dealId);
  if (raw.length === 0) throw new UserError("Añade antes los productos del deal: la propuesta se hace con ellos.");
  const lines: ProposalLine[] = raw.map((l) => ({
    name: l.name, billing: BILLING_LABELS[l.billing], quantity: Number(l.quantity), unit_price: Number(l.unit_price),
    discount_pct: Number(l.discount_pct), subtotal: Math.round(l.subtotal * 100) / 100,
  }));
  const total = Math.round(lines.reduce((n, l) => n + l.subtotal, 0) * 100) / 100;
  const notes = await sql<{ content: string }[]>`SELECT content FROM notes WHERE deal_id = ${dealId} ORDER BY created_at DESC LIMIT 8`;
  const ai = await generate("proposal", {
    cliente: d.organization ?? d.person, contacto: d.person, deal: d.title, fase: d.stage, responsable: d.owner,
    productos: lines.map((l) => `${l.name} × ${l.quantity} (${l.billing})`), total,
    notas_del_deal: notes.map((n) => n.content.slice(0, 600)),
  }, { maxTokens: 900 });
  const j = parseJsonReply<{ titulo?: string; texto?: string }>(ai);
  const name = d.person?.split(/\s+/)[0];
  const intro = j?.texto?.trim() || [
    `Hola${name ? ` ${name}` : ""},`,
    "",
    `Gracias por vuestro interés. Esta es nuestra propuesta para ${d.organization ?? "vosotros"}: debajo tienes el detalle de lo que incluye y el importe.`,
    "",
    "Si te encaja, puedes aceptarla desde esta misma página y nos ponemos en marcha. Cualquier duda, responde a mi correo.",
    "",
    `Un saludo,\n${d.owner ?? ""}`,
  ].join("\n");
  const token = randomBytes(18).toString("base64url");
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO proposals (deal_id, token, title, intro, lines, total, currency, valid_until, ai, created_by)
    VALUES (${dealId}, ${token}, ${(j?.titulo?.trim() || `Propuesta para ${d.organization ?? d.title}`).slice(0, 200)}, ${intro.slice(0, 10000)},
            ${sql.json(lines)}, ${total}, ${d.currency}, (now() + interval '30 days')::date, ${Boolean(j?.texto)}, ${actor.id})
    RETURNING id`;
  await recordEvent(sql, actor, "deal", dealId, "proposal.created", { proposal_id: row.id, total });
  return row.id;
}

export async function updateProposal(proposalId: string, data: { title?: unknown; intro?: unknown; valid_until?: unknown }) {
  const title = String(data.title ?? "").trim();
  const intro = String(data.intro ?? "").trim();
  const until = String(data.valid_until ?? "");
  if (!title) throw new UserError("Falta el título.");
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new UserError("Fecha no válida.");
  const res = await sql`UPDATE proposals SET title = ${title.slice(0, 200)}, intro = ${intro.slice(0, 10000)}, valid_until = ${until || null}
                        WHERE id = ${proposalId} AND status IN ('draft', 'sent')`;
  if (res.count === 0) throw new UserError("Una propuesta ya aceptada o rechazada no se puede cambiar.");
}

export async function markSent(proposalId: string) {
  await sql`UPDATE proposals SET status = 'sent' WHERE id = ${proposalId} AND status = 'draft'`;
}

/** Visita del cliente: se cuenta (la primera, también en la historia del deal). */
export async function recordView(token: string) {
  const [p] = await sql<{ id: string; deal_id: string; first: boolean }[]>`
    UPDATE proposals SET view_count = view_count + 1, last_viewed_at = now(), first_viewed_at = coalesce(first_viewed_at, now()),
                         status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END
    WHERE token = ${token} RETURNING id, deal_id, view_count = 1 AS first`;
  if (p?.first) await recordEvent(sql, INTEGRATION_ACTOR, "deal", p.deal_id, "proposal.viewed", { proposal_id: p.id });
}

export async function decide(token: string, accept: boolean, name: string, note: string) {
  const n = name.trim();
  if (!n) throw new UserError("Escribe tu nombre para confirmar.");
  const [p] = await sql<{ id: string; deal_id: string }[]>`
    UPDATE proposals SET status = ${accept ? "accepted" : "declined"}, decided_at = now(), decided_name = ${n.slice(0, 200)},
                         decision_note = ${note.trim().slice(0, 2000) || null}
    WHERE token = ${token} AND status IN ('draft', 'sent') AND (valid_until IS NULL OR valid_until >= current_date)
    RETURNING id, deal_id`;
  if (!p) throw new UserError("Esta propuesta ya no se puede aceptar (caducó o ya se respondió).");
  await recordEvent(sql, INTEGRATION_ACTOR, "deal", p.deal_id, accept ? "proposal.accepted" : "proposal.declined", {
    proposal_id: p.id, name: n, note: note.trim() || null,
  });
}
