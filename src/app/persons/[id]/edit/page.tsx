import Link from "next/link";
import { notFound } from "next/navigation";
import { PersonForm } from "@/components/forms";
import { updatePersonAction } from "@/app/actions/records";
import { listFieldDefinitions } from "@/lib/custom-fields";
import { getPerson, personContactInfo } from "@/lib/persons";
import { listUsers } from "@/lib/users";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Editar contacto" };

export default async function EditPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  const [person, info, defs, users] = await Promise.all([
    getPerson(id), personContactInfo(id), listFieldDefinitions("person"), listUsers(),
  ]);
  if (!person) notFound();
  const email = info.emails.find((e) => e.is_primary)?.email ?? info.emails[0]?.email;
  const phone = info.phones.find((p) => p.is_primary)?.phone ?? info.phones[0]?.phone;
  return (
    <main className="page" style={{ maxWidth: 760 }}>
      <div className="crumbs"><Link href="/persons">Contactos</Link> / <Link href={`/persons/${id}`}>{person.full_name}</Link></div>
      <div className="page-head"><h1>Editar contacto</h1></div>
      <section className="panel">
        <PersonForm action={updatePersonAction.bind(null, id)} person={person} email={email} phone={phone}
                    defs={defs} users={users} submitLabel="Guardar cambios" />
      </section>
    </main>
  );
}
