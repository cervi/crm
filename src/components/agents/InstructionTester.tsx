"use client";

import { useState, useTransition } from "react";
import { testInstructionAction } from "@/app/actions/stage-agents";
import type { DryRun } from "@/lib/stage-agents";

/** Probar una instrucción con un deal: qué haría ahora, sin hacer nada. */
export function InstructionTester({ id, deals }: { id: string; deals: { id: string; title: string }[] }) {
  const [deal, setDeal] = useState(deals[0]?.id ?? "");
  const [res, setRes] = useState<{ error?: string; results?: DryRun[] } | null>(null);
  const [pending, start] = useTransition();
  if (!deals.length) return <p className="meta" style={{ margin: 0 }}>No hay deals abiertos aquí con los que probarla.</p>;
  return (
    <div className="instr-test">
      <div className="ee-row">
        <select aria-label="Deal con el que probar" value={deal} onChange={(e) => { setDeal(e.target.value); setRes(null); }}>
          {deals.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
        </select>
        <button type="button" className="btn small secondary" disabled={pending} onClick={() => start(async () => setRes(await testInstructionAction(id, deal)))}>
          {pending ? "Probando…" : "Probar con este deal"}
        </button>
      </div>
      {res?.error && <p className="form-error">{res.error}</p>}
      {res?.results && (
        <ul className="instr-results" aria-label="Resultado de la prueba">
          {res.results.map((r, i) => <li key={i} className={r.applies ? "yes" : "no"}><strong>{r.applies ? "✓" : "–"} {r.rule}:</strong> {r.detail}</li>)}
        </ul>
      )}
      <p className="meta" style={{ margin: 0 }}>La prueba no envía ni cambia nada.</p>
    </div>
  );
}
