"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { declineSignAction, requestSignCodeAction, submitSignatureAction } from "@/app/actions/esign-public";
import type { SignTexts } from "@/lib/esign-i18n";
import { PdfPages } from "./PdfPages";

type View = {
  token: string; title: string; pages: { w: number; h: number }[]; requireCode: boolean; email: string; name: string; color: number;
  today: string; contact: string | null;
  fields: { id: string; type: string; page: number; x: number; y: number; w: number; h: number; required: boolean; hint: string | null; mine: boolean; value: string | null; owner: string; color: number }[];
};
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

/** Página donde firma cada persona: el documento con sus campos encima, y «Terminar de firmar». */
export function SignerApp({ v, t }: { v: View; t: SignTexts }) {
  const router = useRouter();
  const mine = useMemo(() => v.fields.filter((f) => f.mine), [v.fields]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(mine.map((f) => [f.id, f.type === "name" ? v.name : f.type === "date" ? v.today : f.type === "checkbox" ? "false" : ""])));
  const [sig, setSig] = useState<{ signature?: string; initials?: string }>({});
  const [pad, setPad] = useState<{ fieldId: string; kind: "signature" | "initials" } | null>(null);
  const [finish, setFinish] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => { void fetch(`/api/public/firma/${v.token}/view`, { method: "POST" }).catch(() => null); }, [v.token]);

  const filled = (f: View["fields"][number]) => (f.type === "checkbox" ? values[f.id] === "true" : Boolean(values[f.id]));
  const todo = mine.filter((f) => f.required && !filled(f));

  const goNext = () => {
    const next = todo[0] ?? mine.find((f) => !filled(f));
    if (!next) return;
    const el = document.querySelector<HTMLElement>(`[data-field="${next.id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => el?.focus(), 350);
  };
  const clickField = (f: View["fields"][number]) => {
    if (f.type === "signature" || f.type === "initials") {
      const kind = f.type as "signature" | "initials";
      // Una vez adoptada la firma, cada campo se firma con un clic.
      if (sig[kind] && !values[f.id]) setValues((x) => ({ ...x, [f.id]: sig[kind]! }));
      else setPad({ fieldId: f.id, kind });
    } else if (f.type === "checkbox") setValues((x) => ({ ...x, [f.id]: x[f.id] === "true" ? "false" : "true" }));
  };

  return (
    <div className="signer-app">
      <header className="signer-bar">
        <div className="signer-title">
          <strong>{v.title}</strong>
          <span className="meta">{todo.length ? fill(t.fieldsLeft, { n: todo.length }) : t.fieldsDone}</span>
        </div>
        <div className="signer-actions">
          {todo.length > 0 && <button type="button" className="btn secondary" onClick={goNext}>{t.next}</button>}
          <button type="button" className="btn" onClick={() => (todo.length ? goNext() : setFinish(true))} aria-disabled={todo.length > 0}>{t.finish}</button>
          <div className="signer-more">
            <button type="button" className="icon-btn" aria-haspopup="true" aria-expanded={menu} onClick={() => setMenu((m) => !m)} aria-label={t.more} title={t.more}>⋯</button>
            {menu && (
              <div className="rail-pop signer-menu" role="menu">
                <a role="menuitem" href={`/api/public/firma/${v.token}/pdf?dl=1`}>{t.download}</a>
                <button type="button" role="menuitem" onClick={() => { setMenu(false); setDeclining(true); }}>{t.decline}</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="signer-doc">
        <PdfPages url={`/api/public/firma/${v.token}/pdf`} pages={v.pages} label={v.title} loadingText={t.loading}
                  pageLabel={(n) => fill(t.page, { n })}
                  overlay={(page) => v.fields.filter((f) => f.page === page).map((f) => (
                    <SignField key={f.id} f={f} t={t} value={f.mine ? values[f.id] : f.value} filled={f.mine ? filled(f) : Boolean(f.value)}
                               onClick={() => clickField(f)} onText={(val) => setValues((x) => ({ ...x, [f.id]: val }))} />
                  ))} />
      </main>

      {pad && (
        <SignaturePad t={t} kind={pad.kind} name={v.name} onCancel={() => setPad(null)} onAdopt={(png) => {
          setSig((x) => ({ ...x, [pad.kind]: png }));
          // Se aplica a este campo y, de paso, a los demás del mismo tipo que estén vacíos.
          setValues((x) => Object.fromEntries(Object.entries(x).map(([id, val]) => {
            const f = mine.find((m) => m.id === id);
            return [id, f && f.type === pad.kind && (!val || id === pad.fieldId) ? png : val];
          })));
          setPad(null);
        }} />
      )}
      {finish && <FinishDialog v={v} t={t} values={values} onClose={() => setFinish(false)} onDone={() => router.refresh()} />}
      {declining && <DeclineDialog token={v.token} t={t} onClose={() => setDeclining(false)} onDone={() => router.refresh()} />}
    </div>
  );
}

function SignField({ f, t, value, filled, onClick, onText }: {
  f: View["fields"][number]; t: SignTexts; value: string | null | undefined; filled: boolean; onClick: () => void; onText: (v: string) => void;
}) {
  const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
  const cls = `sf sf-sign c${f.color} t-${f.type}${f.mine ? " mine" : " other"}${filled ? " filled" : ""}${f.mine && f.required && !filled ? " todo" : ""}`;
  if (!f.mine) {
    return (
      <div className={cls} style={style} title={value ? fill(t.signedBy, { name: f.owner }) : fill(t.forOther, { name: f.owner })}>
        {value && (f.type === "signature" || f.type === "initials") ? <img src={value} alt={fill(t.signedBy, { name: f.owner })} />
          : value && f.type === "checkbox" ? <span className="sf-check">{value === "true" ? "✓" : ""}</span>
          : value ? <span className="sf-text">{value}</span> : <span className="sf-ph">{fill(t.forOther, { name: f.owner.split(" ")[0] })}</span>}
      </div>
    );
  }
  if (f.type === "name" || f.type === "text") {
    return (
      <div className={cls} style={style}>
        <input data-field={f.id} value={value ?? ""} onChange={(e) => onText(e.target.value)} maxLength={500}
               placeholder={f.hint ?? (f.type === "name" ? t.nameHere : t.textHere)} aria-label={f.hint ?? (f.type === "name" ? t.nameHere : t.textHere)}
               aria-required={f.required} />
      </div>
    );
  }
  if (f.type === "date") {
    return <div className={cls} style={style}><span className="sf-text" data-field={f.id} tabIndex={-1}>{value}</span></div>;
  }
  const label = f.type === "signature" ? t.signHere : f.type === "initials" ? t.initialsHere : "";
  return (
    <button type="button" className={cls} style={style} data-field={f.id} onClick={onClick} role={f.type === "checkbox" ? "checkbox" : undefined}
            aria-checked={f.type === "checkbox" ? value === "true" : undefined}
            aria-label={f.type === "checkbox" ? (f.hint ?? t.required) : `${label}${f.required ? ` (${t.required})` : ""}`}>
      {f.type === "checkbox" ? <span className="sf-check">{value === "true" ? "✓" : ""}</span>
        : value ? <img src={value} alt="" /> : <span className="sf-ph">✎ {label}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Firma: dibujar o escribir

const FONTS = ["'Segoe Script', 'Snell Roundhand', 'Brush Script MT', cursive", "'Bradley Hand', 'Comic Sans MS', cursive", "'Lucida Handwriting', 'Apple Chancery', cursive"];

function SignaturePad({ t, kind, name, onCancel, onAdopt }: { t: SignTexts; kind: "signature" | "initials"; name: string; onCancel: () => void; onAdopt: (png: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<"draw" | "type">("draw");
  const initials = name.split(/\s+/).filter(Boolean).map((p) => p[0]!.toUpperCase()).slice(0, 3).join("");
  const [text, setText] = useState(kind === "initials" ? initials : name);
  const [font, setFont] = useState(0);
  const [ink, setInk] = useState(false);
  const drawing = useRef(false);

  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    const c = canvas.current;
    if (!c || mode !== "draw") return;
    const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    c.width = r.width * dpr; c.height = r.height * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr); g.lineWidth = 2.4; g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "#141a2e";
    setInk(false);
  }, [mode]);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => { const r = e.currentTarget.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = true; e.currentTarget.setPointerCapture(e.pointerId);
    const g = e.currentTarget.getContext("2d")!; const [x, y] = pos(e); g.beginPath(); g.moveTo(x, y); g.lineTo(x + 0.1, y + 0.1); g.stroke();
  };
  const moveP = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const g = e.currentTarget.getContext("2d")!; const [x, y] = pos(e); g.lineTo(x, y); g.stroke(); setInk(true);
  };
  const clear = () => { const c = canvas.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); setInk(false); };

  const adopt = () => {
    if (mode === "draw") { const c = canvas.current!; onAdopt(trim(c)); return; }
    const c = document.createElement("canvas");
    c.width = 900; c.height = 260;
    const g = c.getContext("2d")!;
    g.fillStyle = "#141a2e"; g.textBaseline = "middle";
    let size = kind === "initials" ? 150 : 120;
    g.font = `${size}px ${FONTS[font]}`;
    while (g.measureText(text).width > 860 && size > 30) { size -= 6; g.font = `${size}px ${FONTS[font]}`; }
    g.fillText(text, 20, 130);
    onAdopt(trim(c));
  };

  return (
    <dialog ref={ref} className="drawer sign-pad" aria-label={kind === "signature" ? t.adoptTitle : t.adoptInitials} onClose={onCancel}>
      <div className="drawer-inner">
        <header className="drawer-head"><h2>{kind === "signature" ? t.adoptTitle : t.adoptInitials}</h2>
          <button type="button" className="icon-btn" onClick={() => ref.current?.close()} aria-label={t.cancel}>✕</button></header>
        <div className="drawer-body">
          <div className="chips" role="tablist">
            <button type="button" role="tab" aria-selected={mode === "draw"} onClick={() => setMode("draw")}>{t.draw}</button>
            <button type="button" role="tab" aria-selected={mode === "type"} onClick={() => setMode("type")}>{t.type}</button>
          </div>
          {mode === "draw" ? (
            <>
              <canvas ref={canvas} className="pad-canvas" onPointerDown={down} onPointerMove={moveP} onPointerUp={() => { drawing.current = false; }}
                      aria-label={t.drawHint} />
              <div className="pad-row"><span className="meta">{t.drawHint}</span><button type="button" className="btn-link meta" onClick={clear}>{t.clear}</button></div>
            </>
          ) : (
            <>
              <label className="field"><span className="label">{t.typeHint}</span><input value={text} onChange={(e) => setText(e.target.value)} maxLength={80} autoFocus /></label>
              <div className="type-options" role="radiogroup">
                {FONTS.map((f, i) => (
                  <button key={i} type="button" role="radio" aria-checked={font === i} className={font === i ? "on" : ""} style={{ fontFamily: f }} onClick={() => setFont(i)}>{text || name}</button>
                ))}
              </div>
            </>
          )}
          <div className="form-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn" onClick={adopt} disabled={mode === "draw" ? !ink : !text.trim()}>{t.useThis}</button>
            <button type="button" className="btn secondary" onClick={() => ref.current?.close()}>{t.cancel}</button>
          </div>
        </div>
      </div>
    </dialog>
  );
}

/** Recorta el lienzo a lo dibujado (con un margen) y lo devuelve como PNG. */
function trim(c: HTMLCanvasElement) {
  const g = c.getContext("2d")!;
  const { width: w, height: h } = c;
  const d = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 <= x0 || y1 <= y0) return c.toDataURL("image/png");
  const m = 8, out = document.createElement("canvas");
  out.width = Math.min(w, x1 - x0 + m * 2); out.height = Math.min(h, y1 - y0 + m * 2);
  out.getContext("2d")!.drawImage(c, Math.max(0, x0 - m), Math.max(0, y0 - m), out.width, out.height, 0, 0, out.width, out.height);
  // Más pequeño si hace falta (la firma no necesita más de 600 px de ancho).
  if (out.width > 600) {
    const s = 600 / out.width, small = document.createElement("canvas");
    small.width = 600; small.height = Math.round(out.height * s);
    small.getContext("2d")!.drawImage(out, 0, 0, small.width, small.height);
    return small.toDataURL("image/png");
  }
  return out.toDataURL("image/png");
}

// ---------------------------------------------------------------------------

function FinishDialog({ v, t, values, onClose, onDone }: { v: View; t: SignTexts; values: Record<string, string>; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const askCode = async () => {
    setBusy(true); setError(null);
    const r = await requestSignCodeAction(v.token);
    setBusy(false);
    if (r.error) setError(r.error); else setCodeSent(true);
  };
  const sign = async () => {
    setBusy(true); setError(null);
    const r = await submitSignatureAction(v.token, { values, code: v.requireCode ? code : null, consent });
    if (r.error) { setBusy(false); setError(r.error); return; }
    onDone();
  };
  return (
    <dialog ref={ref} className="drawer sign-finish" aria-label={t.confirmTitle} onClose={onClose}>
      <div className="drawer-inner">
        <header className="drawer-head"><h2>{t.confirmTitle}</h2>
          <button type="button" className="icon-btn" onClick={() => ref.current?.close()} aria-label={t.cancel}>✕</button></header>
        <div className="drawer-body">
          <label className="checkbox consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{t.consent}</label>
          {v.requireCode && (
            <div className="code-box">
              {!codeSent ? (
                <button type="button" className="btn secondary" onClick={askCode} disabled={busy}>{t.sendCode}</button>
              ) : (
                <>
                  <p className="meta" style={{ margin: "0 0 6px" }}>{fill(t.codeTitle, { email: v.email })}</p>
                  <label className="field"><span className="label">{t.codeLabel}</span>
                    <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus /></label>
                  <button type="button" className="btn-link meta" onClick={askCode} disabled={busy}>{t.resend}</button>
                </>
              )}
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions" style={{ marginTop: 16 }}>
            <button type="button" className="btn" onClick={sign} disabled={busy || !consent || (v.requireCode && code.length !== 6)}>{busy ? t.signing : t.sign}</button>
            <button type="button" className="btn secondary" onClick={() => ref.current?.close()}>{t.cancel}</button>
          </div>
        </div>
      </div>
    </dialog>
  );
}

function DeclineDialog({ token, t, onClose, onDone }: { token: string; t: SignTexts; onClose: () => void; onDone: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="drawer" aria-label={t.declineTitle} onClose={onClose}>
      <div className="drawer-inner">
        <header className="drawer-head"><h2>{t.declineTitle}</h2>
          <button type="button" className="icon-btn" onClick={() => ref.current?.close()} aria-label={t.cancel}>✕</button></header>
        <div className="drawer-body">
          <label className="field"><span className="label">{t.declineReason}</span><textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="form-actions">
            <button type="button" className="btn danger" disabled={busy} onClick={async () => {
              setBusy(true); const r = await declineSignAction(token, reason); setBusy(false);
              if (r.error) setError(r.error); else onDone();
            }}>{t.declineConfirm}</button>
            <button type="button" className="btn secondary" onClick={() => ref.current?.close()}>{t.cancel}</button>
          </div>
        </div>
      </div>
    </dialog>
  );
}
