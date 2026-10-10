"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { OPERATORS, VARIABLES } from "@/lib/merge";
import { checkEmail } from "@/lib/email-checks";
import { htmlToText, sanitizeEmailHtml, textToHtml } from "@/lib/email-html";
import {
  aiEmailAction, previewEmailAction, saveEmailTemplateAction, sendTestEmailAction, type AiMode, type PreviewResult,
} from "@/app/actions/email-editor";

// ===========================================================================
// Editor de correos de las secuencias (al estilo de Apollo): texto con
// formato o sencillo, variables con valor por defecto y formato, condiciones,
// plantillas, redacción con IA, revisión en vivo, vista previa con un
// contacto real y envío de prueba. Va dentro de un <form>: deja el asunto,
// el texto y el formato en campos ocultos.
// ===========================================================================

type Format = "text" | "html";
export type EditorTemplate = { id: string; name: string; subject: string; body: string; format: Format };
export type EditorContact = { id: string; label: string; hint?: string | null };
export type CustomVar = { key: string; label: string; group: string };

type Props = {
  initialSubject?: string;
  initialBody?: string;
  initialFormat?: Format;
  /** Las variantes usan el formato del paso. */
  formatLocked?: boolean;
  sequenceId?: string | null;
  contacts?: EditorContact[];
  templates?: EditorTemplate[];
  customVars?: CustomVar[];
  aiReady?: boolean;
  threadReply?: boolean;
  firstStep?: boolean;
  /** Para distinguir varios editores en la misma página (accesibilidad y pruebas). */
  label?: string;
  hideSubject?: boolean;
};

type Panel = null | "vars" | "cond" | "tpl" | "ai" | "link";
type Side = "check" | "preview" | "test";

const SAMPLE = "";

