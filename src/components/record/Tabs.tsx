"use client";

import { useState } from "react";

/** Pestañas del compositor de una ficha (Nota, Actividad, Llamada, Correo, Archivos). */
export function ComposerTabsBox({ tabs, initial }: { tabs: { key: string; label: string; content: React.ReactNode }[]; initial?: string }) {
  const [tab, setTab] = useState(initial && tabs.some((t) => t.key === initial) ? initial : tabs[0]?.key);
  return (
    <div className="composer" id="compositor">
      <div className="composer-tabs" role="tablist" aria-label="Qué quieres hacer">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tabs.map((t) => <div key={t.key} hidden={tab !== t.key} role="tabpanel" aria-label={t.label}>{t.content}</div>)}
    </div>
  );
}
