import { runAutomations } from "./automations";
import { importTick } from "./pipedrive-import";

/**
 * Revisión periódica completa: primero la importación de Pipedrive (si hay
 * una en marcha o toca la sincronización horaria), luego correo, calendario
 * y reglas de la IA.
 */
export async function runCycle() {
  await importTick().catch((err) => console.error("[importación pipedrive]", err));
  return runAutomations();
}
