import { runAutomations } from "./automations";
import { sendDueEmails } from "./emails";
import { importTick } from "./pipedrive-import";

/**
 * Revisión periódica completa: primero la importación de Pipedrive (si hay
 * una en marcha o toca la sincronización horaria), luego los correos
 * programados y, al final, correo, calendario y reglas de la IA.
 */
export async function runCycle() {
  await importTick().catch((err) => console.error("[importación pipedrive]", err));
  const scheduled = await sendDueEmails().catch((err) => { console.error("[correos programados]", err); return { sent: 0, failed: 0 }; });
  return { ...(await runAutomations()), scheduled };
}
