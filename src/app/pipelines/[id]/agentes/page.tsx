import Link from "next/link";
import { notFound } from "next/navigation";
import { getPipeline, listStages } from "@/lib/pipelines";
import { listInstructions, type Instruction } from "@/lib/stage-agents";
import { aiReady, getAiSettings } from "@/lib/ai";
import { getSettings } from "@/lib/automations";
import { sql } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { isId } from "@/lib/validation";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { InstructionComposer } from "@/components/agents/InstructionComposer";
import { InstructionTester } from "@/components/agents/InstructionTester";
import { deleteInstructionAction, setInstructionAutonomyAction, updateInstructionAction } from "@/app/actions/stage-agents";

export const dynamic = "force-dynamic";
export const metadata = { title: "IA del pipeline" };

const AUTONOMY: { value: "ask" | "auto" | "off"; label: string }[] = [
  { value: "ask", label: "Preguntarme" }, { value: "auto", label: "Sola" }, { value: "off", label: "En pausa" },
];

/** Ejemplos según el momento del funnel. */
function examplesFor(stage: { name: string; position: number } | null, next: string | null, last: boolean): string[] {
  if (!stage) {
    return [
      "Si un deal lleva 7 días sin movimiento, crea una llamada de seguimiento para su responsable.",
      "Cuando el contacto responda un correo, avísame si pide precio o descuento.",
    ];
  }
  const n = stage.name.toLowerCase();
  const out: string[] = [];
  if (/(demo|reuni|cita|llamada|agend)/.test(n) || stage.position <= 2) out.push("Cuando un deal entre aquí, escríbele al contacto para agendar una reunión con los huecos de mi calendario.");
  if (next) out.push(`Muévelo a «${next}» si en las notas o correos ya han confirmado presupuesto y fecha.`);
  out.push("Si lleva 5 días sin respuesta, crea una llamada de seguimiento para hoy.");
  if (/(propuesta|oferta|presupuesto)/.test(n)) out.push("Cuando abran la propuesta, avísame para llamarles ese mismo día.");
  if (last) out.push("Si lleva 10 días aquí, avísame para decidir si lo damos por perdido.");
  return out.slice(0, 3);
}

function InstructionCard({ ins, deals, pipelineId }: { ins: Instruction; deals: { id: string; title: string }[]; pipelineId: string }) {
  return (
    <article className={`instr-card${ins.autonomy === "off" ? " paused" : ""}`} aria-label={`Instrucción: ${ins.text.slice(0, 60)}`}>
      <blockquote className="instr-text">{ins.text}</blockquote>
      <ul className="instr-rules">
        {ins.rules.map((r) => <li key={r.id}>{r.description}</li>)}
      </ul>
      {ins.doubts.length > 0 && <p className="meta tone-bad" style={{ margin: 0 }}>Dudas al entenderla: {ins.doubts.join(" · ")}</p>}
      <div className="instr-foot">
        <div className="seg" role="group" aria-label="Autonomía">
          {AUTONOMY.map((a) => (
            <form key={a.value} action={setInstructionAutonomyAction.bind(null, ins.id, a.value, pipelineId)}>
              <button type="submit" aria-pressed={ins.autonomy === a.value} className={ins.autonomy === a.value ? "on" : undefined}>{a.label}</button>
            </form>
          ))}
        </div>
        <span className="meta">
          {ins.stats.pending > 0 && <><Link href="/inbox">{ins.stats.pending} esperando tu decisión</Link> · </>}
          {ins.stats.done} hecha{ins.stats.done === 1 ? "" : "s"}{ins.stats.last_at ? ` · última ${dateTime(ins.stats.last_at)}` : ""}
          {ins.compiled_by === "rules" ? " · entendida sin IA" : ""}{ins.author ? ` · ${ins.author}` : ""}
        </span>
      </div>
      <details>
        <summary className="meta">Probar con un deal</summary>
        <InstructionTester id={ins.id} deals={deals} />
      </details>
      <details>
        <summary className="meta">Cambiar o borrar</summary>
        <ActionForm action={updateInstructionAction.bind(null, ins.id, pipelineId)} submitLabel="Volver a entender y guardar" secondary>
          <textarea name="text" rows={3} defaultValue={ins.text} aria-label="Texto de la instrucción" />
        </ActionForm>
        <form action={deleteInstructionAction.bind(null, ins.id, pipelineId)}><button type="submit" className="link-btn meta tone-bad">Borrar esta instrucción</button></form>
      </details>
    </article>
  );
}

