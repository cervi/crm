"use server";

import { guard, writer } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import { listFieldDefinitions, readCustomValues } from "@/lib/custom-fields";
import { createOrganization, getOrganization, updateOrganization } from "@/lib/organizations";
import { changeCompany, createPerson, getPerson, updatePerson } from "@/lib/persons";
import { createActivity, completeActivity, reopenActivity } from "@/lib/activities";
import { createNote } from "@/lib/notes";
import { addActivityToCalendar } from "@/lib/mailbox";

const fields = (form: FormData) => Object.fromEntries(form);

// ---------------------------------------------------------------- Empresas

export async function createOrganizationAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  let newId = "";
  const res = await attempt(async () => {
    const custom = readCustomValues(await listFieldDefinitions("organization"), form);
    newId = await createOrganization(me, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath("/organizations");
  redirect(`/organizations/${newId}`);
}

export async function updateOrganizationAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(async () => {
    const before = await getOrganization(id);
    const custom = readCustomValues(await listFieldDefinitions("organization", true), form, before?.custom);
    await updateOrganization(me, id, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath("/organizations");
  redirect(`/organizations/${id}`);
}

// ---------------------------------------------------------------- Contactos

export async function createPersonAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  let newId = "";
  const res = await attempt(async () => {
    const custom = readCustomValues(await listFieldDefinitions("person"), form);
    newId = await createPerson(me, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath("/persons");
  redirect(`/persons/${newId}`);
}

export async function updatePersonAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(async () => {
    const before = await getPerson(id);
    const custom = readCustomValues(await listFieldDefinitions("person", true), form, before?.custom);
    await updatePerson(me, id, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath("/persons");
  redirect(`/persons/${id}`);
}

export async function changeCompanyAction(personId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => changeCompany(me, personId, fields(form)));
  revalidatePath(`/persons/${personId}`);
  return res;
}

// ---------------------------------------------------------------- Actividades y notas

/** `back` es la ruta que se refresca tras guardar (la ficha desde la que se crea). */
export async function createActivityAction(back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  let activityId = "";
  let res = await attempt(async () => { activityId = await createActivity(me, fields(form)); });
  // «Invitar desde mi calendario»: la reunión se crea en el calendario conectado (con Teams o Meet si es en línea).
  if (!res?.error && form.get("add_to_calendar") === "on") {
    const cal = await attempt(() => addActivityToCalendar(activityId));
    if (cal?.error) res = { error: `Actividad creada, pero no se pudo añadir al calendario: ${cal.error}` };
  }
  revalidatePath(back);
  revalidatePath("/activities");
  return res;
}

export async function completeActivityAction(activityId: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => completeActivity(me, activityId, fields(form)));
  revalidatePath(back);
  revalidatePath("/activities");
  return res;
}

export async function reopenActivityAction(activityId: string, back: string): Promise<void> {
  await writer();
  await reopenActivity(activityId);
  revalidatePath(back);
  revalidatePath("/activities");
}

export async function createNoteAction(back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const me = g.actor;
  const res = await attempt(() => createNote(me, fields(form)));
  revalidatePath(back);
  return res;
}

/** Marca o desmarca una actividad como hecha desde la tabla (sin formulario). */
export async function toggleActivityDoneAction(activityId: string, done: boolean): Promise<{ error?: string }> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    if (done) await completeActivity(g.actor, activityId, {});
    else await reopenActivity(activityId);
  } catch (err) {
    return { error: toUserMessage(err) };
  }
  revalidatePath("/activities");
  return {};
}

/** Marca varias actividades como hechas a la vez. */
export async function bulkCompleteActivitiesAction(ids: string[]): Promise<{ error?: string; message?: string }> {
  const g = await guard("write");
  if ("error" in g) return g;
  let done = 0;
  for (const id of ids.slice(0, 500)) {
    try { await completeActivity(g.actor, id, {}); done++; } catch { /* ya hecha o borrada */ }
  }
  revalidatePath("/activities");
  return { message: `${done} actividad${done === 1 ? "" : "es"} marcada${done === 1 ? "" : "s"} como hecha${done === 1 ? "" : "s"}.` };
}
