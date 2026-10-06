import { runAutomations } from "./automations";
import { sendDueEmails } from "./emails";
import { importTick } from "./pipedrive-import";
import { processSequences } from "./sequences";
import { recomputeScores } from "./scoring";
import { applyAssignment } from "./assignment";
import { purgeTrash } from "./trash";
import { recomputeHealth } from "./health";
import { runCallExtraction, runMeetingPrep } from "./deal-agent";
import { runEnrichment, runQualification } from "./icp";
import { runCampaignPrepare, runCampaignReplies } from "./campaigns";
import { recomputeAccountHealth } from "./accounts";

/**
 * Revisión periódica completa: primero la importación de Pipedrive (si hay
 * una en marcha o toca la sincronización horaria), luego los correos
 * programados, las secuencias y, al final, correo, calendario y reglas de la IA.
 */
export async function runCycle() {
  await importTick().catch((err) => console.error("[importación pipedrive]", err));
  const scheduled = await sendDueEmails().catch((err) => { console.error("[correos programados]", err); return { sent: 0, failed: 0 }; });
  // Agente de captación: enriquecer las empresas nuevas y cualificar los leads con el perfil de cliente ideal.
  const enriched = await runEnrichment().catch((err) => { console.error("[enriquecimiento]", err); return null; });
  const qualified = await runQualification().catch((err) => { console.error("[cualificación]", err); return null; });
  // Puntuación de los leads y, con ella, el reparto de lo nuevo sin responsable.
  const scored = await recomputeScores().catch((err) => { console.error("[puntuación]", err); return 0; });
  const assigned = await applyAssignment().catch((err) => { console.error("[reparto]", err); return null; });
  await purgeTrash().catch((err) => console.error("[papelera]", err));
  // Agente de prospección: verificar y personalizar los contactos de campaña e inscribir los aprobados.
  const prepared_contacts = await runCampaignPrepare().catch((err) => { console.error("[campañas]", err); return null; });
  const sequences = await processSequences().catch((err) => { console.error("[secuencias]", err); return null; });
  const result = await runAutomations();
  // Respuestas a las campañas (ya sincronizadas con el correo).
  const replies = await runCampaignReplies().catch((err) => { console.error("[respuestas de campaña]", err); return null; });
  // Agente ejecutivo: lo extraído de las reuniones y la preparación de las próximas.
  const extracted = await runCallExtraction().catch((err) => { console.error("[extracción]", err); return null; });
  const prepared = await runMeetingPrep().catch((err) => { console.error("[preparación]", err); return null; });
  // Salud de los deals, con lo que acaba de entrar (correos, reuniones…).
  const health = await recomputeHealth().catch((err) => { console.error("[salud]", err); return 0; });
  // Salud de las cuentas de cliente (con la de sus onboardings y renovaciones).
  const accounts = await recomputeAccountHealth().catch((err) => { console.error("[salud de cuentas]", err); return 0; });
  return { ...result, scheduled, sequences, scored, assigned, health, accounts, agents: { enriched, qualified, prepared_contacts, replies, extracted, prepared } };
}
