"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { submitFormAction, type SubmitState } from "@/app/actions/webforms";
import type { FormField } from "@/lib/webforms";

type Msg = { rol: "visitante" | "asistente"; texto: string };

const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

export function PublicForm({ slug, fields, chat, startedAt, utm = {} }: { slug: string; fields: FormField[]; chat: boolean; startedAt: number; utm?: Record<string, string> }) {
  const [mode, setMode] = useState<"form" | "chat">("form");
  const [attribution, setAttribution] = useState<Record<string, string>>(utm);
  // Incrustado en otra web: los utm_* de esa página llegan en el «referrer».
  useEffect(() => {
    if (Object.keys(utm).length || !document.referrer) return;
    try {
      const q = new URL(document.referrer).searchParams;
      const found = Object.fromEntries(UTM_KEYS.map((k) => [k, q.get(k) ?? ""]).filter(([, v]) => v));
      if (Object.keys(found).length) setAttribution(found);
    } catch { /* sin referrer válido */ }
  }, [utm]);
  const [state, action, pending] = useActionState<SubmitState, FormData>(submitFormAction.bind(null, slug), undefined);
  const [, start] = useTransition();

  useEffect(() => {
    if (state?.done?.redirect) window.top!.location.href = state.done.redirect;
  }, [state]);

  if (state?.done) return <p className="webform-done" role="status">{state.done.message}</p>;

  return (
    <>
      {chat && (
        <div className="segmented webform-modes" role="tablist" aria-label="Cómo contactar">
          <button type="button" role="tab" aria-selected={mode === "form"} onClick={() => setMode("form")}>Formulario</button>
          <button type="button" role="tab" aria-selected={mode === "chat"} onClick={() => setMode("chat")}>Chatear</button>
        </div>
      )}
      {mode === "chat" ? <Chat slug={slug} /> : (
        <form className="form" onSubmit={(e) => { e.preventDefault(); const d = new FormData(e.currentTarget); start(() => action(d)); }}>
          <input type="hidden" name="_t" value={startedAt} />
          {Object.entries(attribution).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          {/* Campo trampa para robots: las personas no lo ven. */}
          <label className="hp" aria-hidden="true">Web<input name="website" tabIndex={-1} autoComplete="off" /></label>
          {fields.map((f) => (
            <label key={f.key} className="field"><span className="label">{f.label}{f.required ? " *" : ""}</span>
              {f.key === "message"
                ? <textarea name={f.key} rows={4} required={f.required} />
                : <input name={f.key} required={f.required} type={f.key === "email" ? "email" : f.key === "phone" ? "tel" : "text"}
                         autoComplete={f.key === "email" ? "email" : f.key === "full_name" ? "name" : f.key === "company" ? "organization" : f.key === "phone" ? "tel" : "off"} />}
            </label>
          ))}
          {state?.error && <p className="form-error" role="alert">{state.error}</p>}
          <div className="form-actions"><button type="submit" className="btn" disabled={pending}>{pending ? "Enviando…" : "Enviar"}</button></div>
        </form>
      )}
    </>
  );
}

function Chat({ slug }: { slug: string }) {
  const [messages, setMessages] = useState<Msg[]>([{ rol: "asistente", texto: "¡Hola! ¿En qué te puedo ayudar?" }]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [messages]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    const next = [...messages, { rol: "visitante" as const, texto: t }];
    setMessages(next);
    setText("");
    setBusy(true);
    setError(null);
    try {
      // El saludo inicial no se envía: es del navegador.
      const res = await fetch(`/api/public/chat/${slug}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: next.slice(1) }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "No se pudo enviar.");
      setMessages((m) => [...m, { rol: "asistente", texto: j.reply }]);
      if (j.done) setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo enviar.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat" aria-label="Chat">
      <div className="chat-log" role="log" aria-live="polite">
        {messages.map((m, i) => <p key={i} className={`chat-msg ${m.rol}`}>{m.texto}</p>)}
        {busy && <p className="chat-msg asistente typing">Escribiendo…</p>}
        <div ref={end} />
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {done ? <p className="meta">Conversación enviada. ¡Gracias!</p> : (
        <form className="chat-input" onSubmit={send}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe tu mensaje" aria-label="Tu mensaje" maxLength={2000} />
          <button type="submit" className="btn" disabled={busy || !text.trim()}>Enviar</button>
        </form>
      )}
    </div>
  );
}
