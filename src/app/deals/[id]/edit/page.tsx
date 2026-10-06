import Link from "next/link";
import { notFound } from "next/navigation";
import { DealForm } from "@/components/DealForm";
import { updateDealAction } from "@/app/actions/deals";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { getDeal } from "@/lib/deals";
import { listAllStages, listPipelines } from "@/lib/pipelines";
import { listUsers } from "@/lib/users";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Editar deal" };

export default async function EditDealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const [deal, defs, users, pipelines, stages] = await Promise.all([
    getDeal(id), listFieldDefinitions("deal"), listUsers(), listPipelines(), listAllStages(),
  ]);
  if (!deal) notFound();
  return (
    <main className="page" style={{ maxWidth: 760 }}>
      <div className="crumbs"><Link href={`/pipelines/${deal.pipeline_id}`}>{deal.pipeline_name}</Link> / <Link href={`/deals/${id}`}>{deal.title}</Link></div>
      <div className="page-head"><h1>Editar deal</h1></div>
      <section className="panel">
        <DealForm action={updateDealAction.bind(null, id)} deal={deal} defs={defs} users={users}
                  pipelines={pipelines} stages={stages} submitLabel="Guardar cambios" />
      </section>
    </main>
  );
}
