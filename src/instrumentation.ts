/**
 * Al arrancar el servidor: revisa las automatizaciones cada
 * AUTOMATIONS_INTERVAL_MINUTES minutos (15 por defecto; 0 lo desactiva).
 * En alojamientos sin procesos permanentes se usa el cron de
 * /api/v1/automations/run. Si hay varias instancias, un bloqueo en la base de
 * datos evita que dos revisen a la vez.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const minutes = Number(process.env.AUTOMATIONS_INTERVAL_MINUTES ?? 15);
  if (!(minutes > 0)) return;
  const { runCycle } = await import("./lib/cycle");
  const tick = () => {
    runCycle().catch((err) => console.error("[automatizaciones]", err));
  };
  setTimeout(tick, 30_000).unref();
  setInterval(tick, minutes * 60_000).unref();
}
