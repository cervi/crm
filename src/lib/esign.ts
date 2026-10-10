import { createHash, randomBytes, randomInt } from "node:crypto";
import { sql, transaction, type Db } from "./db";
import { UserError } from "./errors";
import { INTEGRATION_ACTOR, recordEvent, type Actor } from "./events";
import { publicBase } from "./email-track";
import { connectionOf, sendPlainEmail, type Connection } from "./mailbox";
import { notify } from "./notifications";
import { isId } from "./validation";
import { isSignLang, signDate, st, type SignLang } from "./esign-i18n";
import { appendSignaturePage, inspectPdf, sha256, stampPdf, type PageInfo } from "./esign-pdf";

// ===========================================================================
// Firma electrónica de contratos (como «Smart Docs» de Pipedrive).
//
//   borrador → enviado → completado
//                      ↘ rechazado · caducado · cancelado
//
// Cada firmante tiene su enlace personal (/firma/<token>). Con «firmar en
// orden», solo recibe el enlace cuando ha firmado el anterior. Todo lo que
// pasa queda en sign_events y acaba en el registro de auditoría del PDF.
// ===========================================================================

export const FIELD_TYPES = {
  signature: { label: "Firma", w: 0.26, h: 0.06 },
  initials: { label: "Iniciales", w: 0.09, h: 0.045 },
  name: { label: "Nombre", w: 0.24, h: 0.03 },
  date: { label: "Fecha de firma", w: 0.18, h: 0.03 },
  text: { label: "Texto", w: 0.24, h: 0.03 },
  checkbox: { label: "Casilla", w: 0.025, h: 0.018 },
} as const;
export type FieldType = keyof typeof FIELD_TYPES;
export const isFieldType = (v: unknown): v is FieldType => typeof v === "string" && v in FIELD_TYPES;

export const REQUEST_STATUS = {
  draft: { label: "Borrador", tone: "" }, sent: { label: "Esperando firmas", tone: "warn" }, completed: { label: "Firmado", tone: "won" },
  declined: { label: "Rechazado", tone: "lost" }, expired: { label: "Caducado", tone: "lost" }, cancelled: { label: "Cancelado", tone: "" },
} as const;
export type RequestStatus = keyof typeof REQUEST_STATUS;
export const SIGNER_STATUS = {
  waiting: "Esperando su turno", pending: "Pendiente de firmar", signed: "Firmado", declined: "Rechazado",
} as const;

export const MAX_SIGNERS = 10;
const MAX_FIELDS = 1000;
const CODE_MINUTES = 10;

export type SignRequest = {
  id: string; deal_id: string | null; deal_title: string | null; title: string; file_name: string; original_sha256: string; pages: PageInfo[];
  signed_sha256: string | null; has_signed: boolean; status: RequestStatus; language: SignLang; subject: string | null; message: string | null;
  sequential: boolean; require_code: boolean; reminder_days: number; expires_days: number; expires_at: Date | null;
  sender_id: string | null; sender_name: string | null; sender_email: string | null; created_by: string | null; creator_name: string | null;
  created_at: Date; sent_at: Date | null; completed_at: Date | null; cancelled_at: Date | null;
};
export type Signer = {
  id: string; request_id: string; position: number; name: string; email: string; kind: "internal" | "external"; user_id: string | null;
  person_id: string | null; color: number; token: string; status: keyof typeof SIGNER_STATUS; invited_at: Date | null; last_reminded_at: Date | null;
  first_viewed_at: Date | null; last_viewed_at: Date | null; view_count: number; signed_at: Date | null; declined_at: Date | null;
  decline_reason: string | null; ip: string | null; user_agent: string | null; code_verified_at: Date | null;
};
export type Field = { id: string; signer_id: string; type: FieldType; page: number; x: number; y: number; w: number; h: number; required: boolean; hint: string | null; value: string | null };
export type SignEvent = { id: number; signer_id: string | null; signer_name: string | null; kind: string; detail: string | null; ip: string | null; at: Date };

const REQ_COLS = sql`r.id, r.deal_id, d.title AS deal_title, r.title, r.file_name, r.original_sha256, r.pages, r.signed_sha256, r.signed IS NOT NULL AS has_signed,
  r.status, r.language, r.subject, r.message, r.sequential, r.require_code, r.reminder_days, r.expires_days, r.expires_at,
  r.sender_id, su.name AS sender_name, su.email AS sender_email, r.created_by, cu.name AS creator_name, r.created_at, r.sent_at, r.completed_at, r.cancelled_at`;
const REQ_FROM = sql`sign_requests r LEFT JOIN deals d ON d.id = r.deal_id LEFT JOIN users su ON su.id = r.sender_id LEFT JOIN users cu ON cu.id = r.created_by`;

export async function getRequest(id: string) {
  if (!isId(id)) return null;
  const [r] = await sql<SignRequest[]>`SELECT ${REQ_COLS} FROM ${REQ_FROM} WHERE r.id = ${id}`;
  if (!r) return null;
  const [signers, fields, events] = await Promise.all([
    sql<Signer[]>`SELECT * FROM sign_signers WHERE request_id = ${id} ORDER BY position, name`,
    sql<Field[]>`SELECT id, signer_id, type, page, x, y, w, h, required, hint, value FROM sign_fields WHERE request_id = ${id} ORDER BY page, y, x`,
    sql<SignEvent[]>`SELECT e.id, e.signer_id, s.name AS signer_name, e.kind, e.detail, e.ip, e.at FROM sign_events e
                     LEFT JOIN sign_signers s ON s.id = e.signer_id WHERE e.request_id = ${id} ORDER BY e.at, e.id`,
  ]);
  return { request: r, signers, fields, events };
}

