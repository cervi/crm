"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "@/lib/db";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { UI_ACTOR } from "@/lib/events";
import { disconnect, listConnections, senderFor, sendEmail, syncMailbox, updateConnectionSettings } from "@/lib/mailbox";
import { id, parse, text } from "@/lib/validation";

const refresh = () => revalidatePath("/", "layout");

export async function disconnectMailboxAction(userId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(() => disconnect(userId));
  refresh();
  return res;
}

export async function syncMailboxAction(userId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(async () => {
    const conn = (await listConnections()).find((c) => c.user_id === userId);
    if (!conn) throw new UserError("Ese usuario no tiene el correo conectado.");
    await syncMailbox(conn);
  });
  refresh();
  return res;
}

export async function updateMailboxSettingsAction(userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => updateConnectionSettings(userId, Object.fromEntries(form)));
  refresh();
  return res;
}

/** Correo escrito desde la ficha del deal: sale del buzón del responsable. */
export async function sendDealEmailAction(dealId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => {
    const v = parse(z.object({ person_id: id, subject: text("El asunto", 300), body: text("El texto", 20000) }), Object.fromEntries(form));
    const [p] = await sql<{ full_name: string; email: string | null; owner_id: string | null; organization_id: string | null }[]>`
      SELECT p.full_name,
             (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
             d.owner_id, d.organization_id
      FROM persons p, deals d WHERE p.id = ${v.person_id} AND d.id = ${dealId}`;
    if (!p?.email) throw new UserError("Ese contacto no tiene email.");
    const conn = await senderFor(p.owner_id);
    if (!conn) throw new UserError("Conecta tu correo en Ajustes → Correo y calendario para enviar desde aquí.");
    await sendEmail(conn, UI_ACTOR, {
      to: { email: p.email, name: p.full_name }, subject: v.subject, body: v.body,
      dealId, personId: v.person_id, organizationId: p.organization_id,
    });
  });
  revalidatePath(back);
  return res;
}
