"use client";

import { useState } from "react";
import { Icon } from "@/components/Icon";
import { pinNoteAction } from "@/app/actions/contact";
import type { HistoryItem, HistoryKind } from "@/lib/history";

const LABELS: Record<HistoryKind, string> = {
  note: "Notas", activity: "Actividades", call: "Llamadas", email: "Correos", file: "Archivos", change: "Cambios",
};
const ICON: Record<HistoryKind, Parameters<typeof Icon>[0]["name"]> = {
  note: "pencil", activity: "activities", call: "pulse", email: "mail", file: "download", change: "sort",
};

/** Historia con filtro por tipo (solo los tipos que hay) y notas que se pueden fijar. */
export function HistoryFeed({ items, back }: { items: HistoryItem[]; back?: string }) {
  const [filter, setFilter] = useState<"all" | HistoryKind>("all");
  const kinds = (Object.keys(LABELS) as HistoryKind[]).filter((k) => items.some((i) => i.kind === k));
  const shown = filter === "all" ? items : items.filter((i) => i.kind === filter);
  return (
    <div className="history">
      <div className="chips" role="tablist" aria-label="Filtrar historia">
        <button type="button" role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")}>Todo</button>
        {kinds.map((k) => (
          <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}>
            {LABELS[k]} ({items.filter((i) => i.kind === k).length})
          </button>
        ))}
      </div>
      {shown.length === 0 && <p className="muted">Nada por aquí todavía.</p>}
      <ol className="feed">
        {shown.map((i) => (
          <li key={i.id} className={`feed-item ${i.kind}${i.pinned ? " pinned" : ""}`}>
            <span className="feed-icon" aria-hidden="true"><Icon name={ICON[i.kind]} /></span>
            <div className="feed-card">
              <div className="feed-title">
                <strong className={i.tone ? `tone-${i.tone}` : undefined}>
                  {i.href ? <a href={i.href}>{i.title}</a> : i.title}
                </strong>
                <span className="meta">{i.meta}</span>
                {back && i.noteId && (
                  <form action={pinNoteAction.bind(null, i.noteId, !i.pinned, back)} className="feed-pin">
                    <button type="submit" className="link-btn meta">{i.pinned ? "Desfijar" : "Fijar"}</button>
                  </form>
                )}
              </div>
              {i.body && <p className="note-body">{i.body}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
