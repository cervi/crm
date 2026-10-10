"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { moveDealAction } from "@/app/actions/deals";
import type { BoardDeal, BoardStage } from "@/lib/pipelines";
import { Icon } from "./Icon";
import { Avatar } from "./Avatar";
import { HealthBadge } from "./HealthBadge";
import { formatValue } from "@/lib/chart-format";

const money = (v: string | number | null, _currency = "EUR") =>
  v === null || v === "" ? "—" : formatValue(Number(v), "money");

type Move = { dealId: string; to: string };

function applyMove(stages: BoardStage[], { dealId, to }: Move): BoardStage[] {
  let moved: BoardDeal | undefined;
  const without = stages.map((s) => {
    const deal = s.deals.find((d) => d.id === dealId);
    if (!deal) return s;
    moved = { ...deal, days_in_stage: 0, is_rotten: false };
    return { ...s, deals: s.deals.filter((d) => d.id !== dealId),
             total_value: String(Number(s.total_value) - Number(deal.value ?? 0)) };
  });
  if (!moved) return stages;
  return without.map((s) => s.id !== to ? s : {
    ...s, deals: [moved!, ...s.deals], total_value: String(Number(s.total_value) + Number(moved!.value ?? 0)),
  });
}

/** Tablero tipo Pipedrive: se arrastran los deals de una fase a otra. */
export function Board({ stages, pipelineId, agentCounts = {} }: { stages: BoardStage[]; pipelineId?: string; agentCounts?: Record<string, number> }) {
  const [optimistic, addMove] = useOptimistic(stages, applyMove);
  const path = usePathname();
  const params = useSearchParams();
  const selected = params.get("deal");
  // Pulsar una tarjeta abre el deal en el panel lateral, sin salir del tablero.
  const panelHref = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("deal", id);
    return `${path}?${next}`;
  };
  const [, startTransition] = useTransition();
  const [dragging, setDragging] = useState<{ id: string; from: string } | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const drop = (to: string) => {
    const d = dragging;
    setDragging(null);
    setOver(null);
    if (!d || d.from === to) return;
    setError(null);
    startTransition(async () => {
      addMove({ dealId: d.id, to });
      const res = await moveDealAction(d.id, to);
      if (res.error) setError(res.error);
    });
  };

  return (
    <>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className={optimistic.length > 7 ? "board many" : "board"}>
        {optimistic.map((stage) => (
          <div
            key={stage.id}
            className={over === stage.id ? "stage drop-target" : "stage"}
            onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(stage.id); } }}
            onDragLeave={() => setOver((o) => (o === stage.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); drop(stage.id); }}
          >
            <div className="stage-head">
              <h2><span>{stage.name}</span><span className="count">{stage.deals.length}</span>
                {pipelineId && (
                  <Link href={`/pipelines/${pipelineId}/agentes?fase=${stage.id}#fase-${stage.id}`} className={agentCounts[stage.id] ? "stage-ai on" : "stage-ai"}
                        title={agentCounts[stage.id] ? `La IA tiene ${agentCounts[stage.id]} instrucción(es) en esta fase` : "Decirle a la IA qué hacer con los deals de esta fase"}
                        aria-label={`IA en la fase ${stage.name}`}>
                    <Icon name="spark" />{agentCounts[stage.id] ? agentCounts[stage.id] : <span className="ai-label">IA</span>}
                  </Link>
                )}
              </h2>
              <span>{money(stage.total_value)}{stage.win_probability !== null && <> · {stage.win_probability} %<span className="prob-label"> de probabilidad</span></>}</span>
              <div className="stage-meter" aria-hidden="true"><i style={{ width: `${stage.win_probability ?? 0}%` }} /></div>
            </div>
            <ul>
              {stage.deals.map((deal) => (
                <li
                  key={deal.id}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragging({ id: deal.id, from: stage.id }); }}
                  onDragEnd={() => { setDragging(null); setOver(null); }}
                  className={["deal-card", deal.is_rotten && "rotten", dragging?.id === deal.id && "dragging", selected === deal.id && "selected"].filter(Boolean).join(" ")}
                >
                  <Link href={panelHref(deal.id)} scroll={false} draggable={false} className="deal-title">{deal.title}</Link>
                  <span className="who">
                    <Avatar name={deal.organization_name ?? deal.person_name} kind={deal.organization_name ? "org" : "person"} size="sm" />
                    <span>{[deal.organization_name, deal.person_name].filter(Boolean).join(" · ") || "Sin empresa"}</span>
                  </span>
                  <span className="foot">
                    <span className="amount">{money(deal.value, deal.currency)}</span>
                    <HealthBadge score={deal.health} signals={deal.health_signals} compact />
                    <span className="age" title="Días en esta fase">{deal.days_in_stage === 0 ? "Hoy" : `${deal.days_in_stage} d`}</span>
                    {deal.owner_name && <span title={`Responsable: ${deal.owner_name}`}><Avatar name={deal.owner_name} size="sm" /></span>}
                  </span>
                  {(deal.is_rotten || !deal.has_upcoming_session || deal.pending_ai > 0) && (
                    <span className="flags">
                      {deal.pending_ai > 0 && (
                        <span className="badge ai" title="Propuestas de la IA esperando tu decisión">
                          <Icon name="spark" />{deal.pending_ai}
                        </span>
                      )}
                      {deal.is_rotten && <span className="badge warn">Parado</span>}
                      {!deal.has_upcoming_session && <span className="badge">Sin sesión agendada</span>}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}
