import Link from "next/link";
import { notFound } from "next/navigation";
import { OrganizationForm } from "@/components/forms";
import { updateOrganizationAction } from "@/app/actions/records";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { getOrganization } from "@/lib/organizations";
import { listUsers } from "@/lib/users";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Editar empresa" };

export default async function EditOrganizationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const [org, defs, users] = await Promise.all([getOrganization(id), listFieldDefinitions("organization"), listUsers()]);
  if (!org) notFound();
  return (
    <main className="page" style={{ maxWidth: 760 }}>
      <div className="crumbs"><Link href="/organizations">Empresas</Link> / <Link href={`/organizations/${id}`}>{org.name}</Link></div>
      <div className="page-head"><h1>Editar empresa</h1></div>
      <section className="panel">
        <OrganizationForm action={updateOrganizationAction.bind(null, id)} org={org} defs={defs} users={users} submitLabel="Guardar cambios" />
      </section>
    </main>
  );
}
