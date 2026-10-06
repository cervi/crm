import { runAutomations } from "./automations";
import { sendDueEmails } from "./emails";
import { importTick } from "./pipedrive-import";
import { processSequences } from "./sequences";
import { recomputeScores } from "./scoring";
import { applyAssignment } from "./assignment";
import { purgeTrash } from "./trash";

/**
 * Revisión periódica completa: primero la importación de Pipedrive (si hay
 * una en marcha o toca la sincronización horaria), luego los correos
 * programados, las secuencias y, al final, correo, calendario y reglas de la IA.
 */
export async function runCycle() {
  await importTick().catch((err) => console.error("[importación pipedrive]", err));
  const scheduled = await sendDueEmails().catch((err) => { console.error("[correos programados]", err); return { sent: 0, failed: 0 }; });
  // Puntuación de los leads y, con ella, el reparto de lo nuevo sin responsable.
  const scored = await recomputeScores().catch((err) => { console.error("[puntuación]", err); return 0; });
  const assigned = await applyAssignment().catch((err) => { console.error("[reparto]", err); return null; });
  await purgeTrash().catch((err) => console.error("[papelera]", err));
  const sequences = await processSequences().catch((err) => { console.error("[secuencias]", err); return null; });
  return { ...(await runAutomations()), scheduled, sequences, scored, assigned };
}
