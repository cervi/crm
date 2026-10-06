"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "../Icon";

/** Pestañas del compositor (nota / actividad): solo cambian qué formulario se ve. */
export function ComposerTabs({ note, activity }: { note: React.ReactNode; activity: React.ReactNode }) {
  const [tab, setTab] = useState<"note" | "activity">("note");
  return (
    <div className="composer">
      <div className="composer-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "note"} onClick={() => setTab("note")}>Nota</button>
        <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Actividad</button>
      </div>
      <div hidden={tab !== "note"}>{note}</div>
      <div hidden={tab !== "activity"}>{activity}</div>
    </div>
  );
}

export type HistoryItem = {
  id: string;
  kind: "note" | "activity" | "change";
  at: string;
  title: string;
  body?: string | null;
  meta?: string | null;
  tone?: "good" | "bad" | null;
};

const FILTERS: { value: "all" | HistoryItem["kind"]; label: string }[] = [
  { value: "all", label: "Todo" },
  { value: "note", label: "Notas" },
  { value: "activity", label: "Actividades" },
  { value: "change", label: "Cambios" },
];

/** Historia del deal con filtro por tipo. */
export function HistoryFeed({ items }: { items: HistoryItem[] }) {
  const [filter, setFilter] = useState<"all" | HistoryItem["kind"]>("all");
  const shown = filter === "all" ? items : items.filter((i) => i.kind === filter);
  const count = (k: HistoryItem["kind"]) => items.filter((i) => i.kind === k).length;
  return (
    <div className="history">
      <div className="chips" role="tablist" aria-label="Filtrar historia">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" role="tab" aria-selected={filter === f.value} onClick={() => setFilter(f.value)}>
            {f.label}{f.value !== "all" && ` (${count(f.value)})`}
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="muted">Nada por aquí todavía.</p>}
      <ol className="feed">
        {shown.map((i) => (
          <li key={i.id} className={`feed-item ${i.kind}`}>
            <span className="feed-icon" aria-hidden="true"><Icon name={i.kind === "note" ? "pencil" : i.kind === "activity" ? "activities" : "sort"} /></span>
            <div className="feed-card">
              <div className="feed-title">
                <strong className={i.tone ? `tone-${i.tone}` : undefined}>{i.title}</strong>
                <span className="meta">{i.meta}</span>
              </div>
              {i.body && <p className="note-body">{i.body}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Controles del panel lateral: cerrar, abrir entera, anterior y siguiente. Teclas: Esc, J/K. */
export function PanelControls({ closeHref, fullHref, prevHref, nextHref }: {
  closeHref: string; fullHref: string; prevHref: string | null; nextHref: string | null;
}) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") router.push(closeHref, { scroll: false });
      if (e.key === "k" && prevHref) router.push(prevHref, { scroll: false });
      if (e.key === "j" && nextHref) router.push(nextHref, { scroll: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, closeHref, prevHref, nextHref]);

  return (
    <div className="panel-controls">
      <Link href={closeHref} scroll={false} aria-label="Cerrar (Esc)" title="Cerrar (Esc)"><Icon name="x" /></Link>
      <Link href={fullHref} aria-label="Abrir la ficha completa" title="Abrir la ficha completa"><Icon name="expand" /></Link>
      {prevHref ? <Link href={prevHref} scroll={false} aria-label="Deal anterior (K)" title="Deal anterior (K)"><Icon name="up" /></Link>
                : <span className="disabled"><Icon name="up" /></span>}
      {nextHref ? <Link href={nextHref} scroll={false} aria-label="Deal siguiente (J)" title="Deal siguiente (J)"><Icon name="chevron" /></Link>
                : <span className="disabled"><Icon name="chevron" /></span>}
    </div>
  );
}