export type RequestListRow = SignRequest & { signers: { name: string; status: string; signed_at: Date | null; first_viewed_at: Date | null }[] };

export async function listRequests(opts: { dealId?: string | null; status?: string | null; ownerId?: string | null } = {}): Promise<RequestListRow[]> {
  const rows = await sql<SignRequest[]>`
    SELECT ${REQ_COLS} FROM ${REQ_FROM}
    WHERE (${opts.dealId ?? null}::uuid IS NULL OR r.deal_id = ${opts.dealId ?? null}::uuid)
      AND (${opts.status ?? null}::text IS NULL OR r.status = ${opts.status ?? null})
      AND (${opts.ownerId ?? null}::uuid IS NULL OR r.created_by = ${opts.ownerId ?? null}::uuid OR r.sender_id = ${opts.ownerId ?? null}::uuid)
    ORDER BY coalesce(r.sent_at, r.created_at) DESC LIMIT 300`;
  if (!rows.length) return [];
  const signers = await sql<{ request_id: string; name: string; status: string; signed_at: Date | null; first_viewed_at: Date | null }[]>`
    SELECT request_id, name, status, signed_at, first_viewed_at FROM sign_signers WHERE request_id = ANY(${rows.map((r) => r.id)}::uuid[]) ORDER BY position`;
  return rows.map((r) => ({ ...r, signers: signers.filter((s) => s.request_id === r.id) }));
}

async function log(db: Db, requestId: string, kind: string, o: { signerId?: string | null; detail?: string | null; ip?: string | null; ua?: string | null } = {}) {
  await db`INSERT INTO sign_events (request_id, signer_id, kind, detail, ip, user_agent)
           VALUES (${requestId}, ${o.signerId ?? null}, ${kind}, ${o.detail?.slice(0, 500) ?? null}, ${o.ip ?? null}, ${o.ua?.slice(0, 300) ?? null})`;
}

const token = () => randomBytes(24).toString("base64url");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Borrador

export async function createRequest(actor: Actor, v: { dealId: string | null; title?: string | null; fileName: string; bytes: Uint8Array }) {
  if (!actor.id) throw new UserError("Inicia sesión para continuar.");
  const pages = await inspectPdf(v.bytes);
  const [me] = await sql<{ name: string; email: string | null }[]>`SELECT name, email FROM users WHERE id = ${actor.id}`;
  const [deal] = v.dealId && isId(v.dealId) ? await sql<{ id: string; title: string; owner_id: string | null }[]>`SELECT id, title, owner_id FROM deals WHERE id = ${v.dealId} AND deleted_at IS NULL` : [];
  const title = (v.title?.trim() || v.fileName.replace(/\.pdf$/i, "")).slice(0, 200) || "Contrato";
  return transaction(async (tx) => {
    const [r] = await tx<{ id: string }[]>`
      INSERT INTO sign_requests (deal_id, title, file_name, original, original_sha256, pages, sender_id, created_by)
      VALUES (${deal?.id ?? null}, ${title}, ${v.fileName.slice(0, 255)}, ${Buffer.from(v.bytes)}, ${sha256(v.bytes)},
              ${tx.json(pages as never)}, ${actor.id}, ${actor.id}) RETURNING id`;
    // Firmantes de partida (como Pipedrive): tú y el contacto principal del deal.
    let pos = 1;
    if (me?.email) {
      await tx`INSERT INTO sign_signers (request_id, position, name, email, kind, user_id, color, token)
               VALUES (${r.id}, ${pos}, ${me.name}, ${me.email}, 'internal', ${actor.id}, ${pos}, ${token()})`;
      pos++;
    }
    if (deal) {
      const [p] = await tx<{ id: string; full_name: string; email: string | null }[]>`
        SELECT p.id, p.full_name, (SELECT e.email FROM person_emails e WHERE e.person_id = p.id ORDER BY e.is_primary DESC LIMIT 1) AS email
        FROM deal_participants dp JOIN persons p ON p.id = dp.person_id WHERE dp.deal_id = ${deal.id} ORDER BY dp.is_primary DESC, dp.created_at LIMIT 1`;
      if (p?.email) {
        await tx`INSERT INTO sign_signers (request_id, position, name, email, kind, person_id, color, token)
                 VALUES (${r.id}, ${pos}, ${p.full_name}, ${p.email.toLowerCase()}, 'external', ${p.id}, ${pos}, ${token()})`;
      }
    }
    await log(tx, r.id, "created", { detail: me?.name ?? null });
    return r.id;
  });
}

async function draftOnly(id: string) {
  const [r] = await sql<{ status: string }[]>`SELECT status FROM sign_requests WHERE id = ${id}`;
  if (!r) throw new UserError("Ese documento ya no existe.");
  if (r.status !== "draft") throw new UserError("El documento ya se ha enviado: no se puede cambiar.");
}

export async function saveSettings(id: string, data: Record<string, unknown>) {
  await draftOnly(id);
  const title = String(data.title ?? "").trim().slice(0, 200);
  if (!title) throw new UserError("Ponle un título al documento.");
  const language = isSignLang(data.language) ? data.language : "es";
  const num = (v: unknown, min: number, max: number, def: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : def;
  };
  const senderId = isId(data.sender_id) ? data.sender_id : null;
  await sql`UPDATE sign_requests SET title = ${title}, language = ${language},
              subject = ${String(data.subject ?? "").trim().slice(0, 300) || null},
              message = ${String(data.message ?? "").trim().slice(0, 4000) || null},
              sequential = ${data.sequential === true || data.sequential === "on"},
              require_code = ${data.require_code === true || data.require_code === "on"},
              reminder_days = ${num(data.reminder_days, 0, 30, 3)}, expires_days = ${num(data.expires_days, 1, 365, 60)},
              sender_id = coalesce(${senderId}::uuid, sender_id)
            WHERE id = ${id}`;
}

