"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Asunto de la actividad con una ficha al pasar el ratón: qué hay que hacer
 * (la descripción), cuándo, con quién y el enlace a la reunión.
 */
export function ActivityHover({ href, children, card }: {
  href: string | null;
  children: ReactNode;
  card: { type: string; when: string; duration: string | null; note: string | null; meeting: string | null;
          who: string | null; owner: string | null; prep: boolean; overdue: string | null; outcome: string | null };
}) {
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);

  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const up = r.bottom + 260 > window.innerHeight;
      setPos({ top: up ? r.top - 8 : r.bottom + 8, left: Math.min(r.left, window.innerWidth - 400), up });
    }, 280);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPos(null), 160);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!pos) return;
    const off = () => setPos(null);
    window.addEventListener("scroll", off, true);
    return () => window.removeEventListener("scroll", off, true);
  }, [pos]);

  const note = card.note?.replace(/\n{3,}/g, "\n\n").trim();
  return (
    <span className="act-hover" ref={anchor} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {href ? <Link href={href} className="act-subject">{children}</Link> : <span className="act-subject">{children}</span>}
      {pos && (
        <div className={`act-card${pos.up ? " up" : ""}`} role="tooltip" style={{ top: pos.top, left: pos.left }}
             onMouseEnter={show} onMouseLeave={hide}>
          <div className="act-card-head">
            <span className="badge">{card.type}</span>
            <span className={card.overdue ? "tone-bad" : "meta"}>{card.when}{card.duration ? ` · ${card.duration}` : ""}</span>
          </div>
          {card.overdue && <p className="act-card-alert">{card.overdue}</p>}
          {note ? <p className="act-card-note">{note.length > 600 ? `${note.slice(0, 600)}…` : note}</p>
                : <p className="meta" style={{ margin: 0 }}>Sin descripción.</p>}
          <dl>
            {card.who && <div><dt>Con</dt><dd>{card.who}</dd></div>}
            {card.owner && <div><dt>Responsable</dt><dd>{card.owner}</dd></div>}
            {card.outcome && <div><dt>Resultado</dt><dd>{card.outcome}</dd></div>}
          </dl>
          {(card.meeting || card.prep) && (
            <div className="act-card-foot">
              {card.meeting && <a href={card.meeting} target="_blank" rel="noreferrer" className="btn small">Unirse a la reunión</a>}
              {card.prep && <span className="badge ai">Ficha de preparación lista</span>}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
