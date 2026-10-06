import Link from "next/link";
import { OrganizationForm } from "@/components/forms";
import { createOrganizationAction } from "@/app/actions/records";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { listUsers } from "@/lib/users";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nueva empresa" };

export default async function NewOrganizationPage() {
  const [defs, users] = await Promise.all([listFieldDefinitions("organization"), listUsers()]);
  return (
    <main className="page" style={{ maxWidth: 760 }}>
      <div className="crumbs"><Link href="/organizations">Empresas</Link></div>
      <div className="page-head"><h1>Nueva empresa</h1></div>
      <section className="panel">
        <OrganizationForm action={createOrganizationAction} defs={defs} users={users} submitLabel="Crear empresa" />
      </section>
    </main>
  );
}
