"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { guard } from "@/lib/auth";
import { sql } from "@/lib/db";
import { toUserMessage, type ActionState } from "@/lib/errors";
import type { Actor } from "@/lib/events";
import { assignMeetingNote, ingestMeetingNote, parseAttendees, setMeetingNoteIgnored, type NoteViewer } from "@/lib/meeting-notes";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim() || null;

async function viewerOf(actor: Actor): Promise<NoteViewer & { email: string | null }> {
  const [u] = await sql<{ role: string; email: string | null }[]>`SELECT role, email FROM users WHERE id = ${actor.id}`;
  return { id: actor.id ?? "", admin: u?.role === "admin", email: u?.email ?? null };
}

/** Asociar (o cambiar) a un deal, un lead o solo a un contacto. La confirmación se ve arriba de la bandeja. */
export async function assignMeetingNoteAction(id: string, back: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const kind = s(form, "kind") as "deal" | "lead" | "person" | null;
  const target = s(form, "candidate")?.split(":") ?? [];
  try {
    const v = await viewerOf(g.actor);
    if (target.length === 2) {
      await assignMeetingNote(g.actor, v, id, { kind: target[0] as "deal" | "lead", id: target[1] });
    } else {
      if (!kind) return { error: "Elige si va a un deal, a un lead o solo al contacto." };
      await assignMeetingNote(g.actor, v, id, { kind, id: s(form, `${kind}_id`) ?? "", person_id: s(form, "person_id") });
    }
  } catch (err) {
    return { error: toUserMessage(err) };
  }
  revalidatePath("/reuniones");
  redirect(`/reuniones?ver=${back}&hecho=${id}&accion=asociada`);
}

export async function ignoreMeetingNoteAction(id: string, ignored: boolean, back: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    await setMeetingNoteIgnored(await viewerOf(g.actor), id, ignored);
  } catch (err) {
    return { error: toUserMessage(err) };
  }
  revalidatePath("/reuniones");
  redirect(`/reuniones?ver=${back}&hecho=${id}&accion=${ignored ? "descartada" : "recuperada"}`);
}

/** Notas pegadas a mano (p. ej. copiadas de Granola sin Zapier). */
export async function pasteMeetingNoteAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  try {
    const when = s(form, "started_at");
    const v = await viewerOf(g.actor);
    const r = await ingestMeetingNote({
      source: "manual", title: s(form, "title"), started_at: when ? new Date(when) : new Date(), organizer_email: v.email,
      attendees: parseAttendees(s(form, "attendees") ?? ""), summary: s(form, "notes"), transcript: s(form, "transcript"),
    });
    revalidatePath("/reuniones");
    return { ok: true, message: r.status === "matched" ? `Guardada y asociada: ${r.reason?.replace(/\.$/, "").toLowerCase()}.`
      : r.status === "ignored" ? "Guardada en «Descartadas»: solo había gente de tu equipo, así que no se guarda su contenido."
      : `Guardada en «Por asociar». ${r.reason ?? ""}` };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}
