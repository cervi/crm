"use client";

import Link from "next/link";
import { useState } from "react";

type Opt = { value: string; label: string };
type Preview = { headers: string[]; mapping: string[]; sample: string[][]; total: number };
type Result = { total: number; created: number; updated: number; skipped: number; errors: { row: number; message: string }[] };

export function CsvImporter({ fields }: { fields: Opt[] }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<string[]>([]);
  const [mode, setMode] = useState<"leads" | "contacts">("leads");
  const [source, setSource] = useState("importación CSV");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const call = async (body: object) => {
    const res = await fetch("/api/import/csv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error ?? "No se pudo leer el archivo.");
    return j;
  };

  async function onFile(file: File | undefined) {
    setError(null); setResult(null); setPreview(null);
    if (!file) return;
    // Excel guarda a veces en Windows-1252: si no es UTF-8 válido, se lee así.
    const buf = await file.arrayBuffer();
    let t: string;
    try { t = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { t = new TextDecoder("windows-1252").decode(buf); }
    setText(t); setName(file.name); setBusy(true);
    try {
      const p: Preview = await call({ text: t, step: "preview" });
      setPreview(p); setMapping(p.mapping);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    setBusy(true); setError(null);
    try {
      setResult(await call({ text, mapping, mode, source }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <section className="panel" role="status">
        <h2>Importación terminada</h2>
        <p><strong>{result.created}</strong> nuevos · <strong>{result.updated}</strong> ya existían (actualizados) · <strong>{result.skipped}</strong> sin importar, de {result.total} filas.</p>
        {result.errors.length > 0 && (
          <details open={result.errors.length < 10}>
            <summary className="meta">Filas que no se importaron</summary>
            <ul className="plain-list">{result.errors.map((e) => <li key={e.row}>Fila {e.row}: {e.message}</li>)}</ul>
          </details>
        )}
        <p><Link href={mode === "leads" ? "/leads" : "/persons"}>Ver {mode === "leads" ? "los leads" : "los contactos"}</Link> · <button type="button" className="link-btn" onClick={() => { setResult(null); setPreview(null); setText(""); }}>Importar otro archivo</button></p>
      </section>
    );
  }

  return (
    <section className="panel">
      <label className="field"><span className="label">Archivo CSV</span>
        <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => onFile(e.target.files?.[0])} disabled={busy} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      {preview && (
        <>
          <p className="meta">{name}: {preview.total} filas. Revisa qué es cada columna:</p>
          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table className="csv-preview">
              <thead>
                <tr>{preview.headers.map((h, i) => (
                  <th key={i}>
                    <div>{h || `Columna ${i + 1}`}</div>
                    <select aria-label={`Campo de la columna ${h || i + 1}`} value={mapping[i] ?? ""} onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? e.target.value : x)))}>
                      <option value="">No importar</option>
                      {fields.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </th>
                ))}</tr>
              </thead>
              <tbody>
                {preview.sample.map((r, i) => <tr key={i}>{preview.headers.map((_, j) => <td key={j}>{r[j]}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
          <div className="form inline">
            <label className="field"><span className="label">Crear</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as "leads" | "contacts")}>
                <option value="leads">Leads (con su contacto y empresa)</option>
                <option value="contacts">Solo contactos y empresas</option>
              </select></label>
            {mode === "leads" && <label className="field"><span className="label">Origen si no viene en el archivo</span><input value={source} onChange={(e) => setSource(e.target.value)} /></label>}
            <div className="form-actions"><button type="button" className="btn" onClick={run} disabled={busy || !mapping.includes("email")}>{busy ? "Importando…" : `Importar ${preview.total} filas`}</button></div>
          </div>
          {!mapping.includes("email") && <p className="meta tone-bad">Indica qué columna es el email.</p>}
        </>
      )}
    </section>
  );
}
