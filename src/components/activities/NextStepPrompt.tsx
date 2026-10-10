"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { scheduleNextAction, undoScheduledAction } from "@/app/actions/records";
import { Icon } from "../Icon";

const PRESETS = [
  { key: "call_tomorrow", label: "Llamar mañana" },
  { key: "followup_3", label: "Seguimiento en 3 días" },
  { key: "followup_7", label: "Seguimiento en una semana" },
] as const;

/**
 * «Este deal se ha quedado sin siguiente paso»: botones para programarlo con
 * un clic, u «Otra…» para elegir tipo y fecha en la ficha. Tras elegir, se
 * confirma con la opción de deshacer.
 */
export function NextStepPrompt({ dealId, dealTitle, onDone }: { dealId: string; dealTitle?: string; onDone?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<{ done?: { id: string; label: string }; error?: string; undone?: boolean }>({});

  // En el aviso flotante, la confirmación se queda unos segundos y luego se cierra sola.
  // La confirmación (con «Deshacer») se queda unos segundos; luego se refresca la página y, si es flotante, se cierra.
  useEffect(() => {
    if (!(state.done || state.undone)) return;
    const t = setTimeout(() => { router.refresh(); onDone?.(); }, state.undone ? 1500 : 6000);
    return () => clearTimeout(t);
  }, [state.done, state.undone, onDone, router]);

  const pick = (key: (typeof PRESETS)[number]["key"], label: string) => start(async () => {
    const r = await scheduleNextAction(dealId, key);
    if (r.error || !r.activityId) { setState({ error: r.error ?? "No se pudo programar." }); return; }
    setState({ done: { id: r.activityId, label } });
  });
  const undo = () => start(async () => {
    if (!state.done) return;
    const r = await undoScheduledAction(dealId, state.done.id);
    if (r.error) { setState((s) => ({ ...s, error: r.error })); return; }
    setState({ undone: true });
  });

  if (state.undone) return <p className="next-step done" role="status">Deshecho: el deal vuelve a no tener siguiente paso.</p>;
  if (state.done) {
    return (
      <div className="next-step done" role="status">
        <Icon name="check" /><span>Programado: <strong>{state.done.label.toLowerCase()}</strong>{dealTitle ? <> en {dealTitle}</> : null}.</span>
        <span className="next-step-btns">
          <button type="button" className="btn secondary small" onClick={undo} disabled={pending}>Deshacer</button>
          <button type="button" className="btn secondary small" onClick={() => { router.refresh(); onDone?.(); }}>{onDone ? "Cerrar" : "Vale"}</button>
        </span>
        {state.error && <span className="meta tone-bad" role="alert">{state.error}</span>}
      </div>
    );
  }
  return (
    <div className="next-step" role="group" aria-label="Siguiente paso del deal">
      <span className="next-step-q"><Icon name="flag" />{dealTitle ? <span><strong>{dealTitle}</strong> se ha quedado sin siguiente paso.</span> : <strong>Este deal no tiene ningún siguiente paso.</strong>}</span>
      <span className="next-step-btns">
        {PRESETS.map((p) => <button key={p.key} type="button" className="btn secondary small" disabled={pending} onClick={() => pick(p.key, p.label)}>{p.label}</button>)}
        <Link href={`/deals/${dealId}#nueva-actividad`} className="btn secondary small" onClick={onDone}>Otra…</Link>
        {onDone && <button type="button" className="btn secondary small" onClick={onDone}>Ahora no</button>}
      </span>
      {state.error && <span className="meta tone-bad" role="alert">{state.error}</span>}
    </div>
  );
}

/**
 * Un único aviso flotante para toda la app: lo pide cualquier sitio que marque
 * como hecha la última actividad de un deal (evento «crm:next-step»). Si llega
 * otro, sustituye al anterior.
 */
export function NextStepHost() {
  const router = useRouter();
  const [deal, setDeal] = useState<{ id: string; title: string; key: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setDeal({ ...(e as CustomEvent<{ id: string; title: string }>).detail, key: Date.now() });
    window.addEventListener("crm:next-step", on);
    return () => window.removeEventListener("crm:next-step", on);
  }, []);
  if (!deal) return null;
  return (
    <div className="next-step-pop">
      <NextStepPrompt key={deal.key} dealId={deal.id} dealTitle={deal.title} onDone={() => { setDeal(null); router.refresh(); }} />
    </div>
  );
}

export const askNextStep = (deal: { id: string; title: string }) =>
  window.dispatchEvent(new CustomEvent("crm:next-step", { detail: deal }));
