"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { saveSignFieldsAction, saveSignSetupAction, sendSignAction } from "@/app/actions/esign";
import { SIGN_LANGUAGES, st, type SignLang } from "@/lib/esign-i18n";
import { Icon } from "../Icon";
import { PdfPages } from "./PdfPages";

// ===========================================================================
// Preparar un documento para firmar, en tres pasos (como en Pipedrive):
//   1. Firmantes y mensaje · 2. Colocar los campos · 3. Revisar y enviar
// ===========================================================================

const TYPES = {
  signature: { label: "Firma", icon: "pencil", w: 0.26, h: 0.06 },
  initials: { label: "Iniciales", icon: "pencil", w: 0.09, h: 0.045 },
  name: { label: "Nombre", icon: "user", w: 0.24, h: 0.03 },
  date: { label: "Fecha de firma", icon: "clock", w: 0.18, h: 0.03 },
  text: { label: "Texto", icon: "list", w: 0.24, h: 0.03 },
  checkbox: { label: "Casilla", icon: "check", w: 0.025, h: 0.018 },
} as const;
type FType = keyof typeof TYPES;

export type EditorSigner = { id?: string; key: string; name: string; email: string; kind: "internal" | "external"; user_id?: string | null; person_id?: string | null; color: number };
export type EditorField = { key: string; signer_id: string; type: FType; page: number; x: number; y: number; w: number; h: number; required: boolean; hint: string | null };
type Suggest = { name: string; email: string; kind: "internal" | "external"; user_id?: string | null; person_id?: string | null; note?: string };

const k = () => Math.random().toString(36).slice(2, 10);

