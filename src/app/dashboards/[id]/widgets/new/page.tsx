import Link from "next/link";
import { notFound } from "next/navigation";
import { listDashboards } from "@/lib/analytics";
import { isId } from "@/lib/validation";
import { saveWidgetAction } from "@/app/actions/dashboards";
import { WidgetBuilder } from "@/components/charts/WidgetBuilder";
import { builderOptions } from "../../../catalog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nuevo widget" };

export default async function NewWidgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const dashboard = (await listDashboards()).find((d) => d.id === id);
  if (!dashboard) notFound();
  const opts = await builderOptions();
  return (
    <main className="page-wide">
      <div className="crumbs"><Link href={`/dashboards/${id}`}>{dashboard.name}</Link></div>
      <div className="page-head"><h1>Nuevo widget</h1></div>
      <WidgetBuilder action={saveWidgetAction.bind(null, id, null)} submitLabel="Añadir al dashboard" {...opts} />
    </main>
  );
}
