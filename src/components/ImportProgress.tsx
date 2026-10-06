"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Progress = { status: string; step: string; counts: Record<string, { created?: number; updated?: number; skipped?: number }>; error: string | null } | null;

/**
 * Mientras la pantalla está abierta, va avanzando la importación (unos
 * segundos por llamada) y muestra el progreso. Si se cierra, la revisión
 * periódica del servidor la continúa.
 */
export function ImportProgress({ advance, labels, steps, initial }: {
  advance: () => Promise<Progress>;
  labels: Record<string, string>;
  steps: string[];
  initial: Progress;
}) {
  const [p, setP] = useState<Progress>(initial);
  const router = useRouter();
  const running = useRef(true);
  useEffect(() => {
    running.current = true;
    (async () => {
      while (running.current) {
        const next = await advance().catch(() => null);
        setP(next);
        if (!next || next.status !== "running") { router.refresh(); break; }
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    return () => { running.current = false; };
  }, [advance, router]);

  if (!p) return null;
  const idx = steps.indexOf(p.step);
  const pct = p.status === "done" ? 100 : Math.max(2, Math.round((Math.max(0, idx) / steps.length) * 100));
  return (
    <div className="import-progress" aria-live="polite">
      <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
      <p className="meta">{p.status === "running" ? `Importando: ${labels[p.step] ?? p.step}…` : p.status === "done" ? "Importación terminada." : p.error ?? p.status}</p>
      <ul className="import-counts">
        {Object.entries(p.counts).map(([k, c]) => (
          <li key={k}><strong>{labels[k] ?? k}</strong> <span className="meta">{c.created ?? 0} nuevos · {c.updated ?? 0} actualizados{c.skipped ? ` · ${c.skipped} omitidos` : ""}</span></li>
        ))}
      </ul>
    </div>
  );
}
