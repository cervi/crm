"use server";

import { adminOnly, guard } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/errors";
import {
  cancelImport, connectPipedrive, continueImport, disconnectPipedrive, setPipedriveSync, startImport, type ImportJob,
} from "@/lib/pipedrive-import";

const refresh = () => revalidatePath("/settings/import");

export async function connectPipedriveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => connectPipedrive(String(form.get("token") ?? "")));
  refresh();
  return res;
}

export async function disconnectPipedriveAction(_: ActionState): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => disconnectPipedrive());
  refresh();
  return res;
}

export async function startImportAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => startImport({ flow: form.get("flow") === "on", files: form.get("files") === "on" }));
  refresh();
  return res;
}

export async function setPipedriveSyncAction(on: boolean): Promise<void> {
  await adminOnly();
  await setPipedriveSync(on);
  refresh();
}

export async function cancelImportAction(jobId: string, _: ActionState): Promise<ActionState> {
  const g = await guard("admin");
  if ("error" in g) return g;
  const res = await attempt(() => cancelImport(jobId));
  refresh();
  return res;
}

/** Avanza la importación unos segundos; la pantalla lo llama en bucle mientras está abierta. */
export async function continueImportAction(): Promise<Pick<ImportJob, "status" | "step" | "counts" | "error"> | null> {
  await adminOnly();
  const job = await continueImport(12_000);
  return job ? { status: job.status, step: job.step, counts: job.counts, error: job.error } : null;
}
