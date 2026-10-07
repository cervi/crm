"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guard, writer } from "@/lib/auth";
import { attempt, toUserMessage, UserError, type ActionState } from "@/lib/errors";
import { sql } from "@/lib/db";
import { follow, unfollow, type FollowEntity } from "@/lib/followers";
import { deleteFile } from "@/lib/files";
import { logCall, setNotePinned, setTags, type TagEntity } from "@/lib/contact-workspace";
import { composeDealEmail } from "@/lib/emails";
import { enrollPerson } from "@/lib/sequences";
import { merge } from "@/lib/duplicates";
import { recordEvent } from "@/lib/events";
import { completeActivity } from "@/lib/activities";
import { bulkRecords } from "@/lib/bulk";
import { isId } from "@/lib/validation";

// Acciones de las fichas de contacto, empresa y deal (estilo Pipedrive).

const ENTITIES = new Set(["deal", "person", "organization", "lead"]);

export async function followAction(type: FollowEntity, id: string, on: boolean, back: string): Promise<void> {
  const actor = await writer();
  if (!ENTITIES.has(type) || !isId(id) || !actor.id) return;
  if (on) await follow(type, id, actor.id); else await unfollow(type, id, actor.id);
  revalidatePath(back);
}

export async function addFollowerAction(type: FollowEntity, id: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const userId = String(form.get("user_id") ?? "");
  if (!isId(userId)) return { error: "Elige a alguien del equipo." };
  const res = await attempt(() => follow(type, id, userId));
  revalidatePath(back);
  return res;
}

export async function removeFollowerAction(type: FollowEntity, id: string, userId: string, back: string): Promise<void> {
  await writer();
  await unfollow(type, id, userId);
  revalidatePath(back);
}

export async function logCallAction(back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => logCall(g.actor, Object.fromEntries(form)));
  revalidatePath(back);
  return res?.error ? res : { ok: true, message: "Llamada registrada." };
}

export async function setTagsAction(entity: TagEntity, id: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const names = String(form.get("tags") ?? "").split(",");
  const res = await attempt(() => setTags(g.actor, entity, id, names, String(form.get("color") ?? "") || undefined));
  revalidatePath(back);
  return res;
}

export async function pinNoteAction(noteId: string, pinned: boolean, back: string): Promise<void> {
  await writer();
  await setNotePinned(noteId, pinned);
  revalidatePath(back);
}

export async function deleteFileAction(fileId: string, back: string): Promise<void> {
  const actor = await writer();
  try { await deleteFile(actor, fileId); } catch (err) { console.error(toUserMessage(err)); }
  revalidatePath(back);
}

/** Correo a un contacto desde su ficha (con o sin deal). */
export async function sendContactEmailAction(personId: string | null, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const dealId = String(form.get("deal_id") ?? "");
  let scheduled = false;
  const res = await attempt(async () => {
    scheduled = (await composeDealEmail(g.actor, isId(dealId) ? dealId : null, { ...Object.fromEntries(form), person_id: personId ?? String(form.get("person_id") ?? "") })).scheduled;
  });
  revalidatePath(back);
  return res?.error ? res : { ok: true, message: scheduled ? "Correo programado." : "Correo enviado." };
}

export async function enrollPersonAction(personId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => enrollPerson(g.actor, String(form.get("sequence_id") ?? ""), personId));
  revalidatePath(back);
  return res?.error ? res : { ok: true, message: "Añadido a la secuencia." };
}

/** Fusionar con otro registro: se queda el que se elija y el otro pasa a la papelera. */
export async function mergeWithAction(kind: "person" | "organization", id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const other = String(form.get("other_id") ?? "");
  const keep = form.get("keep") === "other" ? other : id;
  const drop = keep === id ? other : id;
  if (!isId(other)) return { error: kind === "person" ? "Elige el contacto con el que fusionarlo." : "Elige la empresa con la que fusionarla." };
  if (other === id) return { error: "Es el mismo registro." };
  const res = await attempt(async () => {
    await merge(g.actor, kind, keep, [drop]);
    // Los seguidores del que desaparece pasan al que se queda.
    await sql`INSERT INTO followers (entity_type, entity_id, user_id) SELECT entity_type, ${keep}, user_id FROM followers
              WHERE entity_type = ${kind} AND entity_id = ${drop} ON CONFLICT DO NOTHING`;
    await sql`DELETE FROM followers WHERE entity_type = ${kind} AND entity_id = ${drop}`;
  });
  if (res?.error) return res;
  redirect(`/${kind === "person" ? "persons" : "organizations"}/${keep}`);
}

/** Cambiar el responsable desde la ficha. */
export async function changeOwnerAction(kind: "person" | "organization", id: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const owner = String(form.get("owner_id") ?? "");
  const res = await attempt(async () => {
    if (owner && !isId(owner)) throw new UserError("Responsable no válido.");
    if (kind === "person") await sql`UPDATE persons SET owner_id = ${owner || null}, updated_at = now() WHERE id = ${id}`;
    else await sql`UPDATE organizations SET owner_id = ${owner || null}, updated_at = now() WHERE id = ${id}`;
    await recordEvent(sql, g.actor, kind, id, `${kind}.owner_changed`, { to_owner_id: owner || null });
  });
  revalidatePath(back);
  return res;
}

/** Marcar una actividad como hecha desde el «Enfoque». */
export async function quickCompleteAction(activityId: string, back: string): Promise<void> {
  const actor = await writer();
  try { await completeActivity(actor, activityId, {}); } catch (err) { console.error(toUserMessage(err)); }
  revalidatePath(back);
}

/** Acciones en bloque desde la lista de contactos o de empresas. */
export async function bulkRecordsAction(kind: "person" | "organization", ids: string[], data: Record<string, string>): Promise<{ error?: string; message?: string }> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    const r = await bulkRecords(g.actor, kind, ids, data);
    revalidatePath(kind === "person" ? "/persons" : "/organizations");
    const word = kind === "person" ? ["contacto", "contactos"] : ["empresa", "empresas"];
    return { message: `${r.done} ${r.done === 1 ? word[0] : word[1]} con el cambio${r.skipped ? `, ${r.skipped} sin cambios${r.firstError ? ` (${r.firstError.replace(/\.$/, "")})` : ""}` : ""}.` };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}
