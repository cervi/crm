"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PdfPages } from "../esign/PdfPages";

/**
 * Visor de un documento compartido. Avisa al abrirse y, mientras está a la
 * vista, cada 10 s manda cuánto tiempo lleva y la página más lejana vista.
 */
export function DocViewer({ token, name, mime, sender }: { token: string; name: string; mime: string | null; sender: string | null }) {
  const view = useRef<string | null>(null);
  const seconds = useRef(0);
  const maxPage = useRef(1);
  const [, force] = useState(0);
  const url = `/api/public/d/${token}/file`;
  const pdf = mime === "application/pdf";
  const image = /^image\//.test(mime ?? "");

  useEffect(() => {
    let alive = true;
    void fetch(`/api/public/d/${token}/view`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then((r) => r.json()).then((j) => { if (alive) { view.current = j.view ?? null; force((x) => x + 1); } }).catch(() => null);
    const tick = setInterval(() => {
      if (document.visibilityState !== "visible" || !view.current) return;
      seconds.current += 10;
      void fetch(`/api/public/d/${token}/view`, { method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
        body: JSON.stringify({ view: view.current, seconds: seconds.current, page: maxPage.current }) }).catch(() => null);
    }, 10000);
    return () => { alive = false; clearInterval(tick); };
  }, [token]);
  const seen = useCallback((n: number) => { if (n > maxPage.current) maxPage.current = n; }, []);

  return (
    <div className="doc-viewer">
      <header className="signer-bar">
        <div className="signer-title"><strong>{name}</strong>{sender && <span className="meta">Compartido por {sender}</span>}</div>
        <div className="signer-actions"><a className="btn secondary" href={`${url}?dl=1`}>Descargar</a></div>
      </header>
      <main className="signer-doc">
        {pdf ? <PdfPages url={url} label={name} onPageSeen={seen} />
          : image ? <div className="doc-image"><img src={url} alt={name} /></div>
          : (
            <div className="sign-msg">
              <h1>{name}</h1>
              <p className="muted">Este archivo no se puede ver en el navegador. Descárgalo para abrirlo.</p>
              <p><a className="btn" href={`${url}?dl=1`}>Descargar</a></p>
            </div>
          )}
      </main>
    </div>
  );
}
