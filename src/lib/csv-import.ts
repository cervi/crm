import { transaction } from "./db";
import { UserError, toUserMessage } from "./errors";
import { INTEGRATION_ACTOR, type Actor } from "./events";
import { ingestLead } from "./leads";
import { createPerson, findPersonByEmail } from "./persons";
import { findOrCreateOrganization } from "./organizations";
import { companyDomainFromEmail } from "./validation";
import { recomputeScores } from "./scoring";
import { applyAssignment } from "./assignment";

// ===========================================================================
// Importar contactos o leads desde un CSV (Excel, Google Sheets, otro CRM):
// las columnas se reconocen por su cabecera y se pueden corregir antes.
// ===========================================================================

export const IMPORT_FIELDS = {
  email: "Email",
  full_name: "Nombre completo",
  first_name: "Nombre",
  last_name: "Apellidos",
  company: "Empresa",
  phone: "Teléfono",
  job_title: "Cargo",
  source: "Origen",
  tags: "Etiquetas",
  message: "Notas",
} as const;
export type ImportField = keyof typeof IMPORT_FIELDS;

const SYNONYMS: Record<ImportField, string[]> = {
  email: ["email", "e-mail", "correo", "correo electronico", "mail", "email address"],
  full_name: ["nombre completo", "name", "full name", "contacto", "persona", "nombre y apellidos"],
  first_name: ["nombre", "first name", "firstname", "nombre de pila"],
  last_name: ["apellidos", "apellido", "last name", "lastname", "surname"],
  company: ["empresa", "company", "organizacion", "organization", "compania", "cuenta", "account"],
  phone: ["telefono", "phone", "movil", "mobile", "tel", "telefono movil"],
  job_title: ["cargo", "puesto", "job title", "title", "position", "rol"],
  source: ["origen", "fuente", "source", "lead source", "canal"],
  tags: ["etiquetas", "tags", "etiqueta"],
  message: ["notas", "nota", "comentario", "comentarios", "mensaje", "notes", "message", "descripcion"],
};

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();

/** Lee un CSV (separador «;», «,» o tabulador, comillas, BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = [";", ",", "\t"].map((c) => [c, firstLine.split(c).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Qué campo es cada columna, según su cabecera. */
export function guessMapping(headers: string[]): (ImportField | "")[] {
  const used = new Set<ImportField>();
  return headers.map((h) => {
    const n = norm(h);
    const hit = (Object.keys(SYNONYMS) as ImportField[]).find((f) => !used.has(f) && SYNONYMS[f].includes(n));
    if (hit) { used.add(hit); return hit; }
    return "";
  });
}

export type ImportResult = { total: number; created: number; updated: number; skipped: number; errors: { row: number; message: string }[] };

export async function importCsv(actor: Actor, text: string, mapping: (ImportField | "")[], mode: "leads" | "contacts", defaultSource: string): Promise<ImportResult> {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new UserError("El archivo no tiene filas de datos (la primera fila son los títulos de las columnas).");
  if (rows.length > 5001) throw new UserError("Como mucho 5000 filas por archivo: divídelo en varios.");
  if (!mapping.includes("email")) throw new UserError("Indica qué columna es el email: es lo que evita duplicados.");
  const result: ImportResult = { total: rows.length - 1, created: 0, updated: 0, skipped: 0, errors: [] };
  const leadIds: string[] = [];
  for (let i = 1; i < rows.length; i++) {
    const v: Partial<Record<ImportField, string>> = {};
    mapping.forEach((f, col) => { const val = rows[i][col]?.trim(); if (f && val) v[f] = val.slice(0, f === "message" ? 5000 : 300); });
    const email = v.email?.toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      result.skipped++;
      if (result.errors.length < 50) result.errors.push({ row: i + 1, message: email ? `Email no válido: ${email}` : "Sin email" });
      continue;
    }
    try {
      if (mode === "leads") {
        const r = await ingestLead(actor.type === "user" ? actor : INTEGRATION_ACTOR, {
          email, full_name: v.full_name, first_name: v.first_name, last_name: v.last_name, company: v.company, phone: v.phone,
          job_title: v.job_title, source: v.source || defaultSource, message: v.message,
          tags: v.tags ? v.tags.split(/[,;|]/).map((t) => t.trim()).filter(Boolean).slice(0, 20) : undefined,
        });
        if (r.created.lead) result.created++; else result.updated++;
        leadIds.push(r.lead_id);
      } else {
        const created = await transaction(async (tx) => {
          if (await findPersonByEmail(tx, email)) return false;
          const org = await findOrCreateOrganization(tx, actor, { name: v.company, domain: companyDomainFromEmail(email) });
          const [first, ...rest] = (v.full_name ?? "").split(/\s+/);
          await createPerson(actor, {
            first_name: v.first_name ?? (first || email.split("@")[0]), last_name: v.last_name ?? (rest.join(" ") || undefined),
            email, phone: v.phone, organization_id: org?.id, job_title: v.job_title,
          }, {}, tx);
          return true;
        });
        if (created) result.created++; else result.updated++;
      }
    } catch (err) {
      result.skipped++;
      if (result.errors.length < 50) result.errors.push({ row: i + 1, message: toUserMessage(err) });
    }
  }
  if (leadIds.length) {
    for (const id of leadIds.slice(0, 1000)) await recomputeScores(id).catch(() => 0);
    await applyAssignment().catch(() => null);
  }
  return result;
}