export function EmailEditor(props: Props) {
  const {
    initialSubject = "", initialBody = "", initialFormat = "text", formatLocked, sequenceId, contacts = [], templates = [],
    customVars = [], aiReady, threadReply, firstStep, label = "correo", hideSubject,
  } = props;
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [format, setFormat] = useState<Format>(initialFormat);
  const [sync, setSync] = useState(0);                 // fuerza a volcar `body` en el editor con formato
  const [panel, setPanel] = useState<Panel>(null);
  const [side, setSide] = useState<Side>("check");
  const [undo, setUndo] = useState<{ subject: string; body: string } | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<"subject" | "body">("body");
  const savedRange = useRef<Range | null>(null);

  // Volcar el HTML en el editor cuando cambia desde fuera (plantilla, IA, formato, reset).
  useEffect(() => {
    if (format === "html" && editorRef.current && editorRef.current.innerHTML !== body) editorRef.current.innerHTML = body;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, format]);

  // Al vaciar el formulario (p. ej. tras añadir un paso), vuelve a lo inicial.
  useEffect(() => {
    const form = rootRef.current?.closest("form");
    if (!form) return;
    const onReset = () => {
      setSubject(initialSubject); setBody(initialBody); setFormat(initialFormat); setUndo(null); setSync((n) => n + 1);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [initialSubject, initialBody, initialFormat]);

  const checks = useMemo(() => checkEmail({ subject, body, html: format === "html", threadReply, firstStep }), [subject, body, format, threadReply, firstStep]);

  // --- Edición ---------------------------------------------------------------

  const readEditor = () => { if (editorRef.current) setBody(editorRef.current.innerHTML); };

  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };

  const restoreSelection = () => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    if (savedRange.current && el.contains(savedRange.current.startContainer)) sel.addRange(savedRange.current);
    else { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); sel.addRange(r); }
  };

  const exec = (cmd: string, value?: string) => {
    restoreSelection();
    document.execCommand(cmd, false, value);
    saveSelection();
    readEditor();
  };

  /** Inserta texto donde estaba el cursor (asunto o cuerpo). */
  const insert = (text: string) => {
    if (lastFocus.current === "subject" && !hideSubject) {
      const el = subjectRef.current;
      const at = el?.selectionStart ?? subject.length;
      const end = el?.selectionEnd ?? at;
      const next = subject.slice(0, at) + text + subject.slice(end);
      setSubject(next);
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
      return;
    }
    if (format === "html") {
      restoreSelection();
      document.execCommand("insertText", false, text);
      saveSelection();
      readEditor();
      return;
    }
    const el = textRef.current;
    const at = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? at;
    setBody(body.slice(0, at) + text + body.slice(end));
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(at + text.length, at + text.length); });
  };

  const replaceAll = (next: { subject?: string; body?: string }, keepUndo = true) => {
    if (keepUndo) setUndo({ subject, body });
    if (next.subject !== undefined && !hideSubject) setSubject(next.subject);
    if (next.body !== undefined) { setBody(next.body); setSync((n) => n + 1); }
  };

  const switchFormat = (f: Format) => {
    if (f === format) return;
    const next = f === "html" ? textToHtml(body) : htmlToText(body);
    setFormat(f); setBody(next); setSync((n) => n + 1);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const html = e.clipboardData.getData("text/html");
    if (!html) return;                                     // texto sencillo: lo pega el navegador
    e.preventDefault();
    document.execCommand("insertHTML", false, sanitizeEmailHtml(html));
    readEditor();
  };

  const toggle = (p: Panel) => { if (format === "html") saveSelection(); setPanel(panel === p ? null : p); setNotice(null); };

  // --- Acciones de servidor ----------------------------------------------------

  const draft = () => ({ subject, body, format, sequenceId: sequenceId ?? null });

  const runAi = (mode: AiMode, extra: { instructions?: string; tone?: string } = {}) => {
    setNotice(null);
    startTransition(async () => {
      const r = await aiEmailAction({ ...draft(), personId: previewContact?.id ?? null, mode, ...extra });
      if (r.error) { setNotice({ ok: false, text: r.error }); return; }
      replaceAll(mode === "asuntos" ? { subject: r.subject ?? subject } : { subject: r.subject || subject, body: r.body ?? body });
      setNotice({ ok: true, text: "Listo. Revísalo antes de guardar (puedes deshacerlo)." });
    });
  };

  // --- Vista previa --------------------------------------------------------------

  const [previewContact, setPreviewContact] = useState<EditorContact | null>(contacts[0] ?? null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [lookup, setLookup] = useState("");
  const [found, setFound] = useState<EditorContact[]>([]);
  const [testTo, setTestTo] = useState(SAMPLE);

  useEffect(() => {
    if (side !== "preview") return;
    const t = setTimeout(async () => {
      setPreview(await previewEmailAction({ ...draft(), personId: previewContact?.id ?? null }));
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, subject, body, format, previewContact?.id]);

  useEffect(() => {
    if (lookup.trim().length < 2) { setFound([]); return; }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/lookup?type=persons&q=${encodeURIComponent(lookup)}`, { signal: controller.signal });
        if (res.ok) setFound(await res.json());
      } catch { /* cancelada */ }
    }, 200);
    return () => { clearTimeout(t); controller.abort(); };
  }, [lookup]);

  const sendTest = () => {
    setNotice(null);
    startTransition(async () => {
      const r = await sendTestEmailAction({ ...draft(), personId: previewContact?.id ?? null, to: testTo });
      setNotice(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Enviado." });
    });
  };

  // --- Paneles -------------------------------------------------------------------

  const groups = useMemo(() => {
    const all = [...VARIABLES.map((v) => ({ key: v.key, label: v.label, group: v.group })), ...customVars];
    const map = new Map<string, { key: string; label: string }[]>();
    for (const v of all) map.set(v.group, [...(map.get(v.group) ?? []), v]);
    return [...map.entries()];
  }, [customVars]);

  const scoreTone = checks.score >= 80 ? "good" : checks.score >= 60 ? "warn" : "bad";

  return (
    <div className="email-editor" ref={rootRef}>
      <input type="hidden" name="subject" value={subject} />
      <input type="hidden" name="body" value={body} />
      <input type="hidden" name="format" value={format} />

      <div className="ee-main">
        {!hideSubject && (
          <label className="field"><span className="label">Asunto{threadReply ? " (si respondes en el hilo, se usa «Re: » del anterior)" : ""}</span>
            <input ref={subjectRef} aria-label={`Asunto del ${label}`} value={subject} maxLength={300}
                   onFocus={() => { lastFocus.current = "subject"; }} onChange={(e) => setSubject(e.target.value)}
                   placeholder={threadReply ? "(opcional)" : "p. ej. {{empresa}} + aikit"} />
          </label>
        )}

        <div className="ee-toolbar" role="toolbar" aria-label={`Herramientas del ${label}`}>
          {format === "html" && (
            <>
              <button type="button" title="Negrita" aria-label="Negrita" onMouseDown={(e) => { e.preventDefault(); exec("bold"); }}><b>B</b></button>
              <button type="button" title="Cursiva" aria-label="Cursiva" onMouseDown={(e) => { e.preventDefault(); exec("italic"); }}><i>I</i></button>
              <button type="button" title="Subrayado" aria-label="Subrayado" onMouseDown={(e) => { e.preventDefault(); exec("underline"); }}><u>U</u></button>
              <button type="button" title="Lista" aria-label="Lista con viñetas" onMouseDown={(e) => { e.preventDefault(); exec("insertUnorderedList"); }}>• Lista</button>
              <button type="button" title="Lista numerada" aria-label="Lista numerada" onMouseDown={(e) => { e.preventDefault(); exec("insertOrderedList"); }}>1. Lista</button>
              <button type="button" aria-pressed={panel === "link"} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle("link")}>Enlace</button>
              <button type="button" title="Quitar formato" aria-label="Quitar formato" onMouseDown={(e) => { e.preventDefault(); exec("removeFormat"); }}>Tx</button>
              <span className="ee-sep" />
            </>
          )}
          <button type="button" aria-pressed={panel === "vars"} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle("vars")}>{"{{ }}"} Variables</button>
          <button type="button" aria-pressed={panel === "cond"} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle("cond")}>Si… / si no</button>
          <button type="button" aria-pressed={panel === "tpl"} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle("tpl")}>Plantillas</button>
          <button type="button" aria-pressed={panel === "ai"} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle("ai")}>✦ Escribir con IA</button>
          {undo && <button type="button" onClick={() => { replaceAll(undo, false); setUndo(null); }}>Deshacer</button>}
          {!formatLocked && (
            <select aria-label="Formato del correo" value={format} onChange={(e) => switchFormat(e.target.value as Format)} className="ee-format">
              <option value="text">Texto sencillo</option>
              <option value="html">Con formato</option>
            </select>
          )}
        </div>

        {panel === "vars" && <VarsPanel groups={groups} onPick={(t) => insert(t)} />}
        {panel === "cond" && <CondPanel groups={groups} onPick={(t) => { insert(t); setPanel(null); }} />}
        {panel === "link" && <LinkPanel onPick={(url) => { exec("createLink", url); setPanel(null); }} />}
        {panel === "tpl" && (
          <TemplatesPanel templates={templates} pending={pending}
            onUse={(t) => { replaceAll({ subject: t.subject || subject, body: t.format === format ? t.body : format === "html" ? textToHtml(t.body) : htmlToText(t.body) }); setPanel(null); }}
            onSave={(name) => startTransition(async () => {
              const r = await saveEmailTemplateAction({ name, subject, body, format });
              setNotice(r.error ? { ok: false, text: r.error } : { ok: true, text: r.message ?? "Guardada." });
            })} />
        )}
        {panel === "ai" && <AiPanel ready={Boolean(aiReady)} pending={pending} onRun={runAi} />}
        {notice && <p className={notice.ok ? "form-ok" : "form-error"} role={notice.ok ? "status" : "alert"}>{notice.text}</p>}

        {format === "html" ? (
          <div ref={editorRef} className="ee-body rich" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
               aria-label={`Texto del ${label}`} onInput={readEditor} onBlur={() => { saveSelection(); readEditor(); }}
               onKeyUp={saveSelection} onMouseUp={saveSelection} onFocus={() => { lastFocus.current = "body"; }} onPaste={onPaste} />
        ) : (
          <textarea ref={textRef} className="ee-body" aria-label={`Texto del ${label}`} rows={10} value={body}
                    onFocus={() => { lastFocus.current = "body"; }} onChange={(e) => setBody(e.target.value)} />
        )}
        <p className="meta" style={{ margin: "4px 0 0" }}>
          {checks.words} palabras · {Math.ceil(checks.readSeconds / 10) * 10} s de lectura · Variables: {"{{nombre}}"}, con valor por defecto {"{{cargo|tu equipo}}"}, con formato {"{{empresa->mayusculas}}"}.
        </p>
      </div>

      <aside className="ee-side" aria-label={`Revisión y vista previa del ${label}`}>
        <div className="chips" role="tablist">
          <button type="button" role="tab" aria-selected={side === "check"} onClick={() => setSide("check")}>
            Revisión <span className={`ee-score ${scoreTone}`} aria-label={`Puntuación ${checks.score} de 100`}>{checks.score}</span>
          </button>
          <button type="button" role="tab" aria-selected={side === "preview"} onClick={() => setSide("preview")}>Vista previa</button>
          <button type="button" role="tab" aria-selected={side === "test"} onClick={() => setSide("test")}>Enviar prueba</button>
        </div>

        {side === "check" && (
          <ul className="ee-checks">
            {checks.items.map((c, i) => (
              <li key={i} className={c.level}><span aria-hidden>{c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✕"}</span>{c.text}</li>
            ))}
          </ul>
        )}

        {(side === "preview" || side === "test") && (
          <div className="ee-contact">
            <label className="field"><span className="label">Con los datos de</span>
              <select aria-label="Contacto de la vista previa" value={previewContact?.id ?? ""}
                      onChange={(e) => setPreviewContact([...contacts, ...found].find((c) => c.id === e.target.value) ?? null)}>
                <option value="">Datos de ejemplo</option>
                {[...contacts, ...found.filter((f) => !contacts.some((c) => c.id === f.id)), ...(previewContact && ![...contacts, ...found].some((c) => c.id === previewContact.id) ? [previewContact] : [])]
                  .map((c) => <option key={c.id} value={c.id}>{c.label}{c.hint ? ` · ${c.hint}` : ""}</option>)}
              </select>
            </label>
            <input aria-label="Buscar otro contacto" placeholder="Buscar otro contacto…" value={lookup} onChange={(e) => setLookup(e.target.value)} />
            {found.length > 0 && (
              <div className="ee-found">
                {found.slice(0, 6).map((f) => (
                  <button type="button" key={f.id} className="link-btn" onClick={() => { setPreviewContact(f); setLookup(""); setFound([]); }}>{f.label}</button>
                ))}
              </div>
            )}
          </div>
        )}

        {side === "preview" && (
          preview?.error ? <p className="form-error">{preview.error}</p> : !preview ? <p className="muted">Preparando la vista previa…</p> : (
            <div className="ee-preview" aria-label="Vista previa">
              {(preview.missing?.length || preview.unknown?.length || preview.errors?.length) ? (
                <div className="ee-warn" role="alert">
                  {preview.errors?.map((e) => <div key={e}>{e}</div>)}
                  {preview.unknown?.length ? <div>No existen: {preview.unknown.map((k) => `{{${k}}}`).join(", ")}</div> : null}
                  {preview.missing?.length ? <div>A {preview.contact ?? "este contacto"} le falta: {preview.missing.map((k) => `{{${k}}}`).join(", ")}. Pon un valor por defecto ({`{{${preview.missing[0]}|…}}`}) o el correo no saldrá: su inscripción quedará en pausa hasta completarlo.</div> : null}
                </div>
              ) : null}
              <div className="ee-head">
                {preview.to && <div><span className="muted">Para:</span> {preview.contact} &lt;{preview.to}&gt;</div>}
                <div><span className="muted">Asunto:</span> <strong>{preview.subject || (threadReply ? "Re: (asunto del correo anterior)" : "(sin asunto)")}</strong></div>
              </div>
              <iframe title="Vista previa del correo" sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><style>body{font:14px/1.5 Arial,Helvetica,sans-serif;color:#16202e;margin:12px;word-wrap:break-word}a{color:#1f5fd6}p{margin:0 0 10px}</style>${preview.html ?? ""}`} />
            </div>
          )
        )}

        {side === "test" && (
          <div className="form" style={{ gap: 8 }}>
            <label className="field"><span className="label">Enviar a</span>
              <input type="email" aria-label="Enviar la prueba a" placeholder="Tu correo (por defecto)" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
            </label>
            <p className="meta" style={{ margin: 0 }}>Sale desde tu correo conectado con «[Prueba]» en el asunto y {previewContact ? `los datos de ${previewContact.label}` : "datos de ejemplo"}. No cuenta en las estadísticas.</p>
            <div><button type="button" className="btn secondary small" disabled={pending} onClick={sendTest}>{pending ? "Enviando…" : "Enviar prueba"}</button></div>
          </div>
        )}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------

function VarsPanel({ groups, onPick }: { groups: [string, { key: string; label: string }[]][]; onPick: (t: string) => void }) {
  const [q, setQ] = useState("");
  const [fallback, setFallback] = useState("");
  const [op, setOp] = useState("");
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const tag = (key: string) => `{{${key}${op ? `->${op}` : ""}${fallback.trim() ? `|${fallback.trim()}` : ""}}}`;
  return (
    <div className="ee-panel" aria-label="Variables">
      <div className="ee-row">
        <input aria-label="Buscar variable" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        <input aria-label="Valor por defecto" placeholder="Valor si falta (opcional)" value={fallback} onChange={(e) => setFallback(e.target.value)} />
        <select aria-label="Formato de la variable" value={op} onChange={(e) => setOp(e.target.value)}>
          <option value="">Tal cual</option>
          {OPERATORS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>
      <div className="ee-vars">
        {groups.map(([group, vars]) => {
          const list = vars.filter((v) => !q || norm(v.label + " " + v.key).includes(norm(q)));
          if (!list.length) return null;
          return (
            <div key={group}>
              <div className="dropdown-label">{group}</div>
              {list.map((v) => (
                <button type="button" key={v.key} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(tag(v.key))} title={tag(v.key)}>
                  {v.label} <code>{`{{${v.key}}}`}</code>
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <p className="meta" style={{ margin: 0 }}>Fechas: {"{{hoy_dia_semana->mas_2}}"} es el día laborable dentro de dos (sin fines de semana). También valen los nombres de Apollo ({"{{first_name}}"}, {"{{company}}"}…).</p>
    </div>
  );
}

const COND_OPS = [
  { v: "", l: "tiene valor" }, { v: "!", l: "está vacío" }, { v: "==", l: "es igual a" }, { v: "!=", l: "es distinto de" },
  { v: ">", l: "es mayor que" }, { v: "<", l: "es menor que" }, { v: "contiene", l: "contiene" },
];

function CondPanel({ groups, onPick }: { groups: [string, { key: string; label: string }[]][]; onPick: (t: string) => void }) {
  const [key, setKey] = useState("cargo");
  const [op, setOp] = useState("");
  const [value, setValue] = useState("");
  const [yes, setYes] = useState("");
  const [no, setNo] = useState("");
  const cond = op === "!" ? `!${key}` : op ? `${key} ${op} "${value}"` : key;
  const text = `{{#if ${cond}}}${yes}${no ? `{{#else}}${no}` : ""}{{#endif}}`;
  return (
    <div className="ee-panel" aria-label="Condición">
      <div className="ee-row">
        <select aria-label="Variable de la condición" value={key} onChange={(e) => setKey(e.target.value)}>
          {groups.map(([g, vars]) => <optgroup key={g} label={g}>{vars.map((v) => <option key={v.key} value={v.key}>{v.label}</option>)}</optgroup>)}
        </select>
        <select aria-label="Comparación" value={op} onChange={(e) => setOp(e.target.value)}>
          {COND_OPS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
        {op && op !== "!" && <input aria-label="Valor de la comparación" placeholder="valor" value={value} onChange={(e) => setValue(e.target.value)} />}
      </div>
      <input aria-label="Texto si se cumple" placeholder="Texto si se cumple" value={yes} onChange={(e) => setYes(e.target.value)} />
      <input aria-label="Texto si no se cumple" placeholder="Texto si no (opcional)" value={no} onChange={(e) => setNo(e.target.value)} />
      <div className="ee-row">
        <code className="ee-code">{text}</code>
        <button type="button" className="btn secondary small" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(text)}>Insertar</button>
      </div>
    </div>
  );
}

function LinkPanel({ onPick }: { onPick: (url: string) => void }) {
  const [url, setUrl] = useState("https://");
  const ok = /^(https?:\/\/[^\s]+\.[^\s]+|mailto:[^\s]+@[^\s]+|\{\{\s*\w+\s*\}\})$/.test(url.trim());
  return (
    <div className="ee-panel ee-row" aria-label="Enlace">
      <input aria-label="Dirección del enlace" value={url} onChange={(e) => setUrl(e.target.value)} />
      <button type="button" className="btn secondary small" disabled={!ok} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(url.trim())}>Enlazar el texto seleccionado</button>
      <button type="button" className="btn secondary small" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick("{{enlace_reserva}}")}>Enlace de reserva</button>
    </div>
  );
}

function TemplatesPanel({ templates, onUse, onSave, pending }: { templates: EditorTemplate[]; onUse: (t: EditorTemplate) => void; onSave: (name: string) => void; pending: boolean }) {
  const [name, setName] = useState("");
  return (
    <div className="ee-panel" aria-label="Plantillas">
      {templates.length === 0 ? <p className="muted" style={{ margin: 0 }}>Aún no hay plantillas.</p> : (
        <div className="ee-vars">
          {templates.map((t) => (
            <button type="button" key={t.id} onClick={() => onUse(t)} title={t.subject}>{t.name} <span className="muted">{t.subject}</span></button>
          ))}
        </div>
      )}
      <div className="ee-row">
        <input aria-label="Nombre de la plantilla" placeholder="Guardar este correo como plantilla…" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn secondary small" disabled={!name.trim() || pending} onClick={() => { onSave(name.trim()); setName(""); }}>Guardar plantilla</button>
      </div>
    </div>
  );
}

function AiPanel({ ready, pending, onRun }: { ready: boolean; pending: boolean; onRun: (m: AiMode, extra?: { instructions?: string; tone?: string }) => void }) {
  const [instructions, setInstructions] = useState("");
  const [tone, setTone] = useState("más cercano");
  if (!ready) return <div className="ee-panel"><p className="muted" style={{ margin: 0 }}>Configura la IA en Ajustes → IA para escribir y mejorar correos.</p></div>;
  return (
    <div className="ee-panel" aria-label="Escribir con IA">
      <textarea aria-label="Instrucciones para la IA" rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)}
                placeholder="p. ej. Primer correo para directores comerciales de logística: les ayudamos a no perder seguimientos. Pide una llamada de 15 min." />
      <div className="ee-row">
        <button type="button" className="btn secondary small" disabled={pending || !instructions.trim()} onClick={() => onRun("escribir", { instructions })}>{pending ? "Escribiendo…" : "Escribir"}</button>
        <button type="button" className="btn secondary small" disabled={pending} onClick={() => onRun("mejorar", { instructions })}>Mejorar</button>
        <button type="button" className="btn secondary small" disabled={pending} onClick={() => onRun("acortar")}>Acortar</button>
        <button type="button" className="btn secondary small" disabled={pending} onClick={() => onRun("asuntos")}>Otro asunto</button>
        <select aria-label="Tono" value={tone} onChange={(e) => setTone(e.target.value)}>
          {["más cercano", "más formal", "más directo", "más cálido", "más breve y casual"].map((t) => <option key={t}>{t}</option>)}
        </select>
        <button type="button" className="btn secondary small" disabled={pending} onClick={() => onRun("tono", { tone })}>Cambiar tono</button>
      </div>
    </div>
  );
}
