"use client";

import { useEffect, useState } from "react";
import type { ActionState } from "@/lib/errors";
import { ActionForm } from "../ActionForm";

type File = { id: string; name: string; url: string; mimeType: string | null; modifiedAt: string | null; owner: string | null };

/**
 * Buscador de archivos en el Drive / OneDrive de la cuenta conectada: escribes
 * parte del nombre y enlazas el archivo al deal.
 */
export function DrivePicker({ dealId, driveName, source, action }: {
  dealId: string;
  driveName: string;
  source: string;
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
}) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<{ files: File[]; loading: boolean; error?: string }>({ files: [], loading: false });

  useEffect(() => {
    if (q.trim().length < 2) { setState({ files: [], loading: false }); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setState((s) => ({ ...s, loading: true, error: undefined }));
      try {
        const res = await fetch(`/api/drive/search?deal=${dealId}&q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "No se pudo buscar.");
        setState({ files: j.files, loading: false });
      } catch (err) {
        if (!ctrl.signal.aborted) setState({ files: [], loading: false, error: err instanceof Error ? err.message : "No se pudo buscar." });
      }
    }, 300);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, dealId]);

  return (
    <div className="drive-picker">
      <label className="field"><span className="label">Buscar en {driveName}</span>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre del archivo…" />
      </label>
      {state.loading && <p className="meta">Buscando…</p>}
      {state.error && <p className="meta tone-bad" role="status">{state.error}</p>}
      {!state.loading && !state.error && q.trim().length >= 2 && state.files.length === 0 && <p className="meta">Sin resultados.</p>}
      {state.files.length > 0 && (
        <ul className="drive-results" aria-label="Archivos encontrados">
          {state.files.map((f) => (
            <li key={f.id}>
              <div>
                <span className="name" title={f.name}>{f.name}</span>
                <span className="meta">{[f.owner, f.modifiedAt && new Date(f.modifiedAt).toLocaleDateString("es-ES")].filter(Boolean).join(" · ")}</span>
              </div>
              <ActionForm action={action} submitLabel="Enlazar" pendingLabel="…" secondary className="form inline">
                <input type="hidden" name="url" value={f.url} />
                <input type="hidden" name="title" value={f.name} />
                <input type="hidden" name="source" value={source} />
                <input type="hidden" name="external_id" value={f.id} />
                <input type="hidden" name="mime_type" value={f.mimeType ?? ""} />
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <p className="meta" style={{ margin: "10px 0 4px" }}>O pega un enlace:</p>
    </div>
  );
}
