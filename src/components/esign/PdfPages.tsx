"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// pdf.js se carga solo en el navegador y solo cuando hace falta.
type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> };
type PdfPage = {
  getViewport(o: { scale: number }): { width: number; height: number };
  render(o: { canvas: HTMLCanvasElement; viewport: { width: number; height: number } }): { promise: Promise<void>; cancel(): void };
};

let lib: Promise<{ getDocument(src: { url: string; withCredentials?: boolean }): { promise: Promise<PdfDoc> } }> | null = null;
function pdfjs() {
  lib ??= import("pdfjs-dist").then((m) => {
    m.GlobalWorkerOptions.workerSrc = "/api/public/pdf-worker";
    return m as unknown as { getDocument(src: { url: string; withCredentials?: boolean }): { promise: Promise<PdfDoc> } };
  });
  return lib;
}

/**
 * Las páginas de un PDF una debajo de otra, al ancho disponible, con una capa
 * encima de cada una para los campos. Las páginas ocupan su sitio desde el
 * principio (se sabe su tamaño) y se pintan al acercarse a la vista.
 */
export function PdfPages({ url, pages, overlay, onPageClick, label, loadingText = "Cargando el documento…", pageLabel = (n: number) => `Página ${n}` }: {
  url: string; pages: { w: number; h: number }[]; overlay?: (page: number) => ReactNode;
  onPageClick?: (page: number, fx: number, fy: number) => void; label?: string; loadingText?: string; pageLabel?: (n: number) => string;
}) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true, loaded: PdfDoc | null = null;
    pdfjs().then((m) => m.getDocument({ url, withCredentials: true }).promise).then((d) => {
      loaded = d;
      if (alive) setDoc(d); else void d.destroy();
    }).catch((err) => { if (alive) setError(err instanceof Error ? err.message : "No se pudo abrir el PDF."); });
    return () => { alive = false; if (loaded) void loaded.destroy(); };
  }, [url]);

  return (
    <div className="pdf-pages" aria-label={label}>
      {error && <p className="form-error" role="alert">No se ha podido mostrar el PDF: {error}</p>}
      {!doc && !error && <p className="meta pdf-loading" role="status">{loadingText}</p>}
      {pages.map((p, i) => (
        <PdfPageView key={i} doc={doc} n={i + 1} w={p.w} h={p.h} label={pageLabel(i + 1)}
                     onClick={onPageClick ? (fx, fy) => onPageClick(i + 1, fx, fy) : undefined}>
          {overlay?.(i + 1)}
        </PdfPageView>
      ))}
    </div>
  );
}

function PdfPageView({ doc, n, w, h, label, onClick, children }: {
  doc: PdfDoc | null; n: number; w: number; h: number; label: string; onClick?: (fx: number, fy: number) => void; children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { rootMargin: "600px 0px" });
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    io.observe(el); ro.observe(el);
    return () => { io.disconnect(); ro.disconnect(); };
  }, []);

  useEffect(() => {
    if (!doc || !visible || !width || !canvas.current) return;
    let task: { promise: Promise<void>; cancel(): void } | null = null, cancelled = false;
    const t = setTimeout(async () => {
      const page = await doc.getPage(n);
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      const c = canvas.current;
      c.width = Math.floor(viewport.width); c.height = Math.floor(viewport.height);
      task = page.render({ canvas: c, viewport });
      task.promise.catch(() => { /* cancelado al cambiar de tamaño */ });
    }, 60);
    return () => { cancelled = true; clearTimeout(t); task?.cancel(); };
  }, [doc, visible, width, n]);

  return (
    <div ref={box} className="pdf-page" style={{ aspectRatio: `${w} / ${h}` }} aria-label={label} data-page={n}
         onClick={onClick ? (e) => {
           if ((e.target as HTMLElement).closest(".sf")) return;   // clic en un campo: no es «colocar aquí»
           const r = e.currentTarget.getBoundingClientRect();
           onClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
         } : undefined}>
      <canvas ref={canvas} className="pdf-canvas" aria-hidden="true" />
      <div className="pdf-overlay">{children}</div>
    </div>
  );
}
