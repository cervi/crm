"use client";

import { useState } from "react";
import { ShareDocButton } from "./ShareDocButton";

/** Elegir un documento de la biblioteca y copiar su enlace con seguimiento para este contacto (WhatsApp, LinkedIn…). */
export function LibraryShare({ items, dealId, people }: { items: { id: string; name: string }[]; dealId: string; people: { id: string; name: string }[] }) {
  const [doc, setDoc] = useState(items[0]?.id ?? "");
  const [person, setPerson] = useState(people[0]?.id ?? "");
  if (!items.length) return <p className="meta">Sube documentos a la <a href="/biblioteca">biblioteca</a> para compartirlos desde aquí con seguimiento.</p>;
  return (
    <div className="lib-share">
      <select value={doc} onChange={(e) => setDoc(e.target.value)} aria-label="Documento">
        {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
      {people.length > 0 && (
        <select value={person} onChange={(e) => setPerson(e.target.value)} aria-label="Para quién">
          {people.map((p) => <option key={p.id} value={p.id}>Para {p.name}</option>)}
        </select>
      )}
      <ShareDocButton key={`${doc}:${person}`} libraryId={doc} dealId={dealId} personId={person || null} label="Copiar enlace" />
    </div>
  );
}
