import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listSequencesFull, teamAnalytics } from "@/lib/sequence-reports";
import { STEP_KINDS } from "@/lib/step-kinds";

export const dynamic = "force-dynamic";
export const metadata = { title: "Analítica de secuencias" };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");
const RANGES = [["30", "30 días"], ["90", "90 días"], ["180", "6 meses"]] as const;

/** Analítica del equipo (como «Sequences › Analytics» en Apollo). */
export default async function SequenceAnalyticsPage({ searchParams }: { searchParams: Promise<{ dias?: string }> }) {
  await requireUser();
  const days = Number((await searchParams).dias) || 90;
  const [{ weeks, byUser, steps }, sequences] = await Promise.all([teamAnalytics(days), listSequencesFull({})]);
  const ranked = sequences.filter((s) => s.delivered >= 5).sort((a, b) => b.replied / b.delivered - a.replied / a.delivered).slice(0, 10);
  const maxRate = Math.max(0.01, ...weeks.map((w) => (w.sent ? w.replied / w.sent : 0)));
  return (
    <main className="page">
      <div className="crumbs"><Link href="/sequences">Secuencias</Link></div>
      <div className="page-head">
        <div><h1>Analítica de secuencias</h1><p className="muted" style={{ margin: 0 }}>Qué secuencias, pasos y personas consiguen respuestas.</p></div>
        <nav className="chips" aria-label="Periodo">
          {RANGES.map(([d, l]) => <Link key={d} href={`/sequences/analitica?dias=${d}`} aria-current={String(days) === d ? "page" : undefined}>{l}</Link>)}
        </nav>
      </div>

      <section className="panel" aria-label="Tasa de respuesta por semana">
        <h2>Tasa de respuesta por semana</h2>
        {weeks.length === 0 ? <p className="muted">Aún no ha salido ningún correo de secuencias en este periodo.</p> : (
          <div className="week-bars" role="img" aria-label="Respuestas sobre correos enviados, por semana">
            {weeks.map((w) => {
              const rate = w.sent ? w.replied / w.sent : 0;
              return (
                <div key={w.week} className="week-bar" title={`Semana del ${w.week}: ${w.sent} enviados, ${w.replied} respondidos (${pct(w.replied, w.sent)})`}>
                  <span className="meta">{pct(w.replied, w.sent)}</span>
                  <span className="bar"><span style={{ height: `${Math.max(2, Math.round((rate / maxRate) * 100))}%` }} /></span>
                  <span className="meta">{w.week.slice(5).split("-").reverse().join("/")}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid-2">
        <section className="panel" aria-label="Secuencias que mejor funcionan">
          <h2>Las que mejor funcionan</h2>
          {ranked.length === 0 ? <p className="muted">Hace falta que a cada secuencia le lleguen al menos 5 correos.</p> : (
            <div className="table-wrap flat"><table>
              <thead><tr><th>Secuencia</th><th className="num">Entregados</th><th className="num">Abiertos</th><th className="num">Respondieron</th><th className="num">Interesados</th></tr></thead>
              <tbody>{ranked.map((s) => (
                <tr key={s.id}><td><Link href={`/sequences/${s.id}`}>{s.name}</Link></td><td className="num">{s.delivered}</td><td className="num">{pct(s.opened, s.delivered)}</td>
                  <td className="num"><strong>{pct(s.replied, s.delivered)}</strong></td><td className="num">{pct(s.interested, s.delivered)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
        <section className="panel" aria-label="Pasos con más aperturas">
          <h2>Pasos con más aperturas</h2>
          {steps.length === 0 ? <p className="muted">Sin datos suficientes todavía.</p> : (
            <div className="table-wrap flat"><table>
              <thead><tr><th>Paso</th><th className="num">Enviados</th><th className="num">Abiertos</th><th className="num">Respuestas</th></tr></thead>
              <tbody>{steps.map((s) => (
                <tr key={`${s.sequence_id}-${s.position}`}><td><Link href={`/sequences/${s.sequence_id}?tab=pasos`}>{s.sequence}</Link>
                  <div className="meta">{s.position}. {STEP_KINDS[s.kind as keyof typeof STEP_KINDS]?.short ?? s.kind}{s.subject ? ` · ${s.subject}` : ""}</div></td>
                  <td className="num">{s.sent}</td><td className="num">{pct(s.opened, s.sent)}</td><td className="num">{pct(s.replied, s.sent)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </div>

      <section className="panel" aria-label="Por persona">
        <h2>Por persona</h2>
        <div className="table-wrap flat"><table>
          <thead><tr><th>Persona</th><th className="num">Contactos añadidos</th><th className="num">Correos enviados</th><th className="num">Respondieron</th><th className="num">Interesados</th><th className="num">Tareas hechas</th></tr></thead>
          <tbody>{byUser.filter((u) => u.enrolled || u.sent || u.tasks_done).map((u) => (
            <tr key={u.name}><td>{u.name}</td><td className="num">{u.enrolled}</td><td className="num">{u.sent}</td><td className="num">{u.replied} <span className="meta">{pct(u.replied, u.enrolled)}</span></td>
              <td className="num">{u.interested}</td><td className="num">{u.tasks_done}</td></tr>
          ))}</tbody>
        </table></div>
      </section>
    </main>
  );
}
