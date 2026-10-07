import { sql } from "./db";
import { bookingLinkFor } from "./booking";
import { money } from "./format";
import { slotsText, type Connection } from "./mailbox";
import { unsubscribeUrl } from "./campaigns";
import type { MergeVars } from "./merge";

// ===========================================================================
// Valores de las variables de un correo para un contacto concreto: sus datos,
// los de su empresa y su deal, los de quien envía y los especiales (huecos de
// la agenda, enlace de reserva, primera línea de la campaña, baja).
// ===========================================================================

export type MergeRef = {
  personId: string;
  dealId?: string | null;
  senderId?: string | null;
  campaignContactId?: string | null;
  /** Buzón que envía (para {{huecos}}); solo se calculan si la plantilla los usa. */
  conn?: Connection | null;
  wantSlots?: boolean;
};

const firstWord = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] ?? "";

export async function mergeContext(ref: MergeRef): Promise<MergeVars> {
  const [p] = await sql<{ id: string; first_name: string | null; last_name: string | null; full_name: string | null; linkedin_url: string | null;
                          custom: Record<string, unknown>; email: string | null; phone: string | null; job_title: string | null; org_id: string | null }[]>`
    SELECT p.id, p.first_name, p.last_name, p.full_name, p.linkedin_url, p.custom,
           (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           (SELECT phone FROM person_phones WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS phone,
           po.job_title, po.organization_id AS org_id
    FROM persons p
    LEFT JOIN LATERAL (SELECT job_title, organization_id FROM person_organizations WHERE person_id = p.id AND status = 'current'
                       ORDER BY created_at DESC LIMIT 1) po ON true
    WHERE p.id = ${ref.personId}`;
  if (!p) return {};
  const [d] = ref.dealId ? await sql<{ title: string; value: string | null; currency: string; stage: string | null; owner_id: string | null;
                                       owner: string | null; organization_id: string | null; custom: Record<string, unknown> }[]>`
    SELECT d.title, d.value::text, d.currency, s.name AS stage, d.owner_id, u.name AS owner, d.organization_id, d.custom
    FROM deals d LEFT JOIN stages s ON s.id = d.stage_id LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = ${ref.dealId}` : [];
  const orgId = d?.organization_id ?? p.org_id;
  const [o] = orgId ? await sql<{ name: string; domain: string | null; website: string | null; industry: string | null; employee_count: number | null;
                                  city: string | null; country: string | null; custom: Record<string, unknown> }[]>`
    SELECT name, domain, website, industry, employee_count, city, country, custom FROM organizations WHERE id = ${orgId}` : [];
  const senderId = ref.senderId ?? d?.owner_id ?? null;
  const [u] = senderId ? await sql<{ name: string; email: string | null }[]>`SELECT name, email FROM users WHERE id = ${senderId}` : [];
  const [cc] = ref.campaignContactId ? await sql<{ personal_line: string | null }[]>`
    SELECT personal_line FROM campaign_contacts WHERE id = ${ref.campaignContactId}` : [];

  const vars: MergeVars = {
    nombre: p.first_name?.trim() || firstWord(p.full_name),
    apellidos: p.last_name ?? "",
    nombre_completo: p.full_name ?? "",
    email: p.email ?? "",
    cargo: p.job_title ?? "",
    telefono: p.phone ?? "",
    linkedin: p.linkedin_url ?? "",
    empresa: o?.name ?? "",
    empresa_web: o?.website ?? "",
    empresa_dominio: o?.domain ?? "",
    empresa_sector: o?.industry ?? "",
    empresa_empleados: o?.employee_count ?? "",
    empresa_ciudad: o?.city ?? "",
    empresa_pais: o?.country ?? "",
    deal: d?.title ?? "",
    deal_valor: d?.value ? money(d.value, d.currency) : "",
    deal_fase: d?.stage ?? "",
    remitente: u?.name ?? "",
    remitente_nombre: firstWord(u?.name),
    remitente_email: ref.conn?.email ?? u?.email ?? "",
    responsable: d?.owner ?? u?.name ?? "",
    gancho: cc?.personal_line ?? "",
    enlace_baja: unsubscribeUrl(p.id),
  };
  const customs: [string, Record<string, unknown> | undefined][] = [["contacto", p.custom], ["empresa", o?.custom], ["deal", d?.custom]];
  for (const [ns, obj] of customs) {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v === null || v === undefined || typeof v === "object" && !Array.isArray(v)) continue;
      vars[`${ns}.${k}`] = Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "sí" : "no") : String(v);
    }
  }
  if (ref.dealId) {
    const link = await bookingLinkFor(d?.owner_id ?? senderId, ref.dealId, p.id).catch(() => null);
    if (link) vars.enlace_reserva = link;
  }
  if (ref.wantSlots) vars.huecos = await slotsText(ref.conn ?? null);
  return vars;
}
