"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql } from "@/lib/db";
import { attempt, UserError, type ActionState } from "@/lib/errors";
import { addStage, createPipeline, deleteStage, moveStage, updatePipeline, updateStage } from "@/lib/pipelines";
import { FIELD_TYPES, parseOptions, slugifyKey, type FieldType } from "@/lib/custom-fields";
import { checkbox, optional, optText, parse, text } from "@/lib/validation";

const fields = (form: FormData) => Object.fromEntries(form);

// ---------------------------------------------------------------- Pipelines

export async function createPipelineAction(_: ActionState, form: FormData): Promise<ActionState> {
  let id = "";
  const res = await attempt(async () => { id = await createPipeline({ ...fields(form), is_active: "on" }); });
  if (res?.error) return res;
  revalidatePath("/", "layout");
  redirect(`/settings/pipelines/${id}`);
}

export async function updatePipelineAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => updatePipeline(id, fields(form)));
  revalidatePath("/", "layout");
  return res;
}

export async function addStageAction(pipelineId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => addStage(pipelineId, fields(form)));
  revalidatePath("/", "layout");
  return res;
}

export async function updateStageAction(stageId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(() => updateStage(stageId, fields(form)));
  revalidatePath("/", "layout");
  return res;
}

export async function moveStageAction(stageId: string, direction: "up" | "down"): Promise<void> {
  await moveStage(stageId, direction);
  revalidatePath("/", "layout");
}

export async function deleteStageAction(stageId: string, _: ActionState): Promise<ActionState> {
  const res = await attempt(() => deleteStage(stageId));
  revalidatePath("/", "layout");
  return res;
}

// ---------------------------------------------------------------- Campos personalizados

const fieldTypes = FIELD_TYPES.map((t) => t.value) as [FieldType, ...FieldType[]];

export async function createFieldAction(_: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => {
    const v = parse(z.object({
      entity_type: z.enum(["organization", "person", "lead", "deal"]),
      label: text("El nombre", 100),
      field_type: z.enum(fieldTypes, { message: "Tipo de campo no válido" }),
      options: optText(5000),
      is_required: checkbox,
    }), fields(form));
    const isOption = v.field_type === "single_option" || v.field_type === "multi_option";
    const options = isOption ? parseOptions(v.options ?? "") : null;
    if (isOption && !options?.length) throw new UserError("Añade al menos una opción (una por línea).");
    const [{ next }] = await sql<{ next: number }[]>`
      SELECT coalesce(max(position), 0) + 1 AS next FROM custom_field_definitions WHERE entity_type = ${v.entity_type}`;
    await sql`
      INSERT INTO custom_field_definitions (entity_type, key, label, field_type, options, is_required, position)
      VALUES (${v.entity_type}, ${slugifyKey(v.label)}, ${v.label}, ${v.field_type},
              ${options ? sql.json(options) : null}, ${v.is_required}, ${next})`;
  });
  revalidatePath("/", "layout");
  return res;
}

export async function updateFieldAction(fieldId: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => {
    const v = parse(z.object({
      label: text("El nombre", 100),
      options: optText(5000),
      is_required: checkbox,
      is_archived: checkbox,
    }), fields(form));
    const [def] = await sql<{ field_type: string; options: { key: string; label: string }[] | null }[]>`
      SELECT field_type, options FROM custom_field_definitions WHERE id = ${fieldId}`;
    if (!def) throw new UserError("El campo no existe.");
    let options = def.options;
    if (def.field_type === "single_option" || def.field_type === "multi_option") {
      // Las opciones existentes conservan su clave (los valores guardados siguen siendo válidos).
      const labels = (v.options ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (!labels.length) throw new UserError("Añade al menos una opción.");
      const byLabel = new Map((def.options ?? []).map((o) => [o.label.toLowerCase(), o.key]));
      const fresh = parseOptions(labels.filter((l) => !byLabel.has(l.toLowerCase())).join("\n"));
      const used = new Set((def.options ?? []).map((o) => o.key));
      options = labels.map((label) => {
        const existing = byLabel.get(label.toLowerCase());
        if (existing) return { key: existing, label };
        const o = fresh.shift()!;
        let key = o.key;
        while (used.has(key)) key = `${key}_2`;
        used.add(key);
        return { key, label };
      });
    }
    await sql`
      UPDATE custom_field_definitions
      SET label = ${v.label}, is_required = ${v.is_required}, is_archived = ${v.is_archived},
          options = ${options ? sql.json(options) : null}
      WHERE id = ${fieldId}`;
  });
  revalidatePath("/", "layout");
  return res;
}

// ---------------------------------------------------------------- Motivos de pérdida

const reasonSchema = z.object({
  label: text("El motivo", 200),
  followup_days: optional(z.coerce.number().int().min(1, "Los días deben ser 1 o más").max(3650)),
  is_active: checkbox,
});

export async function createLostReasonAction(_: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => {
    const v = parse(reasonSchema, { ...fields(form), is_active: "on" });
    await sql`INSERT INTO lost_reasons (label, followup_days) VALUES (${v.label}, ${v.followup_days ?? null})`;
  });
  revalidatePath("/settings/lost-reasons");
  return res;
}

export async function updateLostReasonAction(id: string, _: ActionState, form: FormData): Promise<ActionState> {
  const res = await attempt(async () => {
    const v = parse(reasonSchema, fields(form));
    await sql`UPDATE lost_reasons SET label = ${v.label}, followup_days = ${v.followup_days ?? null},
              is_active = ${v.is_active} WHERE id = ${id}`;
  });
  revalidatePath("/settings/lost-reasons");
  return res;
}
