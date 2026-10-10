"use client";

import { PdfPages } from "./PdfPages";

type F = { id: string; type: string; page: number; x: number; y: number; w: number; h: number; value: string | null; owner: string; color: number };

/** El documento con los campos de cada firmante: lo ya firmado se ve; lo pendiente, como hueco de color. */
export function SignPreview({ url, pages, fields }: { url: string; pages: { w: number; h: number }[]; fields: F[] }) {
  return (
    <PdfPages url={url} pages={pages} label="Documento"
              overlay={(page) => fields.filter((f) => f.page === page).map((f) => (
                <div key={f.id} className={`sf sf-sign other c${f.color} t-${f.type}${f.value ? " filled" : ""}`} title={f.owner}
                     style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}>
                  {f.value && (f.type === "signature" || f.type === "initials") ? <img src={f.value} alt={`Firma de ${f.owner}`} />
                    : f.value && f.type === "checkbox" ? <span className="sf-check">{f.value === "true" ? "✓" : ""}</span>
                    : f.value ? <span className="sf-text">{f.value}</span> : <span className="sf-ph">{f.owner.split(" ")[0]}</span>}
                </div>
              ))} />
  );
}
