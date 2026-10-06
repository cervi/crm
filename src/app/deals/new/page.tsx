import Link from "next/link";
import { DealForm } from "@/components/DealForm";
import { createDealAction } from "@/app/actions/deals";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { listAllStages, listPipelines } from "@/lib/pipelines";
import { getOrganization } from "@/lib/organizations";
import { getPerson } from "@/lib/persons";
import { listUsers } from "@/lib/users";
import { requireUser } from "@/lib/auth";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nuevo deal" };

export default async function NewDealPage({ searchParams }: {
  searchParams: Promise<{ pipeline?: string; organization?: string; person?: string }>;
}) {
  const [sp, me] = await Promise.all([searchParams, requireUser()]);
  const [defs, users, pipelines, stages, org, person] = await Promise.all([
    listFieldDefinitions("deal"), listUsers(), listPipelines(), listAllStages(),
    isId(sp.organization) ? getOrganization(sp.organization) : null,
    isId(sp.person) ? getPerson(sp.person) : null,
  ]);
  return (
    <main className="page" style={{ maxWidth: 760 }}>
      <div className="crumbs"><Link href="/pipelines">Deals</Link></div>
      <div className="page-head"><h1>Nuevo deal</h1></div>
      <section className="panel">
        <DealForm action={createDealAction} defs={defs} users={users} pipelines={pipelines} stages={stages}
                  submitLabel="Crear deal"
                  defaults={{
                    pipelineId: isId(sp.pipeline) ? sp.pipeline : null,
                    organization: org ? { id: org.id, label: org.name } : null,
                    person: person ? { id: person.id, label: person.full_name } : null,
                    ownerId: me.id,
                  }} />
      </section>
    </main>
  );
}