export type SignerInput = { id?: string | null; name: string; email: string; kind: "internal" | "external"; user_id?: string | null; person_id?: string | null };

export async function saveSigners(id: string, list: SignerInput[]) {
  await draftOnly(id);
  if (list.length > MAX_SIGNERS) throw new UserError(`Como mucho ${MAX_SIGNERS} firmantes por documento.`);
  const clean = list.map((s, i) => {
    const name = String(s.name ?? "").trim().slice(0, 200), email = String(s.email ?? "").trim().toLowerCase();
    if (!name) throw new UserError(`Falta el nombre del firmante ${i + 1}.`);
    if (!EMAIL_RE.test(email)) throw new UserError(`El correo de ${name} no es válido.`);
    return { ...s, name, email, kind: s.kind === "internal" ? "internal" as const : "external" as const };
  });
  const emails = clean.map((s) => s.email);
  if (new Set(emails).size !== emails.length) throw new UserError("Hay un firmante repetido (mismo correo).");
  await transaction(async (tx) => {
    const existing = await tx<{ id: string }[]>`SELECT id FROM sign_signers WHERE request_id = ${id}`;
    const keep = new Set(clean.map((s) => s.id).filter((x): x is string => Boolean(x && existing.some((e) => e.id === x))));
    const drop = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
    if (drop.length) await tx`DELETE FROM sign_signers WHERE id = ANY(${drop}::uuid[])`;
    let pos = 1;
    for (const s of clean) {
      const uid = isId(s.user_id) ? s.user_id : null, pid = isId(s.person_id) ? s.person_id : null;
      if (s.id && keep.has(s.id)) {
        await tx`UPDATE sign_signers SET position = ${pos}, name = ${s.name}, email = ${s.email}, kind = ${s.kind}, user_id = ${uid}, person_id = ${pid}
                 WHERE id = ${s.id}`;
      } else {
        await tx`INSERT INTO sign_signers (request_id, position, name, email, kind, user_id, person_id, color, token)
                 VALUES (${id}, ${pos}, ${s.name}, ${s.email}, ${s.kind}, ${uid}, ${pid},
                         ${1 + ((await tx<{ n: number }[]>`SELECT coalesce(max(color), 0)::int AS n FROM sign_signers WHERE request_id = ${id}`)[0].n % 8)}, ${token()})`;
      }
      pos++;
    }
  });
}

export type FieldInput = { signer_id: string; type: string; page: number; x: number; y: number; w: number; h: number; required?: boolean; hint?: string | null };

export async function saveFields(id: string, list: FieldInput[]) {
  await draftOnly(id);
  if (list.length > MAX_FIELDS) throw new UserError(`Como mucho ${MAX_FIELDS} campos por documento.`);
  const [r] = await sql<{ pages: PageInfo[] }[]>`SELECT pages FROM sign_requests WHERE id = ${id}`;
  const signers = new Set((await sql<{ id: string }[]>`SELECT id FROM sign_signers WHERE request_id = ${id}`).map((s) => s.id));
  const clamp = (n: number) => Math.min(1, Math.max(0, Number(n) || 0));
  const rows = list.map((f) => {
    if (!signers.has(f.signer_id)) throw new UserError("Hay un campo de un firmante que ya no está.");
    if (!isFieldType(f.type)) throw new UserError("Tipo de campo no válido.");
    const page = Math.trunc(Number(f.page));
    if (!(page >= 1 && page <= r.pages.length)) throw new UserError("Hay un campo fuera del documento.");
    const w = Math.max(0.01, clamp(f.w)), h = Math.max(0.008, clamp(f.h));
    return {
      request_id: id, signer_id: f.signer_id, type: f.type, page, x: Math.min(clamp(f.x), 1 - w), y: Math.min(clamp(f.y), 1 - h), w, h,
      required: f.type === "signature" ? true : f.required !== false, hint: f.hint ? String(f.hint).slice(0, 120) : null,
    };
  });
  await transaction(async (tx) => {
    await tx`DELETE FROM sign_fields WHERE request_id = ${id}`;
    for (let i = 0; i < rows.length; i += 200) await tx`INSERT INTO sign_fields ${tx(rows.slice(i, i + 200))}`;
  });
}

// ---------------------------------------------------------------------------
// Correos

const company = (email: string | null | undefined) => process.env.COMPANY_NAME?.trim() || (email?.split("@")[1] ?? "");

async function senderConn(r: Pick<SignRequest, "sender_id" | "created_by">): Promise<Connection> {
  for (const uid of [r.sender_id, r.created_by]) {
    if (!uid) continue;
    const c = await connectionOf(uid);
    if (c && c.status === "active") return c;
  }
  throw new UserError("Para enviar a firmar, conecta tu correo en Ajustes → Correo, calendario y documentos (los correos salen desde tu cuenta).");
}

