import Link from "next/link";
import { saveAutopilotAction, setPausedAction } from "@/app/actions/automations";
import { ActionForm } from "@/components/ActionForm";
import { ConfirmButton } from "@/components/ConfirmButton";
import { requireAdminPage } from "@/lib/auth";
import { autopilotStats, getAutopilot, listAutopilotLog } from "@/lib/autopilot";
import { sql } from "@/lib/db";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Piloto automático" };

const KIND: Record<string, string> = { next_step: "Siguiente paso", email_hot: "Correo muy abierto", doc_hot: "Documento muy abierto", sign_won: "Ganado al firmar", overdue: "Vencida" };

export default async function AutopilotPage() {
  await requireAdminPage();
  const [a, log, stats, [also]] = await Promise.all([
    getAutopilot(), listAutopilotLog(40), autopilotStats(),
    sql<{ jobs: number; jobs_on: number; rules_auto: number; rules_ask: number; seq: number; assign: number }[]>`
      SELECT (SELECT count(*)::int FROM agent_jobs) AS jobs, (SELECT count(*)::int FROM agent_jobs WHERE enabled) AS jobs_on,
             (SELECT count(*)::int FROM automation_rules WHERE autonomy = 'auto') AS rules_auto,
             (SELECT count(*)::int FROM automation_rules WHERE autonomy = 'ask') AS rules_ask,
             (SELECT count(*)::int FROM sequences WHERE is_active) AS seq,
             (SELECT count(*)::int FROM assignment_rules WHERE is_active) AS assign`.catch(() => [{ jobs: 0, jobs_on: 0, rules_auto: 0, rules_ask: 0, seq: 0, assign: 0 }]),
  ]);
  const Row = ({ name, on, title, text, children }: { name: string; on: boolean; title: string; text: string; children?: React.ReactNode }) => (
    <div className="ap-row">
      <label className="ap-toggle"><input type="checkbox" name={name} defaultChecked={on} aria-label={title} /><span className="ap-switch" aria-hidden="true" /></label>
      <div><strong>{title}</strong><p className="meta">{text}</p>{children && <div className="ap-params">{children}</div>}</div>
    </div>
  );
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Piloto automático</h1>
          <p className="muted" style={{ margin: 0 }}>Lo que el CRM hace solo para que ningún deal se quede parado. Sin reglas que montar: enciende lo que quieras.</p>
        </div>
        <div className="head-actions">
          {a.paused
            ? <form action={setPausedAction.bind(null, false)}><button className="btn">Reanudar todo</button></form>
            : <form action={setPausedAction.bind(null, true)}><ConfirmButton label="Pausar todo" className="btn secondary" confirm="Se para todo lo automático: piloto, agentes y automatizaciones." /></form>}
        </div>
      </div>
      {a.paused && <p className="callout bad">Está todo en pausa (también los agentes y las automatizaciones). Nada se hace solo hasta que lo reanudes.</p>}

      <section className="today-stats" aria-label="Resumen">
        <span className="today-stat"><span className="label">Hecho solo (7 días)</span><strong>{stats.week}</strong></span>
        <span className="today-stat"><span className="label">Hecho solo (30 días)</span><strong>{stats.month}</strong></span>
        <Link href="/agents" className="today-stat"><span className="label">Agentes trabajando</span><strong>{also.jobs_on}/{also.jobs}</strong></Link>
        <Link href="/settings/automations" className="today-stat"><span className="label">Reglas automáticas</span><strong>{also.rules_auto}</strong><span className="meta">+{also.rules_ask} que te preguntan</span></Link>
        <Link href="/sequences" className="today-stat"><span className="label">Secuencias activas</span><strong>{also.seq}</strong></Link>
      </section>

      <section className="panel" aria-label="Qué hace solo">
        <h2>Qué hace solo</h2>
        <ActionForm action={saveAutopilotAction} submitLabel="Guardar">
          <Row name="next_step" on={a.nextStep.on} title="Que ningún deal se quede sin siguiente paso"
               text="Si un deal abierto se queda sin nada programado, crea una tarea a su responsable para decidir cómo seguir (como mucho una cada 14 días por deal).">
            <label className="inline-field">Margen: <input type="number" name="next_step_days" min={0} max={30} defaultValue={a.nextStep.days} style={{ width: 70 }} /> días sin nada</label>
          </Row>
          <Row name="email_hot" on={a.emailHot.on} title="Llamar cuando abren un correo una y otra vez"
               text="Si alguien abre varias veces un correo tuyo en las últimas 48 h y no contesta, programa una llamada para dentro de media hora.">
            <label className="inline-field">A partir de <input type="number" name="email_hot_opens" min={2} max={20} defaultValue={a.emailHot.opens} style={{ width: 70 }} /> aperturas</label>
          </Row>
          <Row name="doc_hot" on={a.docHot.on} title="Llamar cuando miran un documento que les compartiste"
               text="Si un contacto abre varias veces un documento de la biblioteca o del deal, programa una llamada: está pensando en ello.">
            <label className="inline-field">A partir de <input type="number" name="doc_hot_views" min={1} max={20} defaultValue={a.docHot.views} style={{ width: 70 }} /> aperturas</label>
          </Row>
          <Row name="sign_won" on={a.signWon.on} title="Ganar el deal al firmar el contrato"
               text="Cuando todos firman un contrato enviado desde el deal, el deal pasa a ganado (y arranca el traspaso a Customer Success si lo tenéis)." />
          <Row name="overdue_nudge" on={a.overdueNudge.on} title="Avisar de lo que lleva días vencido"
               text="Un aviso al responsable cuando una actividad lleva varios días vencida (una sola vez por actividad).">
            <label className="inline-field">Tras <input type="number" name="overdue_days" min={1} max={30} defaultValue={a.overdueNudge.days} style={{ width: 70 }} /> días</label>
          </Row>
        </ActionForm>
        <p className="meta">Además, ya funcionan solos: el reparto de leads ({also.assign} regla{also.assign === 1 ? "" : "s"}), los recordatorios de firma, el aviso de correos sin respuesta, los resúmenes por correo y lo que hagan los <Link href="/agents">agentes</Link>.</p>
      </section>

      <section className="panel" aria-label="Lo último que ha hecho">
        <h2>Lo último que ha hecho</h2>
        {log.length === 0 ? <p className="muted">Todavía nada. Revisa cada pocos minutos; lo que haga aparecerá aquí.</p> : (
          <ol className="audit-list">
            {log.map((l) => (
              <li key={l.id}>
                <span className="meta nowrap">{dateTime(l.at)}</span>
                <span><strong>{KIND[l.kind] ?? l.kind}</strong> · {l.detail}{l.deal_id && <> · <Link href={`/deals/${l.deal_id}`}>{l.deal}</Link></>}</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
