"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/lib/auth";
import { sql } from "@/lib/db";
import { attempt, UserError, type ActionState } from "@/lib/errors";

export async function saveSignalSettingsAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  return attempt(async () => {
    const mode = String(form.get("open_alerts") ?? "all");
    if (!["all", "reopen", "off"].includes(mode)) throw new UserError("Opción no válida.");
    const competitors = [...new Set(String(form.get("competitors") ?? "").split(/[,\n]/).map((c) => c.trim()).filter((c) => c.length >= 2))].slice(0, 50).map((c) => c.slice(0, 60));
    await sql`UPDATE app_settings SET open_alerts = ${mode}, competitors = ${competitors}::text[]`;
    revalidatePath("/settings/signals");
  });
}
