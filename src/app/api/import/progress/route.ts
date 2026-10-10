import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { continueImport, runningJob, type ImportJob } from "@/lib/pipedrive-import";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Progreso de la importación de Pipedrive. Va por una ruta normal (no por una
// acción de servidor) para no bloquear la navegación mientras se importa.

const view = (job: ImportJob | null) => job && {
  status: job.status, step: job.step, counts: job.counts, error: job.error,
  total: Object.values(job.counts ?? {}).reduce((n, c) => n + (c.created ?? 0) + (c.updated ?? 0) + (c.skipped ?? 0), 0),
  quietFor: Math.round((Date.now() - new Date(job.updated_at).getTime()) / 1000),
};

/** Cómo va (cualquiera con sesión). */
export async function GET() {
  if (!(await currentUser())) return NextResponse.json(null, { status: 401 });
  return NextResponse.json(view(await runningJob()));
}

/** Avanzarla unos segundos (solo administradores). */
export async function POST() {
  const me = await currentUser();
  if (!me) return NextResponse.json(null, { status: 401 });
  if (me.role !== "admin") return NextResponse.json(view(await runningJob()));
  return NextResponse.json(view(await continueImport(5_000)));
}
