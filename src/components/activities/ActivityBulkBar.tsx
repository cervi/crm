"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { bulkCompleteActivitiesAction } from "@/app/actions/records";

const CHECKS = "input.bulk-check";
const selectedIds = () => Array.from(document.querySelectorAll<HTMLInputElement>(CHECKS)).filter((c) => c.checked).map((c) => c.value);

/** Acciones en bloque sobre actividades: marcarlas como hechas. */
export function ActivityBulkBar() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    const sync = () => setCount(selectedIds().length);
    document.addEventListener("change", sync);
    sync();
    return () => document.removeEventListener("change", sync);
  }, []);
  if (count === 0 && !msg) return null;
  return (
    <div className="bulk-bar" role="region" aria-label="Acciones en bloque">
      {count > 0 && (
        <div className="bulk-form">
          <strong>{count} seleccionada{count === 1 ? "" : "s"}</strong>
          <button type="button" className="btn small" disabled={pending}
                  onClick={() => start(async () => {
                    const r = await bulkCompleteActivitiesAction(selectedIds());
                    setMsg(r.error ?? r.message ?? null);
                    document.querySelectorAll<HTMLInputElement>(CHECKS).forEach((c) => { c.checked = false; });
                    document.dispatchEvent(new Event("change"));
                    router.refresh();
                  })}>{pending ? "Guardando…" : "Marcar como hechas"}</button>
        </div>
      )}
      {msg && <span className="meta" role="status">{msg}</span>}
    </div>
  );
}
