"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Progress = { status: string; step: string; counts: Record<string, { created?: number; updated?: number; skipped?: number }>; error: string | null; quietFor?: number } | null;

/**
 * Mientras la pantalla está abierta, va avanzando la importación (unos
 * segundos por llamada) y muestra el progreso. Si se cierra, la revisión
 * periódica del servidor la continúa.
 */
export function ImportProgress({ labels, steps, initial }: {
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
        // Por una ruta normal (no una acción de servidor): así se puede navegar mientras tanto.
        const res = await fetch("/api/import/progress", { method: "POST", cache: "no-store" }).catch(() => null);
        if (!res?.ok) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        const next = (await res.json().catch(() => null)) as Progress;
        setP(next);
        if (!next || next.status !== "running") { router.refresh(); break; }
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    return () => { running.current = false; };
  }, [router]);

  // Para que se note que está vivo: tiempo transcurrido y hace cuánto llegó la última novedad.
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(Date.now());
  const lastChange = useRef(Date.now());
  const lastTotal = useRef(-1);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  if (!p) return null;
  const total = Object.values(p.counts).reduce((n, c) => n + (c.created ?? 0) + (c.updated ?? 0) + (c.skipped ?? 0), 0);
  if (total !== lastTotal.current) { lastTotal.current = total; lastChange.current = now; }
  const isRunning = p.status === "running";
  const idx = steps.indexOf(p.step);
  const pct = p.status === "done" ? 100 : Math.max(3, Math.round((Math.max(0, idx) / steps.length) * 100));
  const elapsed = Math.max(0, Math.round((now - started.current) / 1000));
  const quiet = Math.max(0, Math.round((now - lastChange.current) / 1000));
  const fmt = (n: number) => (n < 60 ? `${n} s` : `${Math.floor(n / 60)} min ${String(n % 60).padStart(2, "0")} s`);
  const cur = p.counts[p.step];
  const curN = cur ? (cur.created ?? 0) + (cur.updated ?? 0) + (cur.skipped ?? 0) : 0;
  return (
    <div className={`import-progress${isRunning ? " running" : ""}`} aria-live="polite">
      {isRunning && (
        <div className="import-now">
          <span className="spinner" aria-hidden="true" />
          <div>
            <strong>Importando {(labels[p.step] ?? p.step).toLowerCase()}…</strong>
            <div className="meta">
              {curN > 0 && <><b className="tick" key={curN}>{curN.toLocaleString("es-ES")}</b> {curN === 1 ? "registro" : "registros"} en este paso · </>}
              {total.toLocaleString("es-ES")} en total · {fmt(elapsed)}
              {quiet > 20 && quiet <= 120 ? ` · esperando a Pipedrive (${fmt(quiet)})…` : ""}
            </div>
            <div className="meta">Último avance guardado: {p.quietFor === undefined ? "—" : p.quietFor < 5 ? "ahora mismo" : `hace ${fmt(p.quietFor)}`}</div>
          </div>
        </div>
      )}
      <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
      <ol className="import-steps" aria-label="Pasos">
        {steps.map((st, i) => {
          const state = p.status === "done" || i < idx ? "done" : i === idx && isRunning ? "now" : "todo";
          return <li key={st} className={state}>{state === "done" ? "✓ " : ""}{labels[st] ?? st}</li>;
        })}
      </ol>
      {!isRunning && <p className="meta">{p.status === "done" ? "Importación terminada." : p.error ?? p.status}</p>}
      {isRunning && quiet > 120 && (p.quietFor ?? 0) > 120 && (
        <p className="ee-warn" role="alert" style={{ margin: 0 }}>
          Lleva {fmt(quiet)} sin avanzar: puede que se haya parado. Recarga la página para reanudarla (sigue donde iba, sin duplicar).
          Si vuelve a pararse, mira la ventana de la Terminal donde está «npm run probar» y pásame el último error.
        </p>
      )}
      {isRunning && <p className="meta" style={{ margin: 0 }}>Todo va bien mientras el contador avance. Si cierras esta pantalla, la importación sigue sola en segundo plano (más despacio).</p>}
      <ul className="import-counts">
        {Object.entries(p.counts).map(([k, c]) => (
          <li key={k} className={k === p.step && isRunning ? "now" : undefined}><strong>{labels[k] ?? k}</strong> <span className="meta">{c.created ?? 0} nuevos · {c.updated ?? 0} actualizados{c.skipped ? ` · ${c.skipped} omitidos` : ""}</span></li>
        ))}
      </ul>
    </div>
  );
}
