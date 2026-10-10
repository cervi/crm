"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { scheduleNextAction } from "@/app/actions/records";
import { Icon } from "../Icon";

const PRESETS = [
  { key: "call_tomorrow", label: "Llamar mañana" },
  { key: "followup_3", label: "Seguimiento en 3 días" },
  { key: "followup_7", label: "En una semana" },
] as const;

/**
 * «Este deal se ha quedado sin siguiente paso»: botones para programarlo con
 * un clic, u «Otra…» para elegir tipo y fecha en la ficha.
 */
export function NextStepPrompt({ dealId, dealTitle, onDone, compact }: { dealId: string; dealTitle?: string; onDone?: () => void; compact?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const pick = (key: (typeof PRESETS)[number]["key"]) => start(async () => {
    const r = await scheduleNextAction(dealId, key);
    if (r.error) { setMsg({ error: r.error }); return; }
    setMsg({ ok: r.message });
    router.refresh();
    onDone?.();
  });
  if (msg.ok) return <p className="next-step done" role="status"><Icon name="check" />{msg.ok}</p>;
  return (
    <div className={`next-step${compact ? " compact" : ""}`} role="group" aria-label="Siguiente paso del deal">
      <span className="next-step-q"><Icon name="flag" />{dealTitle ? <><strong>{dealTitle}</strong> se ha quedado sin siguiente paso.</> : <strong>Este deal no tiene ningún siguiente paso.</strong>}</span>
      <span className="next-step-btns">
        {PRESETS.map((p) => <button key={p.key} type="button" className="btn secondary small" disabled={pending} onClick={() => pick(p.key)}>{p.label}</button>)}
        <Link href={`/deals/${dealId}#nueva-actividad`} className="btn secondary small">Otra…</Link>
        {onDone && <button type="button" className="btn-link meta" onClick={onDone}>Ahora no</button>}
      </span>
      {msg.error && <span className="meta tone-bad" role="alert">{msg.error}</span>}
    </div>
  );
}
