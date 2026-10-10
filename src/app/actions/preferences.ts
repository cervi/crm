"use server";

import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { connectionOf, sendPlainEmail } from "@/lib/mailbox";
import { savePrefs } from "@/lib/notification-prefs";
import { teamWeekEmail, weekPlanEmail, weekReviewEmail } from "@/lib/notification-mail";
import { saveNavPrefs } from "@/lib/nav-prefs";
import type { NavPrefs } from "@/lib/nav-items";

const expired = { error: "Tu sesión ha caducado: vuelve a entrar." };

export async function saveNotificationPrefsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await currentUser();
  if (!me) return expired;
  const res = await attempt(() => savePrefs(me.id, Object.fromEntries(form)));
  revalidatePath("/account");
  return res;
}

/** Envía ahora un resumen a tu correo, para ver cómo es. */
export async function sendSummaryNowAction(kind: "week_plan" | "week_review" | "team_week", _: ActionState): Promise<ActionState> {
  const me = await currentUser();
  if (!me) return expired;
  let to = "";
  const res = await attempt(async () => {
    const conn = await connectionOf(me.id);
    if (!conn || conn.status !== "active") throw new UserError("Para recibir resúmenes por correo, conecta tu cuenta en Ajustes → Correo, calendario y documentos.");
    if (kind === "team_week" && me.role !== "admin") throw new UserError("El resumen del equipo es para administradores.");
    const m = kind === "week_plan" ? await weekPlanEmail(me.id) : kind === "week_review" ? await weekReviewEmail(me.id) : await teamWeekEmail();
    await sendPlainEmail(conn, conn.email, m.subject, m.body);
    to = conn.email;
  });
  return res?.ok ? { ok: true, message: `Enviado a ${to}.` } : res;
}

export async function saveNavPrefsAction(prefs: NavPrefs | null): Promise<ActionState> {
  const me = await currentUser();
  if (!me) return expired;
  const res = await attempt(() => saveNavPrefs(me.id, prefs));
  revalidatePath("/", "layout");
  return res;
}
