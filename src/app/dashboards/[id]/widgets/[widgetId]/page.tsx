import Link from "next/link";
import { notFound } from "next/navigation";
import { getWidget, listDashboards } from "@/lib/analytics";
import { isId } from "@/lib/validation";
import { saveWidgetAction } from "@/app/actions/dashboards";
import { WidgetBuilder } from "@/components/charts/WidgetBuilder";
import { builderOptions } from "../../../catalog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Editar widget" };

export default async function EditWidgetPage({ params }: { params: Promise<{ id: string; widgetId: string }> }) {
  const { id, widgetId } = await params;
  if (!isId(id) || !isId(widgetId)) notFound();
  const [dashboards, widget] = await Promise.all([listDashboards(), getWidget(widgetId)]);
  const dashboard = dashboards.find((d) => d.id === id);
  if (!dashboard || !widget || widget.dashboard_id !== id) notFound();
  const opts = await builderOptions();
  return (
    <main className="page-wide">
      <div className="crumbs"><Link href={`/dashboards/${id}`}>{dashboard.name}</Link></div>
      <div className="page-head"><h1>Editar widget</h1></div>
      <WidgetBuilder action={saveWidgetAction.bind(null, id, widgetId)} submitLabel="Guardar cambios" {...opts}
                     initial={{ title: widget.title, width: widget.width, config: { ...widget.config, filters: widget.config.filters ?? {} } }} />
    </main>
  );
}