export default async function PipelineAgentsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fase?: string }> }) {
  const [{ id }, { fase }] = await Promise.all([params, searchParams]);
  if (!isId(id)) notFound();
  await requireUser();
  const pipeline = await getPipeline(id);
  if (!pipeline) notFound();
  const [stages, instructions, ai, settings, deals] = await Promise.all([
    listStages(id), listInstructions({ pipelineId: id }), getAiSettings(), getSettings(),
    sql<{ id: string; title: string; stage_id: string }[]>`
      SELECT id, title, stage_id FROM deals WHERE pipeline_id = ${id} AND status = 'open' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 400`,
  ]);
  const ready = aiReady(ai);
  const pipelineWide = instructions.filter((i) => i.pipeline_id === id && !i.stage_id);
  const global = instructions.filter((i) => !i.pipeline_id);
  const allDeals = deals.map((d) => ({ id: d.id, title: d.title }));

  return (
    <main className="page">
      <div className="crumbs"><Link href={`/pipelines/${id}`}>{pipeline.name}</Link></div>
      <div className="page-head">
        <div>
          <h1><Icon name="spark" /> La IA en «{pipeline.name}»</h1>
          <p className="muted" style={{ margin: 0 }}>
            Escribe en cada fase, como se lo dirías a alguien del equipo, qué tiene que hacer la IA con los deals: cuándo, en qué casos y qué hacer.
            Antes de activarlo te enseña cómo lo ha entendido. Puede preguntarte antes de cada acción (en la <Link href="/inbox">bandeja</Link>) o hacerlo sola;
            todo queda en el registro y se puede deshacer.
          </p>
        </div>
      </div>
      {settings.paused && <p className="callout">La IA está en pausa: las instrucciones no actuarán hasta que la reanudes en <Link href="/agents">Agentes</Link>.</p>}
      {!ready && <p className="callout">Sin IA configurada, solo funcionan instrucciones sencillas sin condiciones. <Link href="/settings/ai">Configurar la IA</Link></p>}

      <section className="instr-stage pipeline-wide" id="fase-todas" aria-label="En todo el pipeline">
        <div className="instr-stage-head"><h2>En todo el pipeline</h2><span className="meta">vale para cualquier fase</span></div>
        {pipelineWide.map((ins) => <InstructionCard key={ins.id} ins={ins} deals={allDeals} pipelineId={id} />)}
        <details open={pipelineWide.length === 0 && !fase}>
          <summary className="meta">+ Nueva instrucción para todo el pipeline</summary>
          <InstructionComposer scope={{ pipelineId: id, stageId: null }} where="de este pipeline" examples={examplesFor(null, null, false)} aiReady={ready} />
        </details>
      </section>

      <ol className="instr-funnel">
        {stages.map((st, i) => {
          const own = instructions.filter((x) => x.stage_id === st.id);
          const stageDeals = deals.filter((d) => d.stage_id === st.id).map((d) => ({ id: d.id, title: d.title }));
          return (
            <li key={st.id} className={`instr-stage${fase === st.id ? " focus" : ""}`} id={`fase-${st.id}`} aria-label={`Fase ${st.name}`}>
              <div className="instr-stage-head">
                <h2><span className="step-n">{i + 1}</span>{st.name}</h2>
                <span className="meta">{st.deals} deal{st.deals === 1 ? "" : "s"}{own.length ? ` · ${own.length} instrucci${own.length === 1 ? "ón" : "ones"}` : ""}</span>
              </div>
              {own.map((ins) => <InstructionCard key={ins.id} ins={ins} deals={stageDeals} pipelineId={id} />)}
              <details open={fase === st.id}>
                <summary className="meta">+ Nueva instrucción para «{st.name}»</summary>
                <InstructionComposer scope={{ pipelineId: id, stageId: st.id }} where={`en «${st.name}»`}
                                     examples={examplesFor(st, stages[i + 1]?.name ?? null, i === stages.length - 1)} aiReady={ready} />
              </details>
            </li>
          );
        })}
      </ol>

      {global.length > 0 && (
        <section className="instr-stage" aria-label="En todos los pipelines">
          <div className="instr-stage-head"><h2>En todos los pipelines</h2></div>
          {global.map((ins) => <InstructionCard key={ins.id} ins={ins} deals={allDeals} pipelineId={id} />)}
        </section>
      )}
    </main>
  );
}