function signLink(t: string) {
  const base = publicBase();
  if (!base) throw new UserError("Falta configurar la dirección pública del CRM (APP_URL): sin ella los firmantes no pueden abrir el enlace.");
  return `${base}/firma/${t}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function mailHtml(text: string, cta?: { label: string; url: string }, foot?: string) {
  const paras = text.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#16202e;max-width:560px">${paras}`
    + (cta ? `<p style="margin:22px 0"><a href="${esc(cta.url)}" style="background:#1f5fd6;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">${esc(cta.label)}</a></p>` : "")
    + (foot ? `<p style="margin:22px 0 0;color:#687587;font-size:12.5px">${esc(foot)}</p>` : "") + "</div>";
}

async function emailSigner(r: SignRequest, s: Signer, kind: "invite" | "reminder") {
  const conn = await senderConn(r);
  const lang = r.language;
  const url = signLink(s.token);
  const vars = { name: s.name.split(" ")[0], sender: conn.user_name ?? conn.email, company: company(conn.email), title: r.title };
  const subject = kind === "invite" ? (r.subject?.trim() ? r.subject : st(lang, "inviteSubject", vars)) : st(lang, "reminderSubject", vars);
  const intro = kind === "invite" ? st(lang, "inviteIntro", vars) : st(lang, "reminderIntro", vars);
  const msg = kind === "invite" ? (r.message?.trim() || st(lang, "defaultMessage")) : "";
  const expires = r.expires_at ? st(lang, "expires", { date: signDate(lang, r.expires_at) }) : "";
  const text = [intro, msg, `${st(lang, "cta")}: ${url}`, expires].filter(Boolean).join("\n\n") + `\n\n— ${vars.sender}\n\n${st(lang, "footer")}`;
  const html = mailHtml([intro, msg].filter(Boolean).join("\n\n"), { label: st(lang, "cta"), url }, [expires, `— ${vars.sender}`, st(lang, "footer")].filter(Boolean).join(" · "));
  await sendPlainEmail(conn, s.email, subject, text, html, { toName: s.name });
}

// ---------------------------------------------------------------------------
// Envío y seguimiento (desde el CRM)

export async function sendRequest(actor: Actor, id: string) {
  const g = await getRequest(id);
  if (!g) throw new UserError("Ese documento ya no existe.");
  const { request: r } = g;
  if (r.status !== "draft") throw new UserError("Este documento ya se ha enviado.");
  if (g.signers.length === 0) throw new UserError("Añade al menos un firmante.");
  await senderConn(r);
  signLink("x");
  // Quien no tenga campo de firma firma en una página que se añade al final (como «Enviar igualmente» en Pipedrive).
  const without = g.signers.filter((s) => !g.fields.some((f) => f.signer_id === s.id && f.type === "signature"));
  if (without.length) {
    const [orig] = await sql<{ original: Buffer }[]>`SELECT original FROM sign_requests WHERE id = ${id}`;
    const extra = await appendSignaturePage(new Uint8Array(orig.original), r.language, without.map((s) => ({ id: s.id, name: s.name })));
    await transaction(async (tx) => {
      await tx`UPDATE sign_requests SET original = ${Buffer.from(extra.bytes)}, original_sha256 = ${sha256(extra.bytes)}, pages = ${tx.json(extra.pages as never)} WHERE id = ${id}`;
      for (const f of extra.fields) {
        await tx`INSERT INTO sign_fields (request_id, signer_id, type, page, x, y, w, h, required)
                 VALUES (${id}, ${f.signerId}, ${f.type}, ${extra.page}, ${f.x}, ${f.y}, ${f.w}, ${f.h}, true)`;
      }
    });
  }
  const first = Math.min(...g.signers.map((s) => s.position));
  await transaction(async (tx) => {
    await tx`UPDATE sign_requests SET status = 'sent', sent_at = now(), expires_at = now() + make_interval(days => expires_days) WHERE id = ${id}`;
    await tx`UPDATE sign_signers SET status = CASE WHEN ${r.sequential} AND position > ${first} THEN 'waiting' ELSE 'pending' END WHERE request_id = ${id}`;
    await log(tx, id, "sent", { detail: `${g.signers.length} firmante${g.signers.length === 1 ? "" : "s"}${r.sequential ? ", en orden" : ""}` });
    if (r.deal_id) await recordEvent(tx, actor, "deal", r.deal_id, "sign.sent", { request_id: id, title: r.title, signers: g.signers.map((s) => s.name) });
  });
  await inviteDue(id);
}

/** Envía la invitación a quien le toque y aún no la tenga. */
async function inviteDue(id: string) {
  const g = await getRequest(id);
  if (!g || g.request.status !== "sent") return;
  for (const s of g.signers.filter((x) => x.status === "pending" && !x.invited_at)) {
    try {
      await emailSigner(g.request, s, "invite");
      await sql`UPDATE sign_signers SET invited_at = now() WHERE id = ${s.id}`;
      await log(sql, id, "invited", { signerId: s.id, detail: s.email });
    } catch (err) {
      await log(sql, id, "error", { signerId: s.id, detail: `No se pudo enviar la invitación: ${err instanceof Error ? err.message : "error"}` });
      throw err;
    }
  }
}

export async function remind(actor: Actor, id: string, signerId?: string | null) {
  const g = await getRequest(id);
  if (!g) throw new UserError("Ese documento ya no existe.");
  if (g.request.status !== "sent") throw new UserError("Solo se puede recordar mientras se espera la firma.");
  const targets = g.signers.filter((s) => s.status === "pending" && (!signerId || s.id === signerId));
  if (!targets.length) throw new UserError("No hay nadie pendiente de firmar ahora mismo.");
  for (const s of targets) {
    await emailSigner(g.request, s, s.invited_at ? "reminder" : "invite");
    await sql`UPDATE sign_signers SET last_reminded_at = now(), invited_at = coalesce(invited_at, now()) WHERE id = ${s.id}`;
    await log(sql, id, "reminded", { signerId: s.id, detail: actor.id ? "a mano" : "automático" });
  }
  return targets.length;
}

