"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";
import { sql } from "@/lib/db";
import { assignMeetingNote, ingestMeetingNote, parseAttendees, setMeetingNoteIgnored } from "@/lib/meeting-notes";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim() || null;

export async function assignMeetingNoteAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    await assignMeetingNote(g.actor, id, { deal_id: s(form, "deal_id"), lead_id: s(form, "lead_id"), person_id: s(form, "person_id") });
  } catch (err) {
    return { error: toUserMessage(err) };
  }
  revalidatePath("/reuniones");
  return { ok: true, message: "Asociada: la reunión queda como realizada con sus notas." };
}

export async function ignoreMeetingNoteAction(id: string, ignored: boolean, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => setMeetingNoteIgnored(id, ignored));
  revalidatePath("/reuniones");
  return res;
}

/** Notas pegadas a mano (p. ej. copiadas de Granola sin Zapier). */
export async function pasteMeetingNoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    const when = s(form, "started_at");
    const [me] = g.actor.id ? await sql<{ email: string | null }[]>`SELECT email FROM users WHERE id = ${g.actor.id}` : [];
    const r = await ingestMeetingNote({
      source: "manual", title: s(form, "title"), started_at: when ? new Date(when) : new Date(),
      organizer_email: me?.email ?? null,
      attendees: parseAttendees(s(form, "attendees") ?? ""), summary: s(form, "notes"), transcript: s(form, "transcript"),
    });
    revalidatePath("/reuniones");
    return { ok: true, message: r.status === "matched" ? `Guardada y asociada (${r.reason?.toLowerCase()}).` : r.status === "ignored"
      ? "Guardada, pero solo había gente de tu equipo: queda en «Descartadas»." : `Guardada. Falta elegir a qué va: ${r.reason ?? ""}` };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}
