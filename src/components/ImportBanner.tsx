"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { importBannerAction } from "@/app/actions/import";

type State = { status: string; step: string; total: number } | null;

/**
 * Aviso fijo en todas las pantallas mientras se importa desde Pipedrive:
 * qué paso va, cuántos registros lleva y que mejor no hacer cambios. Si
 * quien navega es administrador, además hace avanzar la importación (así
 * va igual de rápido aunque no esté en la pantalla de importación).
 */
export function ImportBanner({ initial, labels, canDrive }: { initial: State; labels: Record<string, string>; canDrive: boolean }) {
  const [s, setS] = useState<State>(initial);
  const [finished, setFinished] = useState(false);
  const path = usePathname();
  const router = useRouter();
  const alive = useRef(true);
  const onImportPage = path.startsWith("/settings/import");

  useEffect(() => {
    alive.current = true;
    (async () => {
      while (alive.current) {
        // En la pantalla de importación ya la mueve su propio progreso: aquí solo se mira.
        const next = await importBannerAction(canDrive && !onImportPage).catch(() => undefined);
        if (!alive.current) break;
        if (next === undefined) { await new Promise((r) => setTimeout(r, 3000)); continue; }
        if (!next || next.status !== "running") { setS(null); setFinished(true); router.refresh(); break; }
        setS(next);
        await new Promise((r) => setTimeout(r, canDrive && !onImportPage ? 300 : 2500));
      }
    })();
    return () => { alive.current = false; };
  }, [canDrive, onImportPage, router]);

  if (finished) {
    return (
      <div className="import-banner done" role="status">
        ✓ Importación de Pipedrive terminada. Ya puedes trabajar con normalidad. <Link href="/settings/import">Ver el resultado</Link>
        <button type="button" className="link-btn" onClick={() => setFinished(false)}>Cerrar</button>
      </div>
    );
  }
  if (!s) return null;
  return (
    <div className="import-banner" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>
        <strong>Importando desde Pipedrive: {(labels[s.step] ?? s.step).toLowerCase()}…</strong>{" "}
        <span className="tick" key={s.total}>{s.total.toLocaleString("es-ES")}</span> registros. Puedes mirar, pero no hagas cambios hasta que termine.
      </span>
      {!onImportPage && <Link href="/settings/import" className="btn small secondary">Ver progreso</Link>}
    </div>
  );
}