export async function cancelRequest(actor: Actor, id: string) {
  const [r] = await sql<{ status: string; deal_id: string | null; title: string }[]>`SELECT status, deal_id, title FROM sign_requests WHERE id = ${id}`;
  if (!r) throw new UserError("Ese documento ya no existe.");
  if (r.status !== "sent" && r.status !== "draft") throw new UserError("Este documento ya no está en curso.");
  await transaction(async (tx) => {
    await tx`UPDATE sign_requests SET status = 'cancelled', cancelled_at = now() WHERE id = ${id}`;
    await log(tx, id, "cancelled");
    if (r.deal_id && r.status === "sent") await recordEvent(tx, actor, "deal", r.deal_id, "sign.cancelled", { request_id: id, title: r.title });
  });
}

export async function deleteDraft(id: string) {
  const [r] = await sql<{ status: string }[]>`SELECT status FROM sign_requests WHERE id = ${id}`;
  if (!r) return;
  if (r.status !== "draft" && r.status !== "cancelled") throw new UserError("Solo se pueden borrar borradores o documentos cancelados.");
  await sql`DELETE FROM sign_requests WHERE id = ${id}`;
}

/** Nueva versión (p. ej. tras un rechazo o si caducó): copia documento, firmantes y campos en un borrador. */
export async function duplicateRequest(actor: Actor, id: string) {
  const g = await getRequest(id);
  if (!g) throw new UserError("Ese documento ya no existe.");
  return transaction(async (tx) => {
    const [n] = await tx<{ id: string }[]>`
      INSERT INTO sign_requests (deal_id, title, file_name, original, original_sha256, pages, language, subject, message, sequential,
                                 require_code, reminder_days, expires_days, sender_id, created_by)
      SELECT deal_id, title, file_name, original, original_sha256, pages, language, subject, message, sequential,
             require_code, reminder_days, expires_days, sender_id, ${actor.id} FROM sign_requests WHERE id = ${id} RETURNING id`;
    const map = new Map<string, string>();
    for (const s of g.signers) {
      const [ns] = await tx<{ id: string }[]>`
        INSERT INTO sign_signers (request_id, position, name, email, kind, user_id, person_id, color, token)
        VALUES (${n.id}, ${s.position}, ${s.name}, ${s.email}, ${s.kind}, ${s.user_id}, ${s.person_id}, ${s.color}, ${token()}) RETURNING id`;
      map.set(s.id, ns.id);
    }
    for (const f of g.fields) {
      await tx`INSERT INTO sign_fields (request_id, signer_id, type, page, x, y, w, h, required, hint)
               VALUES (${n.id}, ${map.get(f.signer_id)!}, ${f.type}, ${f.page}, ${f.x}, ${f.y}, ${f.w}, ${f.h}, ${f.required}, ${f.hint})`;
    }
    await log(tx, n.id, "created", { detail: `nueva versión de un documento anterior` });
    return n.id;
  });
}

export async function requestPdf(id: string, which: "original" | "signed") {
  const [r] = await sql<{ title: string; original: Buffer; signed: Buffer | null }[]>`SELECT title, original, signed FROM sign_requests WHERE id = ${id}`;
  if (!r) return null;
  const data = which === "signed" ? r.signed : r.original;
  return data ? { name: `${r.title}${which === "signed" ? " (firmado)" : ""}.pdf`, data } : null;
}

// ---------------------------------------------------------------------------
// Lado del firmante (página pública /firma/<token>)

export type SignerView = {
  request: Pick<SignRequest, "id" | "title" | "status" | "language" | "sequential" | "require_code" | "pages" | "expires_at" | "has_signed">;
  me: Pick<Signer, "id" | "name" | "email" | "status" | "color" | "signed_at" | "code_verified_at">;
  signers: { id: string; name: string; status: string; color: number; position: number }[];
  fields: (Omit<Field, "value"> & { value: string | null; mine: boolean })[];
  senderEmail: string | null; senderName: string | null;
  state: "sign" | "waiting" | "signed" | "declined" | "expired" | "cancelled" | "stopped" | "completed";
  waitingFor: string | null;
};

async function bySignerToken(t: string) {
  if (typeof t !== "string" || t.length < 20 || t.length > 64) return null;
  const [s] = await sql<Signer[]>`SELECT * FROM sign_signers WHERE token = ${t}`;
  if (!s) return null;
  const g = await getRequest(s.request_id);
  return g ? { ...g, me: s } : null;
}

/** Caduca al vuelo si ya ha pasado la fecha. */
async function expireIfDue(r: SignRequest) {
  if (r.status === "sent" && r.expires_at && new Date(r.expires_at) < new Date()) {
    await sql`UPDATE sign_requests SET status = 'expired' WHERE id = ${r.id} AND status = 'sent'`;
    await log(sql, r.id, "expired");
    r.status = "expired";
  }
}

