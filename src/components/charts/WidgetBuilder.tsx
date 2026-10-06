"use client";

import { useEffect, useMemo, useState } from "react";
import { ActionForm } from "../ActionForm";
import { WidgetView, type Result } from "./WidgetView";
import type { ActionState } from "@/lib/errors";

type Opt = { value: string; label: string };
type SourceCatalog = { label: string; metrics: Opt[]; groups: (Opt & { time?: boolean })[]; dates: Opt[] };
export type Catalog = Record<"deals" | "leads" | "activities", SourceCatalog>;
type Config = {
  source: "deals" | "leads" | "activities"; metric: string; group_by: string; date_field: string;
  period: string; chart: string; limit?: number; filters: Record<string, string | undefined>;
};

type Props = {
  action: (s: ActionState, f: FormData) => Promise<ActionState>;
  catalog: Catalog;
  periods: Opt[];
  charts: Opt[];
  pipelines: Opt[];
  users: Opt[];
  initial?: { title: string; width: 1 | 2; config: Config };
  submitLabel: string;
};

const STATUS: Record<string, Opt[]> = {
  deals: [{ value: "open", label: "Abiertos" }, { value: "won", label: "Ganados" }, { value: "lost", label: "Perdidos" }],
  leads: [{ value: "open", label: "Abiertos" }, { value: "converted", label: "Convertidos" }, { value: "archived", label: "Archivados" }],
  activities: [{ value: "pending", label: "Pendientes" }, { value: "done", label: "Hechas" }],
};

const LOWER_IS_BETTER = new Set(["no_show_rate", "avg_days_to_close"]);

/** Editor de widgets: cada cambio recalcula la vista previa con datos reales. */
export function WidgetBuilder({ action, catalog, periods, charts, pipelines, users, initial, submitLabel }: Props) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [titleTouched, setTitleTouched] = useState(Boolean(initial));
  const [width, setWidth] = useState<1 | 2>(initial?.width ?? 1);
  const [c, setC] = useState<Config>(initial?.config ?? {
    source: "deals", metric: "sum_value", group_by: "stage", date_field: "created_at", period: "all", chart: "bar",
    filters: { status: "open" },
  });
  const [preview, setPreview] = useState<{ result?: Result; chart?: string; error?: string; loading: boolean }>({ loading: true });

  const cat = catalog[c.source];
  const group = cat.groups.find((g) => g.value === c.group_by);
  const chartOptions = c.group_by === "none" ? charts.filter((x) => x.value === "number")
    : group?.time ? charts.filter((x) => x.value === "line" || x.value === "bar" || x.value === "table")
    : charts.filter((x) => x.value === "bar" || x.value === "table");

  const set = (patch: Partial<Config>) => setC((prev) => {
    const next = { ...prev, ...patch, filters: { ...prev.filters, ...(patch.filters ?? {}) } };
    if (patch.source && patch.source !== prev.source) {
      const sc = catalog[patch.source];
      next.metric = sc.metrics[0].value;
      next.group_by = "none";
      next.date_field = sc.dates[0].value;
      next.filters = {};
    }
    const g = catalog[next.source].groups.find((x) => x.value === next.group_by);
    if (next.group_by === "none") next.chart = "number";
    else if (next.chart === "number" || (next.chart === "line" && !g?.time)) next.chart = g?.time ? "line" : "bar";
    return next;
  });

  // Título sugerido mientras el usuario no escriba el suyo.
  const suggested = useMemo(() => {
    const m = cat.metrics.find((x) => x.value === c.metric)?.label ?? "";
    const g = c.group_by === "none" ? "" : ` por ${(group?.label ?? "").toLowerCase().replace(/ \(.*\)$/, "")}`;
    return `${m}${g}`;
  }, [c, cat, group]);
  useEffect(() => { if (!titleTouched) setTitle(suggested); }, [suggested, titleTouched]);

  useEffect(() => {
    const ctrl = new AbortController();
    setPreview((p) => ({ ...p, loading: true }));
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/analytics/preview", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: c }), signal: ctrl.signal,
        });
        const data = await res.json();
        setPreview(res.ok ? { result: data.result, chart: data.config.chart, loading: false } : { error: data.error, loading: false });
      } catch { /* cancelada */ }
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [c]);

  const sel = (label: string, value: string, options: Opt[], onChange: (v: string) => void, allowEmpty?: string) => (
    <label className="field"><span className="label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );

  return (
    <div className="builder">
      <section className="panel stack">
        <h2>Qué medir</h2>
        <div className="grid-2">
          {sel("Datos", c.source, (Object.keys(catalog) as Config["source"][]).map((k) => ({ value: k, label: catalog[k].label })),
               (v) => set({ source: v as Config["source"] }))}
          {sel("Métrica", c.metric, cat.metrics, (v) => set({ metric: v }))}
          {sel("Agrupar por", c.group_by, cat.groups, (v) => set({ group_by: v }))}
          {sel("Tipo de gráfico", c.chart, chartOptions, (v) => set({ chart: v }))}
        </div>
        <h2>Periodo y filtros</h2>
        <div className="grid-2">
          {sel("Periodo", c.period, periods, (v) => set({ period: v }))}
          {sel("Según la fecha de", c.date_field, cat.dates, (v) => set({ date_field: v }))}
          {sel("Estado", c.filters.status ?? "", STATUS[c.source], (v) => set({ filters: { status: v || undefined } }), "Todos")}
          {sel("Responsable", c.filters.owner_id ?? "", users, (v) => set({ filters: { owner_id: v || undefined } }), "Todos")}
          {c.source === "deals" && sel("Pipeline", c.filters.pipeline_id ?? "", pipelines, (v) => set({ filters: { pipeline_id: v || undefined } }), "Todos")}
          {c.source === "leads" && sel("Etapa", c.filters.funnel_stage ?? "",
            [{ value: "tofu", label: "TOFU" }, { value: "mofu", label: "MOFU" }, { value: "bofu", label: "BOFU" }],
            (v) => set({ filters: { funnel_stage: v || undefined } }), "Todas")}
        </div>
      </section>

      <div className="stack">
        <section className="panel widget preview">
          <div className="widget-head"><h2>{title || "Sin título"}</h2></div>
          {preview.error ? <p className="form-error">{preview.error}</p>
            : preview.result ? <div style={{ opacity: preview.loading ? 0.5 : 1 }}>
                <WidgetView key={JSON.stringify(c)} result={preview.result} chart={preview.chart ?? c.chart} higherIsBetter={!LOWER_IS_BETTER.has(c.metric)} />
              </div>
            : <p className="widget-empty">Calculando…</p>}
        </section>
        <section className="panel">
          <ActionForm action={action} submitLabel={submitLabel}>
            <input type="hidden" name="config" value={JSON.stringify(c)} />
            <div className="grid-2">
              <label className="field span-2"><span className="label">Título</span>
                <input name="title" required value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} /></label>
              <label className="field"><span className="label">Ancho</span>
                <select name="width" value={String(width)} onChange={(e) => setWidth(Number(e.target.value) as 1 | 2)}>
                  <option value="1">Media fila</option>
                  <option value="2">Fila entera</option>
                </select>
              </label>
            </div>
          </ActionForm>
        </section>
      </div>
    </div>
  );
}
