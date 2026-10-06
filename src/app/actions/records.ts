"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, type ActionState } from "@/lib/errors";
import { UI_ACTOR } from "@/lib/events";
import { listFieldDefinitions, readCustomValues } from "@/lib/custom-fields";
import { createOrganization, getOrganization, updateOrganization } from "@/lib/organizations";
import { changeCompany, createPerson, getPerson, updatePerson } from "@/lib/persons";
import { createActivity, completeActivity, reopenActivity } from "@/lib/activities";
import { createNote } from "@/lib/notes";
import { addActivityToCalendar } from "@/lib/mailbox";

const fields = (form: FormData) => Object.fromEntries(form);

// ---------------------------------------------------------------- Empresas

export async function createOrganizationAction(_: ActionState, form: FormData): Promise<ActionState> {
  let newId = "";
  const res = await attempt(async () => {
    const custom = readCustomValues(await listFieldDefinitions("organization"), form);
    newId = await createOrganization(UI_ACTOR, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath("/organizations");
  redirect(`/organizations/${newId}`);
}

export async function updateOrganizationAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => {
    const before = await getOrganization(id);
    const custom = readCustomValues(await listFieldDefinitions("organization", true), form, before?.custom);
    await updateOrganization(UI_ACTOR, id, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath("/organizations");
  redirect(`/organizations/${id}`);
}

// ---------------------------------------------------------------- Contactos

export async function createPersonAction(_: ActionState, form: FormData): Promise<ActionState> {
  let newId = "";
  const res = await attempt(async () => {
    const custom = readCustomValues(await listFieldDefinitions("person"), form);
    newId = await createPerson(UI_ACTOR, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath("/persons");
  redirect(`/persons/${newId}`);
}

export async function updatePersonAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => {
    const before = await getPerson(id);
    const custom = readCustomValues(await listFieldDefinitions("person", true), form, before?.custom);
    await updatePerson(UI_ACTOR, id, fields(form), custom);
  });
  if (res?.error) return res;
  revalidatePath("/persons");
  redirect(`/persons/${id}`);
}

export async function changeCompanyAction(personId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => changeCompany(UI_ACTOR, personId, fields(form)));
  revalidatePath(`/persons/${personId}`);
  return res;
}

// ---------------------------------------------------------------- Actividades y notas

/** `back` es la ruta que se refresca tras guardar (la ficha desde la que se crea). */
export async function createActivityAction(back: string, _: ActionState, form: FormData): Promise<ActionState> {
  let activityId = "";
  let res = await attempt(async () => { activityId = await createActivity(UI_ACTOR, fields(form)); });
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
  const res = await attempt(() => completeActivity(UI_ACTOR, activityId, fields(form)));
  revalidatePath(back);
  revalidatePath("/activities");
  return res;
}

export async function reopenActivityAction(activityId: string, back: string): Promise<void> {
  await reopenActivity(activityId);
  revalidatePath(back);
  revalidatePath("/activities");
}

export async function createNoteAction(back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => createNote(UI_ACTOR, fields(form)));
  revalidatePath(back);
  return res;
}