export function SignEditor({ id, init, pages, signers: initSigners, fields: initFields, suggestions, senders, back }: {
  id: string;
  init: { title: string; language: SignLang; subject: string | null; message: string | null; sequential: boolean; require_code: boolean;
          reminder_days: number; expires_days: number; sender_id: string | null };
  pages: { w: number; h: number }[];
  signers: EditorSigner[]; fields: Omit<EditorField, "key">[];
  suggestions: Suggest[]; senders: { id: string; name: string; email: string }[]; back: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3>(initFields.length ? 2 : 1);
  const [s, setS] = useState(init);
  const [signers, setSigners] = useState<EditorSigner[]>(initSigners);
  const [fields, setFields] = useState<EditorField[]>(() => initFields.map((f) => ({ ...f, key: k() })));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof typeof s>(key: K, v: (typeof s)[K]) => setS((x) => ({ ...x, [key]: v }));

  async function saveSetup(): Promise<boolean> {
    setBusy(true); setError(null);
    const r = await saveSignSetupAction(id, s as unknown as Record<string, unknown>, signers.map((x) => ({
      id: x.id ?? null, name: x.name, email: x.email, kind: x.kind, user_id: x.user_id ?? null, person_id: x.person_id ?? null })));
    setBusy(false);
    if (r.error || !r.signers) { setError(r.error ?? "No se ha podido guardar."); return false; }
    // Los firmantes nuevos ya tienen id: se enlazan por orden.
    const fresh = r.signers;
    setSigners(fresh.map((f) => ({ id: f.id, key: f.id, name: f.name, email: f.email, kind: f.kind, user_id: f.user_id, person_id: f.person_id, color: f.color })));
    setFields((list) => list.filter((f) => fresh.some((x) => x.id === f.signer_id)));
    return true;
  }

  const steps = [
    { n: 1 as const, label: "Firmantes y mensaje" }, { n: 2 as const, label: "Colocar los campos" }, { n: 3 as const, label: "Revisar y enviar" },
  ];
  const go = async (n: 1 | 2 | 3) => {
    if (n === step) return;
    if (step === 1 && !(await saveSetup())) return;
    setStep(n);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="sign-editor">
      <ol className="sign-steps" aria-label="Pasos">
        {steps.map((x) => (
          <li key={x.n}>
            <button type="button" aria-current={step === x.n ? "step" : undefined} className={x.n < step ? "done" : undefined}
                    onClick={() => go(x.n)} disabled={busy || (x.n > 1 && signers.length === 0)}>
              <span className="n">{x.n < step ? <Icon name="check" /> : x.n}</span>{x.label}
            </button>
          </li>
        ))}
      </ol>
      {error && <p className="form-error" role="alert">{error}</p>}

      {step === 1 && (
        <StepSetup s={s} set={set} signers={signers} setSigners={setSigners} suggestions={suggestions} senders={senders}
                   onNext={() => go(2)} busy={busy} back={back} />
      )}
      {step === 2 && (
        <StepFields id={id} pages={pages} signers={signers} fields={fields} setFields={setFields} onBack={() => go(1)} onNext={() => go(3)} />
      )}
      {step === 3 && (
        <StepReview id={id} s={s} signers={signers} fields={fields} onBack={() => go(2)} onEditSetup={() => go(1)}
                    onSent={() => router.refresh()} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paso 1

function StepSetup({ s, set, signers, setSigners, suggestions, senders, onNext, busy, back }: {
  s: Parameters<typeof SignEditor>[0]["init"]; set: <K extends keyof Parameters<typeof SignEditor>[0]["init"]>(k: K, v: Parameters<typeof SignEditor>[0]["init"][K]) => void;
  signers: EditorSigner[]; setSigners: (f: (x: EditorSigner[]) => EditorSigner[]) => void; suggestions: Suggest[];
  senders: { id: string; name: string; email: string }[]; onNext: () => void; busy: boolean; back: string;
}) {
  const [adding, setAdding] = useState(false);
  const free = suggestions.filter((x) => !signers.some((y) => y.email.toLowerCase() === x.email.toLowerCase()));
  const add = (x: Partial<Suggest>) => {
    setSigners((list) => [...list, { key: k(), name: x.name ?? "", email: x.email ?? "", kind: x.kind ?? "external", user_id: x.user_id ?? null,
                                      person_id: x.person_id ?? null, color: (Math.max(0, ...list.map((l) => l.color)) % 8) + 1 }]);
    setAdding(false);
  };
  const update = (key: string, patch: Partial<EditorSigner>) => setSigners((list) => list.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const move = (i: number, d: number) => setSigners((list) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const n = [...list]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });
  const lang = s.language;

  return (
    <div className="sign-setup">
      <section className="panel">
        <label className="field"><span className="label">Nombre del documento *</span>
          <input value={s.title} onChange={(e) => set("title", e.target.value)} required maxLength={200} /></label>
      </section>

      <section className="panel" aria-label="Firmantes">
        <div className="sign-head">
          <h2>Firmantes <span className="muted">{signers.length}/10</span></h2>
          <label className="switch-row">
            <button type="button" className={s.sequential ? "switch on" : "switch"} aria-pressed={s.sequential} onClick={() => set("sequential", !s.sequential)} aria-label="Firmar en orden"><i /></button>
            <span><strong>Firmar en orden</strong><span className="meta"> · cada uno recibe el enlace cuando ha firmado el anterior</span></span>
          </label>
        </div>
        {signers.length === 0 && <p className="muted">Añade a quien tiene que firmar: normalmente alguien de tu empresa y una o varias personas del cliente.</p>}
        <ol className="signer-list">
          {signers.map((x, i) => (
            <li key={x.key} className={`c${x.color}`}>
              <span className="signer-n" aria-hidden="true">{s.sequential ? i + 1 : ""}</span>
              {s.sequential && (
                <span className="order-btns">
                  <button type="button" className="icon-btn small" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Subir a ${x.name || "este firmante"}`}><Icon name="up" /></button>
                  <button type="button" className="icon-btn small down" onClick={() => move(i, 1)} disabled={i === signers.length - 1} aria-label={`Bajar a ${x.name || "este firmante"}`}><Icon name="up" /></button>
                </span>
              )}
              <label className="field"><span className="label">Nombre *</span>
                <input value={x.name} onChange={(e) => update(x.key, { name: e.target.value })} required /></label>
              <label className="field"><span className="label">Correo *</span>
                <input type="email" value={x.email} onChange={(e) => update(x.key, { email: e.target.value })} required /></label>
              <label className="field"><span className="label">Es</span>
                <select value={x.kind} onChange={(e) => update(x.key, { kind: e.target.value as "internal" | "external" })}>
                  <option value="internal">De tu empresa</option>
                  <option value="external">Del cliente</option>
                </select></label>
              <button type="button" className="icon-btn" onClick={() => setSigners((l) => l.filter((y) => y.key !== x.key))}
                      aria-label={`Quitar a ${x.name || "este firmante"}`} title="Quitar"><Icon name="x" /></button>
            </li>
          ))}
        </ol>
        {signers.length < 10 && (
          <div className="add-signer">
            {!adding ? (
              <button type="button" className="btn secondary small" onClick={() => setAdding(true)}><Icon name="plus" />Añadir firmante</button>
            ) : (
              <div className="add-signer-menu" role="menu" aria-label="Añadir firmante">
                {free.map((x) => (
                  <button key={x.email} type="button" role="menuitem" onClick={() => add(x)}>
                    <strong>{x.name}</strong><span className="meta">{x.email} · {x.note ?? (x.kind === "internal" ? "de tu empresa" : "del cliente")}</span>
                  </button>
                ))}
                <button type="button" role="menuitem" onClick={() => add({ kind: "external" })}><Icon name="plus" /><strong>Otra persona</strong><span className="meta">escribe su nombre y correo</span></button>
                <button type="button" className="btn-link meta" onClick={() => setAdding(false)}>Cancelar</button>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel" aria-label="Mensaje">
        <h2>Mensaje para los firmantes</h2>
        <div className="grid-2">
          <label className="field"><span className="label">Idioma del correo y de la página de firma</span>
            <select value={s.language} onChange={(e) => set("language", e.target.value as SignLang)}>
              {Object.entries(SIGN_LANGUAGES).map(([code, l]) => <option key={code} value={code}>{l}</option>)}
            </select></label>
          {senders.length > 0 && (
            <label className="field"><span className="label">Se envía desde</span>
              <select value={s.sender_id ?? ""} onChange={(e) => set("sender_id", e.target.value || null)}>
                {senders.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.email}</option>)}
              </select></label>
          )}
        </div>
        <label className="field"><span className="label">Asunto</span>
          <input value={s.subject ?? ""} onChange={(e) => set("subject", e.target.value || null)} maxLength={300}
                 placeholder={st(lang, "inviteSubject", { sender: "Tu nombre", title: s.title || "Contrato" })} /></label>
        <label className="field"><span className="label">Mensaje</span>
          <textarea rows={4} value={s.message ?? ""} onChange={(e) => set("message", e.target.value || null)} maxLength={4000}
                    placeholder={st(lang, "defaultMessage")} />
          <span className="meta">Va dentro del correo, debajo del saludo y antes del botón «{st(lang, "cta")}». Si lo dejas vacío, se usa el texto de ejemplo.</span></label>
      </section>

      <section className="panel" aria-label="Opciones">
        <h2>Opciones</h2>
        <div className="sign-options">
          <label className="checkbox"><input type="checkbox" checked={s.require_code} onChange={(e) => set("require_code", e.target.checked)} />
            <span><strong>Pedir un código por correo antes de firmar</strong><span className="meta"> · comprueba que quien firma tiene acceso a ese correo</span></span></label>
          <label className="field inline-field"><span className="label">Recordar a quien no ha firmado</span>
            <select value={s.reminder_days} onChange={(e) => set("reminder_days", Number(e.target.value))}>
              <option value={0}>No recordar</option>
              {[1, 2, 3, 5, 7].map((d) => <option key={d} value={d}>Cada {d} día{d === 1 ? "" : "s"}</option>)}
            </select></label>
          <label className="field inline-field"><span className="label">El enlace caduca a los</span>
            <select value={s.expires_days} onChange={(e) => set("expires_days", Number(e.target.value))}>
              {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} días</option>)}
            </select></label>
        </div>
      </section>

      <div className="sign-foot">
        <Link href={back} className="btn secondary">Salir (se guarda como borrador)</Link>
        <button type="button" className="btn" onClick={onNext} disabled={busy || signers.length === 0}>{busy ? "Guardando…" : "Siguiente: colocar los campos"}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paso 2

function StepFields({ id, pages, signers, fields, setFields, onBack, onNext }: {
  id: string; pages: { w: number; h: number }[]; signers: EditorSigner[]; fields: EditorField[];
  setFields: (f: (x: EditorField[]) => EditorField[]) => void; onBack: () => void; onNext: () => void;
}) {
  const [who, setWho] = useState<string>(signers[0]?.id ?? "");
  const [placing, setPlacing] = useState<FType | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const first = useRef(true);
  const color = (sid: string) => signers.find((x) => x.id === sid)?.color ?? 1;
  const sel = fields.find((f) => f.key === selected) ?? null;

  // Guardado automático (medio segundo después del último cambio).
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setSave("saving");
    const t = setTimeout(async () => {
      const r = await saveSignFieldsAction(id, fields.map(({ key: _k, ...f }) => f));
      if (r.error) { setSave("error"); setSaveError(r.error); } else { setSave("saved"); setSaveError(null); }
    }, 600);
    return () => clearTimeout(t);
  }, [fields, id]);

  const place = (page: number, fx: number, fy: number) => {
    if (!placing || !who) { setSelected(null); return; }
    const t = TYPES[placing];
    const f: EditorField = { key: k(), signer_id: who, type: placing, page, w: t.w, h: t.h,
      x: Math.min(1 - t.w, Math.max(0, fx - t.w / 2)), y: Math.min(1 - t.h, Math.max(0, fy - t.h / 2)),
      required: placing !== "checkbox" && placing !== "text", hint: null };
    setFields((l) => [...l, f]);
    setSelected(f.key);
    setPlacing(null);
  };
  const update = useCallback((key: string, patch: Partial<EditorField>) => setFields((l) => l.map((f) => (f.key === key ? { ...f, ...patch } : f))), [setFields]);
  const remove = (key: string) => { setFields((l) => l.filter((f) => f.key !== key)); setSelected(null); };

  // Teclado: Supr borra, flechas mueven, Esc cancela.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "Escape") { setPlacing(null); setSelected(null); return; }
      if (!sel) return;
      const step = e.shiftKey ? 0.02 : 0.004;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d) { e.preventDefault(); update(sel.key, { x: clamp(sel.x + d[0], 0, 1 - sel.w), y: clamp(sel.y + d[1], 0, 1 - sel.h) }); }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(sel.key); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  const initialsEverywhere = () => {
    if (!who) return;
    const t = TYPES.initials;
    setFields((l) => [...l, ...pages.map((_, i) => ({ key: k(), signer_id: who, type: "initials" as const, page: i + 1, w: t.w, h: t.h,
      x: 1 - t.w - 0.04, y: 1 - t.h - 0.03 - (signers.findIndex((x) => x.id === who) * (t.h + 0.01)), required: true, hint: null }))
      .filter((n) => !l.some((f) => f.signer_id === who && f.type === "initials" && f.page === n.page))]);
  };
  const missing = signers.filter((x) => !fields.some((f) => f.signer_id === x.id && f.type === "signature"));

  return (
    <div className="sign-fields">
      <aside className="sign-palette" aria-label="Campos">
        <h3>¿De quién es el campo?</h3>
        <div className="who-list" role="radiogroup" aria-label="Firmante">
          {signers.map((x) => (
            <button key={x.key} type="button" role="radio" aria-checked={who === x.id} className={`who c${x.color}`} onClick={() => setWho(x.id!)}>
              <span className="dot" aria-hidden="true" /><span className="nm">{x.name}</span>
              <span className="meta">{fields.filter((f) => f.signer_id === x.id).length}</span>
            </button>
          ))}
        </div>
        <h3>Añadir campo</h3>
        <div className="field-btns">
          {(Object.keys(TYPES) as FType[]).map((t) => (
            <button key={t} type="button" className={placing === t ? `fbtn on c${color(who)}` : `fbtn c${color(who)}`} aria-pressed={placing === t}
                    onClick={() => setPlacing(placing === t ? null : t)}>
              <Icon name={TYPES[t].icon} />{TYPES[t].label}
            </button>
          ))}
        </div>
        <p className="meta palette-hint" role="status">
          {placing ? <>Haz clic en el documento donde quieras el campo «{TYPES[placing].label}». <kbd>Esc</kbd> para cancelar.</>
                   : "Elige un campo y haz clic en el documento. Luego puedes moverlo, cambiarle el tamaño desde la esquina o borrarlo con Supr."}
        </p>
        <button type="button" className="btn-link meta" onClick={initialsEverywhere} disabled={!who}>Iniciales en todas las páginas</button>

        {sel && (
          <div className="field-props" aria-label="Campo seleccionado">
            <h3>{TYPES[sel.type].label}</h3>
            <label className="field"><span className="label">Lo rellena</span>
              <select value={sel.signer_id} onChange={(e) => update(sel.key, { signer_id: e.target.value })}>
                {signers.map((x) => <option key={x.key} value={x.id}>{x.name}</option>)}
              </select></label>
            {sel.type !== "signature" && sel.type !== "date" && sel.type !== "name" && (
              <label className="checkbox"><input type="checkbox" checked={sel.required} onChange={(e) => update(sel.key, { required: e.target.checked })} />Obligatorio</label>
            )}
            {sel.type === "text" && (
              <label className="field"><span className="label">Texto de ayuda</span>
                <input value={sel.hint ?? ""} onChange={(e) => update(sel.key, { hint: e.target.value || null })} placeholder="p. ej. CIF de la empresa" maxLength={120} /></label>
            )}
            <div className="form-actions">
              <button type="button" className="btn secondary small" onClick={() => {
                const c = { ...sel, key: k(), y: clamp(sel.y + sel.h + 0.01, 0, 1 - sel.h) };
                setFields((l) => [...l, c]); setSelected(c.key);
              }}>Duplicar</button>
              <button type="button" className="btn secondary small" onClick={() => remove(sel.key)}>Borrar</button>
            </div>
          </div>
        )}

        <p className={`meta save-state ${save}`} role="status">
          {save === "saving" ? "Guardando…" : save === "saved" ? "Guardado" : save === "error" ? `No se ha guardado: ${saveError}` : ""}
        </p>
      </aside>

      <div className={placing ? "sign-doc placing" : "sign-doc"}>
        <PdfPages url={`/api/firmas/${id}/pdf`} pages={pages} label="Documento" onPageClick={place}
                  overlay={(page) => fields.filter((f) => f.page === page).map((f) => (
                    <EditField key={f.key} f={f} color={color(f.signer_id)} who={signers.find((x) => x.id === f.signer_id)?.name ?? ""}
                               selected={selected === f.key} onSelect={() => setSelected(f.key)} onChange={(p) => update(f.key, p)} />
                  ))} />
      </div>

      <div className="sign-foot sticky">
        <button type="button" className="btn secondary" onClick={onBack}>Atrás</button>
        <span className="meta">
          {fields.length} campo{fields.length === 1 ? "" : "s"}
          {missing.length > 0 && <> · sin campo de firma: {missing.map((m) => m.name).join(", ")} (firmarán en una página que se añade al final)</>}
        </span>
        <button type="button" className="btn" onClick={onNext} disabled={save === "saving"}>Siguiente: revisar y enviar</button>
      </div>
    </div>
  );
}

const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

function EditField({ f, color, who, selected, onSelect, onChange }: {
  f: EditorField; color: number; who: string; selected: boolean; onSelect: () => void; onChange: (p: Partial<EditorField>) => void;
}) {
  const drag = useRef<{ mode: "move" | "size"; sx: number; sy: number; f: EditorField; pw: number; ph: number } | null>(null);
  const start = (mode: "move" | "size") => (e: RPointerEvent<HTMLElement>) => {
    e.stopPropagation(); e.preventDefault();
    onSelect();
    const page = (e.currentTarget as HTMLElement).closest(".pdf-page")!.getBoundingClientRect();
    drag.current = { mode, sx: e.clientX, sy: e.clientY, f, pw: page.width, ph: page.height };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveTo = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / d.pw, dy = (e.clientY - d.sy) / d.ph;
    if (d.mode === "move") onChange({ x: clamp(d.f.x + dx, 0, 1 - d.f.w), y: clamp(d.f.y + dy, 0, 1 - d.f.h) });
    else onChange({ w: clamp(d.f.w + dx, 0.015, 1 - d.f.x), h: clamp(d.f.h + dy, 0.012, 1 - d.f.y) });
  };
  const end = () => { drag.current = null; };
  return (
    <div className={`sf sf-edit c${color}${selected ? " selected" : ""} t-${f.type}`} role="button" tabIndex={0}
         aria-label={`${TYPES[f.type].label} de ${who}${f.required ? "" : " (opcional)"}`}
         style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
         onPointerDown={start("move")} onPointerMove={moveTo} onPointerUp={end} onPointerCancel={end}
         onClick={(e) => e.stopPropagation()} onFocus={onSelect}>
      <span className="sf-label">{f.type === "checkbox" ? "" : TYPES[f.type].label}{f.type !== "checkbox" && <em> · {who.split(" ")[0]}</em>}{!f.required && f.type !== "checkbox" && <em> (opc.)</em>}</span>
      <span className="sf-handle" onPointerDown={start("size")} onPointerMove={moveTo} onPointerUp={end} aria-hidden="true" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paso 3

function StepReview({ id, s, signers, fields, onBack, onEditSetup, onSent }: {
  id: string; s: Parameters<typeof SignEditor>[0]["init"]; signers: EditorSigner[]; fields: EditorField[];
  onBack: () => void; onEditSetup: () => void; onSent: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counts = useMemo(() => new Map(signers.map((x) => [x.id, fields.filter((f) => f.signer_id === x.id)])), [signers, fields]);
  const lang = s.language;
  const send = async () => {
    setBusy(true); setError(null);
    const r = await sendSignAction(id);
    setBusy(false);
    if (r.error) setError(r.error); else onSent();
  };
  return (
    <div className="sign-review">
      <section className="panel">
        <h2>{s.title}</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {s.sequential ? "Se firma en orden: cada persona recibe el enlace cuando ha firmado la anterior." : "Todos reciben el enlace a la vez y firman cuando quieran."}
          {" "}Idioma: {SIGN_LANGUAGES[lang]}. {s.require_code ? "Con código por correo. " : ""}
          {s.reminder_days ? `Recordatorio automático cada ${s.reminder_days} día${s.reminder_days === 1 ? "" : "s"}. ` : "Sin recordatorios automáticos. "}
          Caduca a los {s.expires_days} días. <button type="button" className="btn-link" onClick={onEditSetup}>Cambiar</button>
        </p>
        <ol className="review-signers">
          {signers.map((x, i) => {
            const fs = counts.get(x.id) ?? [];
            const sig = fs.some((f) => f.type === "signature");
            return (
              <li key={x.key} className={`c${x.color}`}>
                <span className="signer-n">{s.sequential ? i + 1 : <span className="dot" />}</span>
                <div><strong>{x.name}</strong> <span className="meta">{x.email} · {x.kind === "internal" ? "de tu empresa" : "del cliente"}</span>
                  <div className={sig ? "meta" : "meta tone-warn"}>{fs.length} campo{fs.length === 1 ? "" : "s"}{sig ? "" : " · sin firma colocada: firmará en una página que se añade al final"}</div></div>
              </li>
            );
          })}
        </ol>
      </section>
      <section className="panel" aria-label="Así les llega el correo">
        <h2>Así les llega el correo</h2>
        <div className="mail-preview">
          <p className="meta" style={{ margin: 0 }}>Asunto: <strong>{s.subject || st(lang, "inviteSubject", { sender: "Tú", title: s.title })}</strong></p>
          <p style={{ whiteSpace: "pre-wrap" }}>{st(lang, "inviteIntro", { name: signers.find((x) => x.kind === "external")?.name.split(" ")[0] ?? "Ana", sender: "Tú", company: "tu empresa", title: s.title })}</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{s.message || st(lang, "defaultMessage")}</p>
          <p><span className="btn small" aria-hidden="true">{st(lang, "cta")}</span></p>
        </div>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="sign-foot">
        <button type="button" className="btn secondary" onClick={onBack}>Atrás</button>
        <button type="button" className="btn" onClick={send} disabled={busy}>{busy ? "Enviando…" : `Enviar a firmar${signers.length > 1 ? ` (${signers.length} firmantes)` : ""}`}</button>
      </div>
    </div>
  );
}
