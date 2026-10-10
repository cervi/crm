"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toggleActivityDoneAction } from "@/app/actions/records";
import { Icon } from "../Icon";
import { NextStepPrompt } from "./NextStepPrompt";

/** Círculo para marcar una actividad como hecha (o deshacerlo) con un clic. */
export function QuickDone({ id, done, subject }: { id: string; done: boolean; subject: string }) {
  const router = useRouter();
  const [on, setOn] = useState(done);
  const [error, setError] = useState<string | null>(null);
  const [needsNext, setNeedsNext] = useState<{ id: string; title: string } | null>(null);
  const [pending, start] = useTransition();
  const toggle = () => {
    const next = !on;
    setOn(next); setError(null);
    start(async () => {
      const r = await toggleActivityDoneAction(id, next);
      if (r.error) { setOn(!next); setError(r.error); return; }
      // Si el deal se queda sin siguiente paso, se pregunta antes de refrescar (la fila desaparecería).
      if (r.needsNext) { setNeedsNext(r.needsNext); return; }
      router.refresh();
    });
  };
  return (
    <>
    <button type="button" className={`quick-done${on ? " on" : ""}${pending ? " busy" : ""}`} onClick={toggle} aria-pressed={on}
            aria-label={on ? `Marcar «${subject}» como pendiente` : `Marcar «${subject}» como hecha`}
            title={error ?? (on ? "Hecha · clic para deshacer" : "Marcar como hecha")}>
      <Icon name="check" />
    </button>
    {error && <span className="quick-error" role="status">{error}</span>}
    {needsNext && <div className="next-step-pop"><NextStepPrompt dealId={needsNext.id} dealTitle={needsNext.title} onDone={() => { setNeedsNext(null); router.refresh(); }} compact /></div>}
    </>
  );
}