export async function signerView(t: string): Promise<SignerView | null> {
  const g = await bySignerToken(t);
  if (!g) return null;
  const { request: r, me } = g;
  await expireIfDue(r);
  const prev = g.signers.filter((s) => s.position < me.position && s.status !== "signed");
  const state: SignerView["state"] =
    r.status === "completed" ? "completed" : r.status === "expired" ? "expired" : r.status === "cancelled" ? "cancelled"
    : me.status === "declined" ? "declined" : r.status === "declined" ? "stopped" : me.status === "signed" ? "signed"
    : me.status === "waiting" ? "waiting" : "sign";
  return {
    request: { id: r.id, title: r.title, status: r.status, language: r.language, sequential: r.sequential, require_code: r.require_code, pages: r.pages, expires_at: r.expires_at, has_signed: r.has_signed },
    me: { id: me.id, name: me.name, email: me.email, status: me.status, color: me.color, signed_at: me.signed_at, code_verified_at: me.code_verified_at },
    signers: g.signers.map((s) => ({ id: s.id, name: s.name, status: s.status, color: s.color, position: s.position })),
    // Los valores de los demás solo se ven cuando ya han firmado.
    fields: g.fields.map((f) => ({ ...f, mine: f.signer_id === me.id,
      value: f.signer_id === me.id || g.signers.find((s) => s.id === f.signer_id)?.status === "signed" ? f.value : null })),
    senderEmail: r.sender_email, senderName: r.sender_name,
    state, waitingFor: prev[0]?.name ?? null,
  };
}

export async function signerPdf(t: string, which: "original" | "signed") {
  const g = await bySignerToken(t);
  if (!g) return null;
  if (which === "signed" && g.request.status !== "completed") return null;
  return requestPdf(g.request.id, which);
}

export async function recordView(t: string, ip: string | null, ua: string | null) {
  const g = await bySignerToken(t);
  if (!g || g.request.status !== "sent" || g.me.status !== "pending") return;
  const first = !g.me.first_viewed_at;
  await sql`UPDATE sign_signers SET view_count = view_count + 1, first_viewed_at = coalesce(first_viewed_at, now()), last_viewed_at = now()
            WHERE id = ${g.me.id}`;
  // Una vista por hora como mucho en el registro (recargar la página no llena la historia).
  const [recent] = await sql`SELECT 1 FROM sign_events WHERE request_id = ${g.request.id} AND signer_id = ${g.me.id} AND kind = 'viewed' AND at > now() - interval '1 hour'`;
  if (!recent) await log(sql, g.request.id, "viewed", { signerId: g.me.id, ip, ua });
  if (first) {
    const owner = g.request.sender_id ?? g.request.created_by;
    if (owner) await notify(sql, { userId: owner, kind: "sign.viewed", title: `${g.me.name} ha abierto «${g.request.title}»`, body: "Aún no ha firmado.", link: `/firmas/${g.request.id}` });
  }
}

const hashCode = (signerId: string, code: string) => createHash("sha256").update(`${signerId}:${code}`).digest("hex");

export async function sendCode(t: string, ip: string | null) {
  const g = await bySignerToken(t);
  if (!g || g.request.status !== "sent" || g.me.status !== "pending") throw new UserError("Este enlace ya no está activo.");
  const [recent] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sign_events WHERE signer_id = ${g.me.id} AND kind = 'code_sent' AND at > now() - interval '1 hour'`;
  if (recent.n >= 5) throw new UserError("Has pedido demasiados códigos. Espera un rato.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await sql`UPDATE sign_signers SET code_hash = ${hashCode(g.me.id, code)}, code_expires_at = now() + make_interval(mins => ${CODE_MINUTES}), code_attempts = 0
            WHERE id = ${g.me.id}`;
  const conn = await senderConn(g.request);
  const lang = g.request.language;
  await sendPlainEmail(conn, g.me.email, st(lang, "codeSubject", { title: g.request.title }), st(lang, "codeBody", { title: g.request.title, code }), null, { toName: g.me.name });
  await log(sql, g.request.id, "code_sent", { signerId: g.me.id, ip, detail: g.me.email });
}

export async function submitSignature(t: string, v: { values: Record<string, string>; code?: string | null; consent: boolean }, ip: string | null, ua: string | null) {
  const g = await bySignerToken(t);
  if (!g) throw new UserError("Este enlace no es válido.");
  const { request: r, me } = g;
  await expireIfDue(r);
  const lang = r.language;
  if (r.status !== "sent" || me.status !== "pending") throw new UserError(st(lang, "cancelled"));
  if (!v.consent) throw new UserError(st(lang, "errorFields"));
  if (r.require_code) {
    const code = String(v.code ?? "").trim();
    const [c] = await sql<{ code_hash: string | null; code_expires_at: Date | null; code_attempts: number }[]>`SELECT code_hash, code_expires_at, code_attempts FROM sign_signers WHERE id = ${me.id}`;
    if (!c?.code_hash || !c.code_expires_at || new Date(c.code_expires_at) < new Date() || c.code_attempts >= 5 || hashCode(me.id, code) !== c.code_hash) {
      await sql`UPDATE sign_signers SET code_attempts = code_attempts + 1 WHERE id = ${me.id}`;
      throw new UserError(st(lang, "badCode"));
    }
  }
  const mine = g.fields.filter((f) => f.signer_id === me.id);
  const now = new Date();
  const updates: { id: string; value: string | null }[] = [];
  for (const f of mine) {
    let val: string | null = v.values[f.id] ?? null;
    if (f.type === "date") val = signDate(lang, now);
    else if (f.type === "signature" || f.type === "initials") {
      if (val && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(val) || val.length > 400_000)) throw new UserError(st(lang, "errorFields"));
    } else if (f.type === "checkbox") val = val === "true" ? "true" : f.required ? null : "false";
    else val = val ? val.trim().slice(0, 500) || null : f.type === "name" ? me.name : null;
    if (f.required && !val) throw new UserError(st(lang, "errorFields"));
    updates.push({ id: f.id, value: val });
  }
  let allSigned = false;
  await transaction(async (tx) => {
    for (const u of updates) await tx`UPDATE sign_fields SET value = ${u.value} WHERE id = ${u.id}`;
    const [ok] = await tx<{ id: string }[]>`
      UPDATE sign_signers SET status = 'signed', signed_at = now(), ip = ${ip}, user_agent = ${ua?.slice(0, 300) ?? null},
             code_verified_at = CASE WHEN ${r.require_code} THEN now() ELSE code_verified_at END, code_hash = NULL
      WHERE id = ${me.id} AND status = 'pending' RETURNING id`;
    if (!ok) throw new UserError(st(lang, "cancelled"));
    if (r.require_code) await log(tx, r.id, "code_verified", { signerId: me.id, ip, ua });
    await log(tx, r.id, "signed", { signerId: me.id, ip, ua });
    // Firmar en orden: pasa el turno al siguiente.
    if (r.sequential) {
      const [next] = await tx<{ position: number }[]>`SELECT min(position) AS position FROM sign_signers WHERE request_id = ${r.id} AND status = 'waiting'`;
      if (next?.position) await tx`UPDATE sign_signers SET status = 'pending' WHERE request_id = ${r.id} AND status = 'waiting' AND position = ${next.position}`;
    }
    const [left] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM sign_signers WHERE request_id = ${r.id} AND status <> 'signed'`;
    allSigned = left.n === 0;
    if (r.deal_id) await recordEvent(tx, INTEGRATION_ACTOR, "deal", r.deal_id, "sign.signed", { request_id: r.id, title: r.title, name: me.name });
  });
  const owner = r.sender_id ?? r.created_by;
  const pending = g.signers.filter((s) => s.id !== me.id && s.status !== "signed").map((s) => s.name);
  if (owner && !allSigned) {
    await notify(sql, { userId: owner, kind: "sign.signed", title: `${me.name} ha firmado «${r.title}»`,
                        body: pending.length ? `Falta${pending.length === 1 ? "" : "n"}: ${pending.join(", ")}.` : null, link: `/firmas/${r.id}` });
  }
  if (allSigned) await completeRequest(r.id);
  else await inviteDue(r.id).catch((err) => console.error("[firma] invitación al siguiente", err));
}

