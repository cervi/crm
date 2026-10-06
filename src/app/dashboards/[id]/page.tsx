import Link from "next/link";
import { notFound } from "next/navigation";
import { describeConfig, listDashboards, listWidgets, safeRun } from "@/lib/analytics";
import { isId } from "@/lib/validation";
import {
  createDashboardAction, deleteDashboardAction, deleteWidgetAction, moveWidgetAction, renameDashboardAction,
} from "@/app/actions/dashboards";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { WidgetView } from "@/components/charts/WidgetView";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboards" };

const LOWER_IS_BETTER = new Set(["no_show_rate", "avg_days_to_close"]);

export default async function DashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const dashboards = await listDashboards();
  const current = dashboards.find((d) => d.id === id);
  if (!current) notFound();
  const widgets = await listWidgets(id);
  const results = await Promise.all(widgets.map((w) => safeRun(w.config)));

  return (
    <main className="page-wide">
      <div className="page-head">
        <h1>Dashboards</h1>
        <nav className="pipeline-tabs" aria-label="Dashboards">
          {dashboards.map((d) => (
            <Link key={d.id} href={`/dashboards/${d.id}`} aria-current={d.id === id ? "page" : undefined}>{d.name}</Link>
          ))}
        </nav>
        <span className="spacer" />
        <details className="lose">
          <summary className="btn secondary">Gestionar</summary>
          <div className="panel popover stack">
            <ActionForm action={renameDashboardAction.bind(null, id)} submitLabel="Renombrar" className="form">
              <label className="field"><span className="label">Nombre de este dashboard</span>
                <input name="name" required defaultValue={current.name} /></label>
            </ActionForm>
            <ActionForm action={createDashboardAction} submitLabel="Crear dashboard" secondary className="form">
              <label className="field"><span className="label">Nuevo dashboard</span><input name="name" required placeholder="Nombre" /></label>
            </ActionForm>
            <details>
              <summary className="meta">Eliminar este dashboard</summary>
              <ActionForm action={deleteDashboardAction.bind(null, id)} submitLabel="Eliminar con sus widgets" danger />
            </details>
          </div>
        </details>
        <Link href={`/dashboards/${id}/widgets/new`} className="btn"><Icon name="plus" />Añadir widget</Link>
      </div>

      {widgets.length === 0 && (
        <section className="panel" style={{ maxWidth: 560 }}>
          <h2>Este dashboard está vacío</h2>
          <p className="muted">Añade un widget: elige qué medir (deals, leads o actividades), cómo agruparlo y el periodo.</p>
          <Link href={`/dashboards/${id}/widgets/new`} className="btn">Añadir el primer widget</Link>
        </section>
      )}

      <div className="widgets">
        {widgets.map((w, i) => (
          <section key={w.id} className={`panel widget${w.width === 2 ? " wide" : ""}`}>
            <div className="widget-head">
              <div>
                <h2>{w.title}</h2>
                <div className="meta">{describeConfig(w.config)}</div>
              </div>
              <details className="widget-menu">
                <summary aria-label={`Opciones de ${w.title}`}>···</summary>
                <div className="menu">
                  <Link href={`/dashboards/${id}/widgets/${w.id}`}>Editar</Link>
                  <a href={`/api/export/widget?id=${w.id}`} download>Exportar CSV</a>
                  {i > 0 && <form action={moveWidgetAction.bind(null, id, w.id, "up")}><button>Mover antes</button></form>}
                  {i < widgets.length - 1 && <form action={moveWidgetAction.bind(null, id, w.id, "down")}><button>Mover después</button></form>}
                  <form action={deleteWidgetAction.bind(null, id, w.id)}><button className="danger-text">Eliminar</button></form>
                </div>
              </details>
            </div>
            <WidgetView result={results[i] as never} chart={w.config.chart} higherIsBetter={!LOWER_IS_BETTER.has(w.config.metric)} />
          </section>
        ))}
      </div>
    </main>
  );
}
