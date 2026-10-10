import { redirect } from "next/navigation";
import { listDashboards } from "@/lib/analytics";
import { createDashboardAction } from "@/app/actions/dashboards";
import { ActionForm } from "@/components/ActionForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dashboards" };

export default async function DashboardsIndex() {
  const [first] = await listDashboards();
  if (first) redirect(`/dashboards/${first.id}`);
  return (
    <main className="page narrow">
      <div className="page-head"><h1>Dashboards</h1></div>
      <section className="panel stack">
        <p className="muted" style={{ margin: 0 }}>Crea tu primer dashboard y añade los widgets con las métricas que quieras seguir.</p>
        <ActionForm action={createDashboardAction} submitLabel="Crear dashboard">
          <label className="field"><span className="label">Nombre</span><input name="name" required placeholder="Ventas" /></label>
        </ActionForm>
      </section>
    </main>
  );
}
