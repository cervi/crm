"use client";

import Link from "next/link";
import { aiEmailAction } from "@/app/actions/email-editor";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";

/** Pestañas del compositor (nota / actividad / correo): solo cambian qué formulario se ve. */
export function ComposerTabs({ note, activity, email, call, files, filesLabel = "Archivos" }: {
  note: React.ReactNode; activity: React.ReactNode; email?: React.ReactNode; call?: React.ReactNode; files?: React.ReactNode; filesLabel?: string;
}) {
  const [tab, setTab] = useState<"note" | "activity" | "call" | "email" | "files">("note");
  const tabs = [
    { key: "note" as const, label: "Nota", content: note },
    { key: "activity" as const, label: "Actividad", content: activity },
    ...(call ? [{ key: "call" as const, label: "Llamada", content: call }] : []),
    ...(email ? [{ key: "email" as const, label: "Correo", content: email }] : []),
    ...(files ? [{ key: "files" as const, label: filesLabel, content: files }] : []),
  ];
  return (
    <div className="composer">
      <div className="composer-tabs" role="tablist">
        {tabs.map((t) => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>{t.label}</button>)}
      </div>
      {tabs.map((t) => <div key={t.key} hidden={tab !== t.key}>{t.content}</div>)}
    </div>
  );
}

export type ComposerTemplate = { id: string; name: string; subject: string; body: string };

/**
 * Campos del correo de la ficha: plantilla, asunto, texto con «Insertar mis
 * huecos», seguimiento de aperturas y envío programado. Las plantillas llegan
 * ya con los datos del deal; {huecos} se rellena aquí, leyendo el calendario.
 */
export type EngagementHint = { temperature: "caliente" | "templado" | "frio" | "sin_datos"; headline: string; advice: string };
const TEMP_LABEL = { caliente: "Caliente", templado: "Templado", frio: "Frío", sin_datos: "Sin datos" } as const;

export function EmailComposerFields({ dealId, templates, trackDefault, trackAvailable, signatureHtml, engagement = {}, personId, aiReady }: {
  dealId: string; templates: ComposerTemplate[]; trackDefault: boolean; trackAvailable: boolean;
  /** Cómo ha respondido cada posible destinatario a los correos anteriores. */
  engagement?: Record<string, EngagementHint>;
  /** Destinatario fijo (ficha de contacto); si no, se lee del desplegable «Para». */
  personId?: string;
  aiReady?: boolean;
  /** Firma de quien envía, ya con sus datos (vacía si no tiene). */
  signatureHtml?: string;
}) {
  const [withSig, setWithSig] = useState(Boolean(signatureHtml));
  const ref = useRef<HTMLTextAreaElement>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [later, setLater] = useState(false);
  const [sendAt, setSendAt] = useState("");
  const [state, setState] = useState<{ loading?: boolean; error?: string }>({});
  const [to, setTo] = useState<string | undefined>(personId);
  const [ask, setAsk] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  // El destinatario elegido en «Para» (en la ficha del deal).
  useEffect(() => {
    if (personId) return;
    const sel = ref.current?.form?.querySelector<HTMLSelectElement>("select[name=person_id]");
    if (!sel) return;
    const sync = () => setTo(sel.value);
    sync();
    sel.addEventListener("change", sync);
    return () => sel.removeEventListener("change", sync);
  }, [personId]);
  const hint = to ? engagement[to] : undefined;

  async function writeWithAi(mode: "escribir" | "mejorar") {
    setAiBusy(true); setState({});
    try {
      const r = await aiEmailAction({ subject, body, format: "text", personId: to ?? null, dealId: dealId || null, personalized: true, mode,
                                      instructions: ask || (mode === "escribir" ? "Seguimiento para avanzar al siguiente paso." : "") });
      if (r.error) setState({ error: r.error });
      else { if (r.subject && (!subject || mode === "escribir")) setSubject(r.subject); if (r.body) setBody(r.body); }
    } finally { setAiBusy(false); }
  }

  // Tras enviar, el formulario se vacía (también lo que controla este componente).
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const clear = () => { setSubject(""); setBody(""); setTemplateId(""); setLater(false); setSendAt(""); setState({}); setWithSig(Boolean(signatureHtml)); };
    form.addEventListener("reset", clear);
    return () => form.removeEventListener("reset", clear);
  }, [signatureHtml]);

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
      {hint && (
        <div className={`engagement temp-${hint.temperature}`} role="note" aria-label="Cómo ha respondido a tus correos">
          <span className="temp-badge">{TEMP_LABEL[hint.temperature]}</span>
          <div><strong>{hint.headline}</strong><div className="meta">{hint.advice}</div></div>
        </div>
      )}
      {aiReady && (
        <div className="compose-ai">
          <label className="field"><span className="label">Escribir con IA (opcional)</span>
            <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="Qué quieres decirle: p. ej. retomar tras la demo y proponer llamada el jueves" /></label>
          <button type="button" className="btn secondary small" onClick={() => writeWithAi("escribir")} disabled={aiBusy}>{aiBusy ? "Escribiendo…" : "Redactar"}</button>
          {body.trim() && <button type="button" className="btn secondary small" onClick={() => writeWithAi("mejorar")} disabled={aiBusy}>Mejorar lo escrito</button>}
          <span className="meta">Tiene en cuenta el deal y si abrió o respondió tus correos anteriores.</span>
        </div>
      )}
      {templates.length > 0 && (
        <label className="field"><span className="label">Plantilla</span>
          <select value={templateId} onChange={(e) => applyTemplate(e.target.value)} aria-label="Plantilla">
            <option value="">Sin plantilla</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}
      <input type="hidden" name="template_id" value={templateId} />
      <label className="field"><span className="label">Asunto *</span>
        <input name="subject" required value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="field"><span className="label">Texto *</span>
        <textarea ref={ref} name="body" rows={8} required value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {signatureHtml ? (
        <div className="compose-signature">
          <label className="checkbox"><input type="checkbox" name="signature" checked={withSig} onChange={(e) => setWithSig(e.target.checked)} />Añadir mi firma</label>
          {withSig && <div className="signature-preview" aria-label="Firma" dangerouslySetInnerHTML={{ __html: signatureHtml }} />}
          <a className="meta" href="/account#firma">Editar firma</a>
        </div>
      ) : (
        <p className="meta" style={{ margin: 0 }}>Sin firma. <a href="/account#firma">Crear mi firma</a> para que vaya al final de tus correos.</p>
      )}
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
