"use server";

import { adminOnly, currentUser, guard } from "@/lib/auth";
import { cancelScheduledEmail, composeDealEmail, deleteTemplate, saveTemplate } from "@/lib/emails";
import { revalidatePath } from "next/cache";
import { sql } from "@/lib/db";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { disconnect, listConnections, syncMailbox, updateConnectionSettings } from "@/lib/mailbox";

const refresh = () => revalidatePath("/", "layout");

export async function disconnectMailboxAction(userId: string, _: ActionState): Promise<ActionState> {
  const g = await guard({ self: userId });
  if ("error" in g) return g;
  const res = await attempt(() => disconnect(userId));
  refresh();
  return res;
}

export async function syncMailboxAction(userId: string, _: ActionState): Promise<ActionState> {
  const g = await guard({ self: userId });
  if ("error" in g) return g;
  const res = await attempt(async () => {
    const conn = (await listConnections()).find((c) => c.user_id === userId);
    if (!conn) throw new UserError("Ese usuario no tiene el correo conectado.");
    await syncMailbox(conn);
  });
  refresh();
  return res;
}

export async function updateMailboxSettingsAction(userId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard({ self: userId });
  if ("error" in g) return g;
  const res = await attempt(() => updateConnectionSettings(userId, Object.fromEntries(form)));
  refresh();
  return res;
}

/** Correo escrito desde la ficha del deal: se envía ya o queda programado. */
export async function sendDealEmailAction(dealId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => composeDealEmail(g.actor, dealId, Object.fromEntries(form)));
  revalidatePath(back);
  return res;
}

export async function cancelScheduledEmailAction(emailId: string, back: string): Promise<void> {
  const me = await currentUser();
  if (!me || me.role === "viewer") return;
  await cancelScheduledEmail(me, emailId);
  revalidatePath(back);
}

export async function saveTemplateAction(templateId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const me = await currentUser();
  if (!me || me.role === "viewer") return { error: "No tienes permiso para esto." };
  const res = await attempt(() => saveTemplate(me, templateId, Object.fromEntries(form)));
  revalidatePath("/settings/templates");
  return res;
}

export async function deleteTemplateAction(templateId: string, _: ActionState): Promise<ActionState> {
  const me = await currentUser();
  if (!me || me.role === "viewer") return { error: "No tienes permiso para esto." };
  const res = await attempt(() => deleteTemplate(me, templateId));
  revalidatePath("/settings/templates");
  return res;
}

export async function setEmailTrackingAction(on: boolean): Promise<void> {
  await adminOnly();
  await sql`UPDATE app_settings SET email_tracking = ${on}`;
  revalidatePath("/settings/templates");
}
