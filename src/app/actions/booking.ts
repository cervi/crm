"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { book, saveBookingPage } from "@/lib/booking";
import { attempt, toUserMessage, type ActionState } from "@/lib/errors";

export type BookState = { error?: string; done?: { start: string; end: string; timezone: string; joinUrl: string | null } } | undefined;

/** Reserva desde la página pública (sin sesión: la página es para contactos). */
export async function bookAction(slug: string, _: BookState, form: FormData): Promise<BookState> {
  try {
    const r = await book(slug, Object.fromEntries(form));
    return { done: { start: r.start.toISOString(), end: r.end.toISOString(), timezone: r.timezone, joinUrl: r.joinUrl } };
  } catch (err) {
    return { error: toUserMessage(err) };
  }
}

export async function saveBookingPageAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await currentUser();
  if (!me || me.role === "viewer") return { error: "No tienes permiso para esto." };
  const res = await attempt(() => saveBookingPage(me, Object.fromEntries(form)));
  revalidatePath("/settings/booking");
  return res;
}
