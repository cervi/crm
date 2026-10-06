"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

type Opt = { value: string; label: string };

type Props = {
  pipelineId: string;
  pipelines: Opt[];
  users: Opt[];
  sorts: Opt[];
  view: "board" | "list";
  summary: React.ReactNode;
  /** Botones extra al final de la barra (p. ej. «Exportar CSV»). */
  actions?: React.ReactNode;
};

/** Barra del tablero: vista, nuevo deal, pipeline, edición, responsable y orden. */
export function PipelineToolbar({ pipelineId, pipelines, users, sorts, view, summary, actions }: Props) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  /** Cambia un parámetro de la URL conservando el resto (y cerrando el panel de un deal). */
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value); else next.delete(key);
    next.delete("deal");
    router.push(`${path}${next.size ? `?${next}` : ""}`);
  };
  const keep = (target: string) => {
    const next = new URLSearchParams(params.toString());
    next.delete("deal");
    return `${target}${next.size ? `?${next}` : ""}`;
  };
  const current = pipelines.find((p) => p.value === pipelineId);

  return (
    <div className="board-toolbar">
      <div className="segmented" role="group" aria-label="Vista">
        <button type="button" aria-pressed={view === "board"} title="Tablero" aria-label="Vista de tablero" onClick={() => setParam("view", null)}><Icon name="board" /></button>
        <button type="button" aria-pressed={view === "list"} title="Lista" aria-label="Vista de lista" onClick={() => setParam("view", "list")}><Icon name="list" /></button>
      </div>
      <Link href={`/deals/new?pipeline=${pipelineId}`} className="btn"><Icon name="plus" />Deal</Link>
      <span className="spacer" />
      <span className="board-count">{summary}</span>
      {actions}

      <div className="menu-wrap" ref={ref}>
        <button type="button" className="btn secondary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Icon name="board" />{current?.label}<Icon name="chevron" />
        </button>
        {open && (
          <div className="dropdown" role="menu">
            <div className="dropdown-label">Pipelines</div>
            {pipelines.map((p) => (
              <Link key={p.value} role="menuitemradio" aria-checked={p.value === pipelineId}
                    href={keep(`/pipelines/${p.value}`)} onClick={() => setOpen(false)}>
                <span className="check">{p.value === pipelineId && <Icon name="check" />}</span>{p.label}
              </Link>
            ))}
            <div className="dropdown-sep" />
            <Link href="/settings/pipelines" role="menuitem" onClick={() => setOpen(false)}>Gestionar pipelines</Link>
          </div>
        )}
      </div>
      <Link href={`/settings/pipelines/${pipelineId}`} className="btn secondary square" title="Editar fases de este pipeline" aria-label="Editar fases de este pipeline">
        <Icon name="pencil" />
      </Link>
      <select aria-label="Responsable" value={params.get("owner") ?? ""} onChange={(e) => setParam("owner", e.target.value || null)}>
        <option value="">Todos los responsables</option>
        {users.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
      </select>
      {view === "board" ? (
        <label className="sort-select">
          <Icon name="sort" />
          <select aria-label="Ordenar por" value={params.get("sort") ?? "attention"} onChange={(e) => setParam("sort", e.target.value === "attention" ? null : e.target.value)}>
            {sorts.map((s) => <option key={s.value} value={s.value}>Ordenar: {s.label.toLowerCase()}</option>)}
          </select>
        </label>
      ) : (
        <select aria-label="Estado" value={params.get("status") ?? "open"} onChange={(e) => setParam("status", e.target.value === "open" ? null : e.target.value)}>
          <option value="open">Abiertos</option>
          <option value="all">Todos (también cerrados)</option>
          <option value="won">Ganados</option>
          <option value="lost">Perdidos</option>
        </select>
      )}
    </div>
  );
}
