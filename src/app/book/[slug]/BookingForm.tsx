"use client";

import { useActionState, useState, useTransition } from "react";
import { bookAction, type BookState } from "@/app/actions/booking";

type Slot = { start: string; end: string };

/** Elegir día y hora, y los datos de quien reserva. */
export function BookingForm({ slug, token, timezone, slots, person }: {
  slug: string; token: string | null; timezone: string; slots: Slot[]; person: { name: string; email: string } | null;
}) {
  const [state, action, pending] = useActionState<BookState, FormData>(bookAction.bind(null, slug), undefined);
  const [, start] = useTransition();
  const [chosen, setChosen] = useState<string>("");
  const dayFmt = new Intl.DateTimeFormat("es-ES", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" });
  const hourFmt = new Intl.DateTimeFormat("es-ES", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const days = new Map<string, Slot[]>();
  for (const s of slots) {
    const k = dayFmt.format(new Date(s.start));
    days.set(k, [...(days.get(k) ?? []), s]);
  }
  const [day, setDay] = useState<string>(days.keys().next().value ?? "");

  if (state?.done) {
    const s = new Date(state.done.start);
    return (
      <section className="booking-done" role="status">
        <h2>¡Reserva confirmada!</h2>
        <p><strong>{cap(dayFmt.format(s))}, {hourFmt.format(s)} – {hourFmt.format(new Date(state.done.end))}</strong></p>
        <p className="muted">Te llegará la invitación del calendario a tu correo.{state.done.joinUrl ? " Este es el enlace de la videollamada:" : ""}</p>
        {state.done.joinUrl && <p><a href={state.done.joinUrl}>{state.done.joinUrl}</a></p>}
      </section>
    );
  }

  return (
    <form
      className="booking-form"
      onSubmit={(e) => { e.preventDefault(); const data = new FormData(e.currentTarget); start(() => action(data)); }}
    >
      <div className="booking-days" role="tablist" aria-label="Día">
        {[...days.keys()].map((k) => (
          <button key={k} type="button" role="tab" aria-selected={day === k} onClick={() => { setDay(k); setChosen(""); }}>
            {cap(k)}
          </button>
        ))}
      </div>
      <fieldset className="booking-slots">
        <legend className="label">Hora</legend>
        {(days.get(day) ?? []).map((s) => (
          <label key={s.start} className={chosen === s.start ? "slot chosen" : "slot"}>
            <input type="radio" name="start" value={s.start} checked={chosen === s.start} onChange={() => setChosen(s.start)} required />
            {hourFmt.format(new Date(s.start))}
          </label>
        ))}
      </fieldset>
      {token && <input type="hidden" name="r" value={token} />}
      <div className="grid-2">
        <label className="field"><span className="label">Tu nombre</span><input name="name" required defaultValue={person?.name} autoComplete="name" /></label>
        <label className="field"><span className="label">Tu email</span><input name="email" type="email" required defaultValue={person?.email} autoComplete="email" /></label>
      </div>
      {!person && <label className="field"><span className="label">Empresa</span><input name="company" autoComplete="organization" /></label>}
      <label className="field"><span className="label">¿Algo que debamos saber? (opcional)</span><textarea name="note" rows={3} /></label>
      {state?.error && <p className="form-error" role="alert">{state.error}</p>}
      <div className="form-actions">
        <button type="submit" className="btn" disabled={pending || !chosen}>{pending ? "Reservando…" : "Reservar"}</button>
      </div>
    </form>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
