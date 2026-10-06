"use client";

import Link from "next/link";
import { useOptimistic, useState, useTransition } from "react";
import { moveDealAction } from "@/app/actions/deals";
import type { BoardDeal, BoardStage } from "@/lib/pipelines";

const money = (v: string | number | null, currency = "EUR") =>
  v === null || v === "" ? "—"
    : new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(v));

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
export function Board({ stages }: { stages: BoardStage[] }) {
  const [optimistic, addMove] = useOptimistic(stages, applyMove);
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
      <section className="board">
        {optimistic.map((stage) => (
          <div
            key={stage.id}
            className={over === stage.id ? "stage drop-target" : "stage"}
            onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver(stage.id); } }}
            onDragLeave={() => setOver((o) => (o === stage.id ? null : o))}
            onDrop={(e) => { e.preventDefault(); drop(stage.id); }}
          >
            <div className="stage-head">
              <h2>{stage.name}</h2>
              <span>{money(stage.total_value)} · {stage.deals.length} deal{stage.deals.length === 1 ? "" : "s"}</span>
            </div>
            <ul>
              {stage.deals.map((deal) => (
                <li
                  key={deal.id}
                  draggable
                  onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDragging({ id: deal.id, from: stage.id }); }}
                  onDragEnd={() => { setDragging(null); setOver(null); }}
                  className={["deal-card", deal.is_rotten && "rotten", dragging?.id === deal.id && "dragging"].filter(Boolean).join(" ")}
                >
                  <Link href={`/deals/${deal.id}`} draggable={false}>{deal.title}</Link>
                  <span className="muted">{[deal.organization_name, deal.person_name].filter(Boolean).join(" · ") || "Sin empresa"}</span>
                  <span>{money(deal.value, deal.currency)}{deal.owner_name && <span className="meta"> · {deal.owner_name}</span>}</span>
                  <span className="flags">
                    <span className="meta">{deal.days_in_stage} d en la fase</span>
                    {deal.is_rotten && <span className="badge warn">Parado</span>}
                    {!deal.has_upcoming_session && <span className="badge">Sin sesión agendada</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </>
  );
}
