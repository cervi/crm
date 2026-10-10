import Link from "next/link";
import { ConfirmButton } from "@/components/ConfirmButton";
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
        <form action={deleteInstructionAction.bind(null, ins.id, pipelineId)}><ConfirmButton label="Borrar esta instrucción" className="link-btn meta tone-bad" confirm="La IA deja de hacerlo y se descartan sus propuestas pendientes." /></form>
      </details>
    </article>
  );
}

type Scope = { key: string; kind: "pipeline" | "stage" | "global"; name: string; n?: number; deals?: number; stageId?: string; index?: number };

/** Estado de un grupo de instrucciones: activa sola, pregunta, en pausa o vacío. */
function scopeState(list: Instruction[]): "auto" | "ask" | "off" | "none" {
  if (list.length === 0) return "none";
  if (list.some((i) => i.autonomy === "auto")) return "auto";
  if (list.some((i) => i.autonomy === "ask")) return "ask";
  return "off";
}
const STATE_LABEL = { auto: "Actúa sola", ask: "Te pregunta", off: "En pausa", none: "Sin instrucciones" } as const;

export default async function PipelineAgentsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ fase?: string }> }) {
  const [{ id }, { fase }] = await Promise.all([params, searchParams]);
  if (!isId(id)) notFound();
  await requireUser();
  const pipeline = await getPipeline(id);
  if (!pipeline) notFound();
  const [stages, instructions, ai, settings, deals, openCounts] = await Promise.all([
    listStages(id), listInstructions({ pipelineId: id }), getAiSettings(), getSettings(),
    sql<{ id: string; title: string; stage_id: string }[]>`
      SELECT id, title, stage_id FROM deals WHERE pipeline_id = ${id} AND status = 'open' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 400`,
    sql<{ stage_id: string; n: number }[]>`
      SELECT stage_id, count(*)::int AS n FROM deals WHERE pipeline_id = ${id} AND status = 'open' AND deleted_at IS NULL GROUP BY stage_id`,
  ]);
  const ready = aiReady(ai);
  const open = new Map(openCounts.map((r) => [r.stage_id, r.n]));
  const pipelineWide = instructions.filter((i) => i.pipeline_id === id && !i.stage_id);
  const global = instructions.filter((i) => !i.pipeline_id);
  const allDeals = deals.map((d) => ({ id: d.id, title: d.title }));
  const totalOpen = openCounts.reduce((n, r) => n + r.n, 0);

  const scopes: Scope[] = [
    { key: "todas", kind: "pipeline", name: "Todo el pipeline", deals: totalOpen },
    ...stages.map((st, i) => ({ key: st.id, kind: "stage" as const, name: st.name, deals: open.get(st.id) ?? 0, stageId: st.id, index: i })),
    ...(global.length ? [{ key: "global", kind: "global" as const, name: "Todos los pipelines" }] : []),
  ];
  const listFor = (sc: Scope) => sc.kind === "pipeline" ? pipelineWide : sc.kind === "global" ? global : instructions.filter((x) => x.stage_id === sc.stageId);
  const firstWithRules = scopes.find((sc) => sc.kind === "stage" && listFor(sc).length > 0);
  const current = scopes.find((sc) => sc.key === fase) ?? firstWithRules ?? scopes[1] ?? scopes[0];
  const own = listFor(current);
  const stageIdx = current.index ?? -1;
  const next = stageIdx >= 0 ? stages[stageIdx + 1] : undefined;
  const stage = stageIdx >= 0 ? stages[stageIdx] : null;
  const scopeDeals = current.kind === "stage" ? deals.filter((d) => d.stage_id === current.stageId).map((d) => ({ id: d.id, title: d.title })) : allDeals;
  const where = current.kind === "stage" ? `en «${current.name}»` : current.kind === "pipeline" ? "de este pipeline" : "en todos los pipelines";
  const active = instructions.filter((i) => i.autonomy !== "off").length;

  return (
    <main className="page agents-pipeline">
      <div className="crumbs"><Link href={`/pipelines/${id}`}>{pipeline.name}</Link></div>
      <div className="page-head">
        <div>
          <h1><Icon name="spark" /> La IA en «{pipeline.name}»</h1>
          <p className="muted" style={{ margin: 0 }}>
            Dile, fase a fase y con tus palabras, qué hacer con los deals. Te enseña cómo lo ha entendido antes de activarlo.
          </p>
        </div>
        <div className="head-actions">
          <span className="meta">{active} instrucci{active === 1 ? "ón activa" : "ones activas"}</span>
          <Link href={`/pipelines/${id}`} className="btn secondary">Volver al tablero</Link>
        </div>
      </div>

      {(settings.paused || !ready) && (
        <div className="ai-status-strip" role="status">
          {settings.paused && <span><span className="dot off" />La IA está en pausa: nada actuará hasta que la reanudes. <Link href="/agents">Reanudar</Link></span>}
          {!ready && <span><span className="dot warn" />Sin IA configurada: solo instrucciones sencillas, sin condiciones. <Link href="/settings/ai">Configurar</Link></span>}
        </div>
      )}

      <div className="agents-layout">
        <nav className="stage-rail" aria-label="Fases del pipeline">
          {scopes.map((sc) => {
            const list = listFor(sc);
            const state = scopeState(list);
            return (
              <Link key={sc.key} href={`/pipelines/${id}/agentes?fase=${sc.key}`} scroll={false}
                    aria-current={sc.key === current.key ? "page" : undefined}
                    className={`rail-item kind-${sc.kind}${state !== "none" ? " has" : ""}`} title={STATE_LABEL[state]}>
                <span className="rail-n">{sc.kind === "stage" ? (sc.index ?? 0) + 1 : <Icon name={sc.kind === "global" ? "deals" : "board"} />}</span>
                <span className="rail-name">
                  <strong>{sc.name}</strong>
                  <span className="meta">{sc.deals !== undefined ? `${sc.deals} deal${sc.deals === 1 ? " abierto" : "s abiertos"}` : "Reglas generales"}</span>
                </span>
                {list.length > 0 && <span className={`rail-badge ${state}`}><Icon name="spark" />{list.length}</span>}
              </Link>
            );
          })}
        </nav>

        <section className="stage-detail" aria-label={current.kind === "stage" ? `Fase ${current.name}` : current.name}>
          <header className="stage-detail-head">
            <div>
              <span className="meta">{current.kind === "stage" ? `Fase ${stageIdx + 1} de ${stages.length}` : current.kind === "pipeline" ? "Vale para cualquier fase" : "Vale para todos los pipelines"}</span>
              <h2>{current.name}</h2>
            </div>
            <div className="stage-facts">
              {current.deals !== undefined && <span><strong>{current.deals}</strong> deal{current.deals === 1 ? " abierto" : "s abiertos"}</span>}
              {stage?.rotten_after_days && <span title="A partir de estos días sin moverse, el deal se marca como parado">Parado a los <strong>{stage.rotten_after_days} d</strong></span>}
              {next && <span>Siguiente: <strong>{next.name}</strong></span>}
            </div>
          </header>

          {own.length > 0 ? (
            <div className="instr-list">
              <h3 className="section-title">Lo que hace la IA aquí <span className="muted">{own.length}</span></h3>
              {own.map((ins) => <InstructionCard key={ins.id} ins={ins} deals={scopeDeals} pipelineId={id} />)}
            </div>
          ) : (
            <div className="instr-empty">
              <Icon name="spark" />
              <div>
                <strong>Todavía no le has dicho nada a la IA {where}.</strong>
                <p className="meta" style={{ margin: "2px 0 0" }}>Escríbelo abajo como se lo dirías a alguien del equipo, o empieza con un ejemplo.</p>
              </div>
            </div>
          )}

          {current.kind !== "global" && (
            <div className="instr-new">
              <h3 className="section-title">{own.length ? "Añadir otra instrucción" : "Nueva instrucción"}</h3>
              <InstructionComposer scope={{ pipelineId: id, stageId: current.kind === "stage" ? current.stageId! : null }} where={where}
                                   examples={examplesFor(stage, next?.name ?? null, stageIdx === stages.length - 1 && stageIdx >= 0)} aiReady={ready} />
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
