"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guard } from "@/lib/auth";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { saveIcp } from "@/lib/icp";
import {
  addContacts, addFromCrm, approveContacts, personFromToken, removeContact, runCampaignPrepare, saveCampaign, setCampaignStatus, unsubscribe,
  updateLine, type CampaignStatus, type ContactInput,
} from "@/lib/campaigns";
import { guessMapping, parseCsv } from "@/lib/csv-import";
import { disconnectMailbox, updateOutboundMailbox } from "@/lib/mailbox";

export async function saveIcpAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => saveIcp(Object.fromEntries(form)));
  revalidatePath("/settings/icp");
  return res;
}

/** Baja pública (sin sesión): el token va firmado. */
export async function unsubscribeAction(token: string, _: ActionState): Promise<ActionState> {
  const personId = personFromToken(token);
  if (!personId) return { error: "Este enlace no es válido." };
  return attempt(async () => {
    if (!(await unsubscribe(personId, "enlace"))) throw new UserError("Este enlace no es válido.");
  }).then((r) => r ?? { ok: true });
}

export async function saveCampaignAction(id: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let saved = "";
  const res = await attempt(async () => { saved = await saveCampaign(g.actor, id, Object.fromEntries(form)); });
  if (res?.error) return res;
  revalidatePath("/campaigns");
  if (!id) redirect(`/campaigns/${saved}`);
  revalidatePath(`/campaigns/${id}`);
  return { ok: true };
}

export async function setCampaignStatusAction(id: string, status: CampaignStatus, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => setCampaignStatus(id, status));
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/campaigns");
  return res;
}

/** Contactos pegados o subidos en CSV (con cabeceras: email, nombre, empresa, cargo…). */
export async function addCsvContactsAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let summary = "";
  const res = await attempt(async () => {
    const file = form.get("file");
    const text = file instanceof File && file.size > 0 ? await file.text() : String(form.get("csv") ?? "");
    if (!text.trim()) throw new UserError("Pega los contactos o elige un archivo CSV.");
    const rows = parseCsv(text);
    if (rows.length < 2) throw new UserError("La primera fila tiene que ser la de títulos (email, nombre, empresa…) y luego un contacto por fila.");
    const mapping = guessMapping(rows[0]);
    if (!mapping.includes("email")) throw new UserError("No encuentro la columna del email (llámala «email»).");
    const contacts: ContactInput[] = rows.slice(1).map((r) => {
      const o: Record<string, string> = {};
      mapping.forEach((f, i) => { if (f && r[i]?.trim()) o[f] = r[i].trim(); });
      return { email: o.email ?? "", full_name: o.full_name, first_name: o.first_name, last_name: o.last_name, company: o.company, job_title: o.job_title, phone: o.phone };
    });
    const r = await addContacts(g.actor, id, contacts, "csv");
    summary = `${r.added} añadidos${r.existing ? `, ${r.existing} ya estaban` : ""}${r.skipped.length ? `, ${r.skipped.length} descartados (${r.skipped.slice(0, 3).map((s) => `${s.email}: ${s.reason}`).join("; ")})` : ""}.`;
    await runCampaignPrepare();
  });
  revalidatePath(`/campaigns/${id}`);
  return res?.error ? res : { ok: true, message: summary };
}

export async function addCrmContactsAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let summary = "";
  const res = await attempt(async () => {
    const r = await addFromCrm(g.actor, id, Object.fromEntries(form));
    summary = r.added ? `${r.added} contactos añadidos.` : "Ningún contacto nuevo con esos filtros.";
    await runCampaignPrepare();
  });
  revalidatePath(`/campaigns/${id}`);
  return res?.error ? res : { ok: true, message: summary };
}

export async function approveContactsAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const all = form.get("all") === "1";
  const ids = form.getAll("contact").map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const res = await attempt(async () => {
    // Las frases editadas en la lista se guardan antes de aprobar.
    for (const [k, v] of form.entries()) {
      if (k.startsWith("line_") && /^[0-9a-f-]{36}$/i.test(k.slice(5))) await updateLine(id, k.slice(5), String(v));
    }
    if (!all && ids.length === 0) throw new UserError("Marca los contactos que quieres aprobar.");
    await approveContacts(id, all ? "all" : ids);
    await runCampaignPrepare();
  });
  revalidatePath(`/campaigns/${id}`);
  return res;
}

export async function updateLineAction(id: string, contactId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => updateLine(id, contactId, String(form.get("line") ?? "")));
  revalidatePath(`/campaigns/${id}`);
  return res;
}

export async function removeContactAction(id: string, contactId: string): Promise<void> {
  const g = await guard("write");
  if ("error" in g) return;
  await removeContact(id, contactId);
  revalidatePath(`/campaigns/${id}`);
}

export async function updateMailboxAction(mailboxId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => updateOutboundMailbox(mailboxId, Object.fromEntries(form)));
  revalidatePath("/settings/mailbox");
  return res;
}

export async function disconnectOutboundAction(mailboxId: string): Promise<void> {
  const g = await guard("admin");
  if ("error" in g) return;
  await disconnectMailbox(mailboxId);
  revalidatePath("/settings/mailbox");
}
