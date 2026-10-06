import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { sql } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { saveSignalSettingsAction } from "@/app/actions/signals";

export const dynamic = "force-dynamic";
export const metadata = { title: "Señales y avisos" };

export default async function SignalSettingsPage() {
  await requireAdminPage();
  const [s] = await sql<{ open_alerts: "all" | "reopen" | "off"; competitors: string[] }[]>`SELECT open_alerts, competitors FROM app_settings LIMIT 1`;
  return (
    <main className="page" style={{ maxWidth: 820 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><div>
        <h1>Señales y avisos</h1>
        <p className="muted" style={{ margin: 0 }}>Cuándo te avisa el CRM de que un contacto lee tus correos y qué cuenta como señal de riesgo en la salud de los deals.</p>
      </div></div>
      <section className="panel">
        <ActionForm action={saveSignalSettingsAction} submitLabel="Guardar">
          <fieldset className="field">
            <legend className="label">Avisos de lectura de correos</legend>
            <label className="checkbox"><input type="radio" name="open_alerts" value="all" defaultChecked={s.open_alerts === "all"} /> Cuando lo abren por primera vez y cuando lo vuelven a abrir otro día</label>
            <label className="checkbox"><input type="radio" name="open_alerts" value="reopen" defaultChecked={s.open_alerts === "reopen"} /> Solo cuando lo vuelven a abrir otro día (suele ser señal de que se están decidiendo)</label>
            <label className="checkbox"><input type="radio" name="open_alerts" value="off" defaultChecked={s.open_alerts === "off"} /> Sin avisos (las aperturas siguen registrándose)</label>
            <span className="meta">El aviso llega a quien envió el correo, como mucho uno cada 12 horas por correo. Las propuestas avisan igual al abrirlas y al volver a abrirlas.</span>
          </fieldset>
          <label className="field"><span className="label">Competidores</span>
            <textarea name="competitors" rows={3} defaultValue={s.competitors.join(", ")} placeholder="Pipedrive, HubSpot, Salesforce…" />
            <span className="meta">Separados por comas. Si aparecen en correos recibidos, notas o transcripciones del último mes, la salud del deal lo marca como riesgo (igual que hablar de precio o de otro proveedor).</span>
          </label>
        </ActionForm>
      </section>
      <section className="panel">
        <h2>Cómo se calcula la salud</h2>
        <p className="muted">Cada deal abierto parte de 50. Restan: correos sin respuesta, parado en la fase, fecha de cierre pasada o movida varias veces, un solo contacto o sin decisor, ausencias, competidor o precio en la conversación, tareas vencidas y nada agendado. Suman: reunión agendada (o reservada por él), respuestas recientes y rápidas, propuesta abierta varias veces, correos abiertos desde varios dispositivos y un nuevo interlocutor directivo. Verde desde 65, ámbar de 40 a 64 y rojo por debajo de 40: al entrar en rojo se avisa al responsable.</p>
      </section>
    </main>
  );
}
