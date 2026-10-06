import { sql } from "./db";

// ===========================================================================
// Trabajos de los agentes que no son propuestas (preparar reuniones, extraer
// lo importante de una llamada, cualificar leads…): cada uno con su
// interruptor y sus parámetros. Las acciones con autonomía (crear tareas,
// enviar correos…) siguen siendo reglas de automatizaciones.
// ===========================================================================

export type AgentKey = "captacion" | "prospeccion" | "ejecutivo" | "riesgo" | "onboarding" | "cuenta";

export const AGENT_INFO: Record<AgentKey, { name: string; goal: string }> = {
  captacion: { name: "Captación", goal: "Que ningún contacto interesado se pierda" },
  prospeccion: { name: "Prospección (outbound)", goal: "Llenar el pipeline con cuentas que encajan" },
  ejecutivo: { name: "Ejecutivo de deal", goal: "Mover cada deal al siguiente paso" },
  riesgo: { name: "Riesgo y forecast", goal: "Que nada se cierre ni se pierda por sorpresa" },
  onboarding: { name: "Onboarding (CS)", goal: "Que el cliente arranque rápido y bien" },
  cuenta: { name: "Cuenta y expansión (CS)", goal: "Retener y crecer cada cuenta" },
};
export const AGENT_KEYS = Object.keys(AGENT_INFO) as AgentKey[];

export type AgentJob = {
  key: string; agent: AgentKey; name: string; description: string; enabled: boolean; params: Record<string, unknown>;
  position: number; last_run_at: Date | null; last_result: string | null;
};

export const listJobs = () => sql<AgentJob[]>`SELECT * FROM agent_jobs ORDER BY agent, position, name`;

export async function getJob(key: string): Promise<AgentJob | null> {
  const [j] = await sql<AgentJob[]>`SELECT * FROM agent_jobs WHERE key = ${key}`;
  return j ?? null;
}

export async function setJobEnabled(key: string, enabled: boolean) {
  await sql`UPDATE agent_jobs SET enabled = ${enabled} WHERE key = ${key}`;
}

export async function setJobParams(key: string, params: Record<string, unknown>) {
  await sql`UPDATE agent_jobs SET params = params || ${sql.json(params as never)} WHERE key = ${key}`;
}

/** Ejecuta un trabajo si está activo y deja constancia de cuándo y qué hizo. */
export async function runJob(key: string, fn: (params: Record<string, unknown>) => Promise<string | number | null>): Promise<string | number | null> {
  const job = await getJob(key);
  if (!job?.enabled) return null;
  // «Pausar todo» en Automatizaciones también para a los agentes.
  const [st] = await sql<{ paused: boolean }[]>`SELECT paused FROM automation_settings`;
  if (st?.paused) return null;
  try {
    const r = await fn(job.params);
    await sql`UPDATE agent_jobs SET last_run_at = now(), last_result = ${r === null ? null : String(r)} WHERE key = ${key}`;
    return r;
  } catch (err) {
    console.error(`[agente] ${key}`, err);
    await sql`UPDATE agent_jobs SET last_run_at = now(), last_result = ${`Error: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`} WHERE key = ${key}`;
    return null;
  }
}

export const param = (p: Record<string, unknown>, k: string, fallback: number) => {
  const v = Number(p[k]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};
