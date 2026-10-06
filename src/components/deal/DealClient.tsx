"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";

/** Pestañas del compositor (nota / actividad / correo): solo cambian qué formulario se ve. */
export function ComposerTabs({ note, activity, email }: { note: React.ReactNode; activity: React.ReactNode; email?: React.ReactNode }) {
  const [tab, setTab] = useState<"note" | "activity" | "email">("note");
  return (
    <div className="composer">
      <div className="composer-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "note"} onClick={() => setTab("note")}>Nota</button>
        <button type="button" role="tab" aria-selected={tab === "activity"} onClick={() => setTab("activity")}>Actividad</button>
        {email && <button type="button" role="tab" aria-selected={tab === "email"} onClick={() => setTab("email")}>Correo</button>}
      </div>
      <div hidden={tab !== "note"}>{note}</div>
      <div hidden={tab !== "activity"}>{activity}</div>
      {email && <div hidden={tab !== "email"}>{email}</div>}
    </div>
  );
}

export type ComposerTemplate = { id: string; name: string; subject: string; body: string };

/**
 * Campos del correo de la ficha: plantilla, asunto, texto con «Insertar mis
 * huecos», seguimiento de aperturas y envío programado. Las plantillas llegan
 * ya con los datos del deal; {huecos} se rellena aquí, leyendo el calendario.
 */
export function EmailComposerFields({ dealId, templates, trackDefault, trackAvailable }: {
  dealId: string; templates: ComposerTemplate[]; trackDefault: boolean; trackAvailable: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [later, setLater] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const [state, setState] = useState<{ loading?: boolean; error?: string }>({});

  // Tras enviar, el formulario se vacía (también lo que controla este componente).
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const clear = () => { setSubject(""); setBody(""); setTemplateId(""); setLater(false); setSendAt(""); setState({}); };
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, []);

  async function slots(): Promise<string> {
    const res = await fetch(`/api/calendar/slots?deal=${dealId}`);
    const j = await res.json();
    if (!res.ok || !j.text) throw new Error(j.error ?? "No hay huecos libres con tus preferencias.");
    return j.text as string;
  }
  async function insert() {
    setState({ loading: true });
    try {
      const text = await slots();
      const el = ref.current!;
      el.focus();
      el.setRangeText(`${text}\n`, el.selectionStart, el.selectionEnd, "end");
      setBody(el.value);
      setState({});
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : "No se pudo leer el calendario." });
    }
  }
  async function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setSubject(t.subject);
    if (!t.body.includes("{huecos}")) { setBody(t.body); return; }
    setBody(t.body);
    setState({ loading: true });
    try {
      const text = await slots();
      setBody(t.body.replace("{huecos}", text));
      setState({});
    } catch (err) {
      setBody(t.body.replace("{huecos}", ""));
      setState({ error: err instanceof Error ? err.message : "No se pudo leer el calendario." });
    }
  }

  return (
    <>
      {templates.length > 0 && (
        <label className="field"><span className="label">Plantilla</span>
          <select value={templateId} onChange={(e) => applyTemplate(e.target.value)} aria-label="Plantilla">
            <option value="">Sin plantilla</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      <input type="hidden" name="template_id" value={templateId} />
      <label className="field"><span className="label">Asunto</span>
        <input name="subject" required value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="field"><span className="label">Texto</span>
        <textarea ref={ref} name="body" rows={8} required value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="compose-tools">
        <button type="button" className="btn secondary small" onClick={insert} disabled={state.loading}>
          {state.loading ? "Leyendo el calendario…" : "Insertar mis huecos"}
        </button>
        {trackAvailable && (
          <label className="checkbox">
            <input type="hidden" name="track_present" value="1" />
            <input type="checkbox" name="track" defaultChecked={trackDefault} />Seguir aperturas y clics
          </label>
        )}
        <label className="checkbox"><input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />Programar el envío</label>
        {later && (
          <>
            {/* Se envía en ISO (con la zona del navegador), no como hora «local» que el servidor interpretaría en la suya. */}
            <input type="datetime-local" required aria-label="Enviar el" value={sendAt} onChange={(e) => setSendAt(e.target.value)} />
            <input type="hidden" name="send_at" value={sendAt && !Number.isNaN(new Date(sendAt).getTime()) ? new Date(sendAt).toISOString() : ""} />
          </>
        )}
        {state.error && <span className="meta tone-bad" role="status">{state.error}</span>}
      </div>
    </>
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
  // Los enlaces vigentes se leen de una referencia, así el atajo siempre usa
  // los del deal que se está viendo aunque se pulse justo al cambiar de deal.
  const links = useRef({ closeHref, prevHref, nextHref });
  links.current = { closeHref, prevHref, nextHref };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || el.closest("input, textarea, select, [contenteditable]")) return;
      const { closeHref: close, prevHref: prev, nextHref: next } = links.current;
      if (e.key === "Escape") router.push(close, { scroll: false });
      if (e.key === "k" && prev) router.push(prev, { scroll: false });
      if (e.key === "j" && next) router.push(next, { scroll: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

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