export async function declineRequest(t: string, reason: string, ip: string | null, ua: string | null) {
  const g = await bySignerToken(t);
  if (!g) throw new UserError("Este enlace no es válido.");
  const { request: r, me } = g;
  if (r.status !== "sent" || me.status !== "pending") throw new UserError(st(r.language, "cancelled"));
  const why = reason.trim().slice(0, 1000) || null;
  await transaction(async (tx) => {
    await tx`UPDATE sign_signers SET status = 'declined', declined_at = now(), decline_reason = ${why}, ip = ${ip}, user_agent = ${ua?.slice(0, 300) ?? null} WHERE id = ${me.id}`;
    await tx`UPDATE sign_requests SET status = 'declined' WHERE id = ${r.id}`;
    await log(tx, r.id, "declined", { signerId: me.id, detail: why, ip, ua });
    if (r.deal_id) await recordEvent(tx, INTEGRATION_ACTOR, "deal", r.deal_id, "sign.declined", { request_id: r.id, title: r.title, name: me.name, reason: why });
  });
  const owner = r.sender_id ?? r.created_by;
  if (owner) await notify(sql, { userId: owner, kind: "sign.declined", title: `${me.name} ha rechazado firmar «${r.title}»`, body: why, link: `/firmas/${r.id}` });
}

