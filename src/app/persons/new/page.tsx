import Link from "next/link";
import { PersonForm } from "@/components/forms";
import { createPersonAction } from "@/app/actions/records";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { getOrganization } from "@/lib/organizations";
import { listUsers } from "@/lib/users";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nuevo contacto" };

export default async function NewPersonPage({ searchParams }: { searchParams: Promise<{ organization?: string }> }) {
  const { organization } = await searchParams;
  const [defs, users, org] = await Promise.all([
    listFieldDefinitions("person"), listUsers(), isId(organization) ? getOrganization(organization) : null,
  ]);
  return (
    <main className="page narrow">
      <div className="crumbs"><Link href="/persons">Contactos</Link></div>
      <div className="page-head"><h1>Nuevo contacto</h1></div>
      <section className="panel">
        <PersonForm action={createPersonAction} defs={defs} users={users} submitLabel="Crear contacto"
                    withCompany company={org ? { id: org.id, label: org.name } : null} />
      </section>
    </main>
  );
}
