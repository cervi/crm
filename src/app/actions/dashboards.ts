"use server";

import { guard, writer } from "@/lib/auth";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql, transaction } from "@/lib/db";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { normalizeConfig } from "@/lib/analytics";
import { parse, text } from "@/lib/validation";

export async function createDashboardAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  let id = "";
  const res = await attempt(async () => {
    const { name } = parse(z.object({ name: text("El nombre", 100) }), Object.fromEntries(form));
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO dashboards (name, position)
      SELECT ${name}, coalesce(max(position), 0) + 1 FROM dashboards RETURNING id`;
    id = row.id;
  });
  if (res?.error) return res;
  revalidatePath("/dashboards", "layout");
  redirect(`/dashboards/${id}`);
}

export async function renameDashboardAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(async () => {
    const { name } = parse(z.object({ name: text("El nombre", 100) }), Object.fromEntries(form));
    await sql`UPDATE dashboards SET name = ${name} WHERE id = ${id}`;
  });
  revalidatePath("/dashboards", "layout");
  return res;
}

export async function deleteDashboardAction(id: string, _: ActionState): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(() => sql`DELETE FROM dashboards WHERE id = ${id}`);
  if (res?.error) return res;
  revalidatePath("/dashboards", "layout");
  redirect("/dashboards");
}

/** Crea o actualiza un widget. La configuración llega como JSON del editor y se valida aquí. */
export async function saveWidgetAction(dashboardId: string, widgetId: string | null, _: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("write");
  if ("error" in g) return g;
  const res = await attempt(async () => {
    const v = parse(z.object({
      title: text("El título", 120),
      width: z.enum(["1", "2"]),
      config: z.string().min(2),
    }), Object.fromEntries(form));
    let raw: unknown;
    try { raw = JSON.parse(v.config); } catch { throw new UserError("Configuración no válida."); }
    const config = await normalizeConfig(raw);
    if (widgetId) {
      await sql`UPDATE dashboard_widgets SET title = ${v.title}, width = ${Number(v.width)}, config = ${sql.json(config)}
                WHERE id = ${widgetId} AND dashboard_id = ${dashboardId}`;
    } else {
      await sql`INSERT INTO dashboard_widgets (dashboard_id, title, width, config, position)
                SELECT ${dashboardId}, ${v.title}, ${Number(v.width)}, ${sql.json(config)}, coalesce(max(position), 0) + 1
                FROM dashboard_widgets WHERE dashboard_id = ${dashboardId}`;
    }
  });
  if (res?.error) return res;
  revalidatePath(`/dashboards/${dashboardId}`);
  redirect(`/dashboards/${dashboardId}`);
}

export async function deleteWidgetAction(dashboardId: string, widgetId: string): Promise<void> {
  await writer();
  await sql`DELETE FROM dashboard_widgets WHERE id = ${widgetId} AND dashboard_id = ${dashboardId}`;
  revalidatePath(`/dashboards/${dashboardId}`);
}

/** Mueve un widget una posición antes o después. */
export async function moveWidgetAction(dashboardId: string, widgetId: string, direction: "up" | "down"): Promise<void> {
  await writer();
  await transaction(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      SELECT id FROM dashboard_widgets WHERE dashboard_id = ${dashboardId} ORDER BY position, created_at`;
    const i = rows.findIndex((r) => r.id === widgetId);
    const j = direction === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rows.length) return;
    [rows[i], rows[j]] = [rows[j], rows[i]];
    for (const [pos, r] of rows.entries()) {
      await tx`UPDATE dashboard_widgets SET position = ${pos + 1} WHERE id = ${r.id}`;
    }
  });
  revalidatePath(`/dashboards/${dashboardId}`);
}