/** Todos han firmado: PDF final con auditoría, a todos por correo y al deal. */
export async function completeRequest(id: string) {
  const g = await getRequest(id);
  if (!g) return;
  const { request: r } = g;
  const [orig] = await sql<{ original: Buffer }[]>`SELECT original FROM sign_requests WHERE id = ${id}`;
  const lang = r.language;
  const kindText: Record<string, string> = { created: "creado", sent: "enviado", invited: "invitación enviada", viewed: "abierto", code_sent: "código enviado",
    code_verified: "código verificado", signed: "firmado", declined: "rechazado", reminded: "recordatorio", completed: "completado" };
  const events = g.events.filter((e) => e.kind !== "error").map((e) => ({ at: e.at,
    text: `${lang === "es" || lang === "ca" ? (kindText[e.kind] ?? e.kind) : e.kind}${e.signer_name ? ` · ${e.signer_name}` : ""}${e.ip ? ` · IP ${e.ip}` : ""}` }));
  const completedAt = new Date();
  const final = await stampPdf(new Uint8Array(orig.original), g.fields, {
    lang, title: r.title, id: r.id, originalSha: r.original_sha256, sentBy: `${r.sender_name ?? r.creator_name ?? ""} <${r.sender_email ?? ""}>`,
    sentAt: r.sent_at, completedAt,
    signers: g.signers.map((s) => ({ name: s.name, email: s.email, viewedAt: s.first_viewed_at, signedAt: s.signed_at, ip: s.ip, ua: s.user_agent, code: Boolean(s.code_verified_at) })),
    events,
  });
  const done = await transaction(async (tx) => {
    const [u] = await tx<{ id: string }[]>`
      UPDATE sign_requests SET status = 'completed', completed_at = ${completedAt}, signed = ${Buffer.from(final)}, signed_sha256 = ${sha256(final)}
      WHERE id = ${id} AND status = 'sent' RETURNING id`;
    if (!u) return false;
    await log(tx, id, "completed", { detail: `SHA-256 ${sha256(final)}` });
    if (r.deal_id) {
      await recordEvent(tx, INTEGRATION_ACTOR, "deal", r.deal_id, "sign.completed", { request_id: id, title: r.title });
      // Una copia en los archivos del deal, como guarda Pipedrive el documento firmado.
      await tx`INSERT INTO files (name, mime, size, data, deal_id, uploaded_by)
               VALUES (${`${r.title} (firmado).pdf`.slice(0, 255)}, 'application/pdf', ${final.length}, ${Buffer.from(final)}, ${r.deal_id}, ${r.created_by})`;
    }
    return true;
  });
  if (!done) return;
  // Correo a todos los firmantes y a quien lo envió, con el PDF firmado.
  const conn = await senderConn(r).catch(() => null);
  const list = g.signers.map((s) => `- ${s.name} (${s.email})`).join("\n");
  const attachments = final.length < 3_000_000 ? [{ name: `${r.title} (firmado).pdf`, mime: "application/pdf", data: final }] : [];
  const recipients = [...g.signers.map((s) => ({ email: s.email, name: s.name, token: s.token as string | null })),
                      ...(r.sender_email && !g.signers.some((s) => s.email === r.sender_email?.toLowerCase()) ? [{ email: r.sender_email, name: r.sender_name ?? "", token: null }] : [])];
  if (conn) {
    for (const p of recipients) {
      try {
        const link = p.token && publicBase() ? `\n\n${st(lang, "downloadSigned")}: ${publicBase()}/firma/${p.token}` : "";
        const body = st(lang, "completedBody", { name: p.name.split(" ")[0], title: r.title, signers: list }) + (attachments.length ? "" : link);
        await sendPlainEmail(conn, p.email, st(lang, "completedSubject", { title: r.title }), body + (attachments.length ? link : ""), null, { toName: p.name, attachments });
      } catch (err) {
        await log(sql, id, "error", { detail: `No se pudo enviar el documento firmado a ${p.email}: ${err instanceof Error ? err.message : "error"}` });
      }
    }
  }
  const owner = r.sender_id ?? r.created_by;
  if (owner) await notify(sql, { userId: owner, kind: "sign.completed", title: `¡«${r.title}» está firmado por todos!`, body: "El PDF firmado ya está en el deal y les ha llegado a todos por correo.", link: `/firmas/${id}` });
}

// ---------------------------------------------------------------------------
// Trabajo periódico: caducar, recordatorios automáticos y avisos al que lo envió.

export async function runEsignJobs(): Promise<{ expired: number; reminded: number; alerted: number }> {
  const out = { expired: 0, reminded: 0, alerted: 0 };
  const expired = await sql<{ id: string; title: string; owner: string | null }[]>`
    UPDATE sign_requests SET status = 'expired' WHERE status = 'sent' AND expires_at < now() RETURNING id, title, coalesce(sender_id, created_by) AS owner`;
  for (const e of expired) {
    await log(sql, e.id, "expired");
    if (e.owner) await notify(sql, { userId: e.owner, kind: "sign.expired", title: `«${e.title}» ha caducado sin todas las firmas`, body: "Puedes crear una versión nueva y volver a enviarlo.", link: `/firmas/${e.id}` });
    out.expired++;
  }
  // Recordatorio automático cada N días a quien tiene la firma pendiente (como mucho 5).
  const due = await sql<{ request_id: string; signer_id: string }[]>`
    SELECT s.request_id, s.id AS signer_id FROM sign_signers s JOIN sign_requests r ON r.id = s.request_id
    WHERE r.status = 'sent' AND r.reminder_days > 0 AND s.status = 'pending' AND s.invited_at IS NOT NULL
      AND coalesce(s.last_reminded_at, s.invited_at) < now() - make_interval(days => r.reminder_days)
      AND (SELECT count(*) FROM sign_events e WHERE e.signer_id = s.id AND e.kind = 'reminded') < 5
    LIMIT 50`;
  for (const d of due) {
    try { out.reminded += await remind(INTEGRATION_ACTOR, d.request_id, d.signer_id); } catch (err) { console.error("[firma] recordatorio", err); }
  }
  // Aviso a quien lo envió si lleva 3 días o más esperando (como mucho cada 3 días).
  const waiting = await sql<{ id: string; title: string; owner: string; days: number; names: string }[]>`
    SELECT r.id, r.title, coalesce(r.sender_id, r.created_by) AS owner,
           floor(extract(epoch FROM now() - r.sent_at) / 86400)::int AS days,
           string_agg(s.name, ', ' ORDER BY s.position) AS names
    FROM sign_requests r JOIN sign_signers s ON s.request_id = r.id AND s.status IN ('pending', 'waiting')
    WHERE r.status = 'sent' AND r.sent_at < now() - interval '3 days' AND coalesce(r.sender_id, r.created_by) IS NOT NULL
      AND (r.owner_alerted_at IS NULL OR r.owner_alerted_at < now() - interval '3 days')
    GROUP BY r.id`;
  for (const w of waiting) {
    await sql`UPDATE sign_requests SET owner_alerted_at = now() WHERE id = ${w.id}`;
    await notify(sql, { userId: w.owner, kind: "sign.waiting", title: `«${w.title}» lleva ${w.days} días esperando firma`,
                        body: `Falta: ${w.names}. Llámales o mándales un recordatorio.`, link: `/firmas/${w.id}` });
    out.alerted++;
  }
  return out;
}
