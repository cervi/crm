"use server";

import { adminOnly, currentUser, guard } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { attempt, type ActionState } from "@/lib/errors";
import {
  cancelImport, connectPipedrive, continueImport, disconnectPipedrive, runningJob, setPipedriveSync, startImport, type ImportJob,
} from "@/lib/pipedrive-import";

const refresh = () => revalidatePath("/settings/import");

export async function connectPipedriveAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin", { duringImport: true });
  if ("error" in g) return g;
  const res = await attempt(() => connectPipedrive(String(form.get("token") ?? "")));
  refresh();
  return res;
}

export async function disconnectPipedriveAction(_: ActionState): Promise<ActionState> {
  const g = await guard("admin", { duringImport: true });
  if ("error" in g) return g;
  const res = await attempt(() => disconnectPipedrive());
  refresh();
  return res;
}

export async function startImportAction(_: ActionState, form: FormData): Promise<ActionState> {
  const g = await guard("admin", { duringImport: true });
  if ("error" in g) return g;
  const res = await attempt(() => startImport({ flow: form.get("flow") === "on", files: form.get("files") === "on" }));
  refresh();
  return res;
}

export async function setPipedriveSyncAction(on: boolean): Promise<void> {
  await adminOnly({ duringImport: true });
  await setPipedriveSync(on);
  refresh();
}

export async function cancelImportAction(jobId: string, _: ActionState): Promise<ActionState> {
  const g = await guard("admin", { duringImport: true });
  if ("error" in g) return g;
  const res = await attempt(() => cancelImport(jobId));
  refresh();
  return res;
}

/** Avanza la importación unos segundos; la pantalla lo llama en bucle mientras está abierta. */
export async function continueImportAction(): Promise<(Pick<ImportJob, "status" | "step" | "counts" | "error"> & { quietFor: number }) | null> {
  await adminOnly({ duringImport: true });
  const job = await continueImport(12_000);
  return job ? { status: job.status, step: job.step, counts: job.counts, error: job.error, quietFor: Math.round((Date.now() - new Date(job.updated_at).getTime()) / 1000) } : null;
}

/** Para el aviso que se ve en todas las pantallas: un administrador además la hace avanzar. */
export async function importBannerAction(drive: boolean): Promise<{ status: string; step: string; total: number; quietFor: number } | null> {
  const user = await currentUser();
  if (!user) return null;
  const job = drive && user.role === "admin" ? await continueImport(8_000) : await runningJob();
  if (!job) return null;
  const total = Object.values(job.counts ?? {}).reduce((n, c) => n + (c.created ?? 0) + (c.updated ?? 0) + (c.skipped ?? 0), 0);
  return { status: job.status, step: job.step, total, quietFor: Math.round((Date.now() - new Date(job.updated_at).getTime()) / 1000) };
}
