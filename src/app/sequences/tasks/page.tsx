import Link from "next/link";
import { sendManualEmailAction, skipManualEmailAction } from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { EmailEditor } from "@/components/EmailEditor";
import { listManualEmails } from "@/lib/sequences";
import { requireUser } from "@/lib/auth";
import { aiReady, getAiSettings } from "@/lib/ai";
import { dateTime } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Correos manuales" };

export default async function ManualEmailsPage({ searchParams }: { searchParams: Promise<{ todos?: string }> }) {
  const user = await requireUser();
  const all = (await searchParams).todos === "1";
  const [items, ai] = await Promise.all([listManualEmails(user.id, all), getAiSettings()]);
  return (
    <main className="page">
      <div className="crumbs"><Link href="/sequences">Secuencias</Link></div>
      <div className="page-head">
        <div>
          <h1>Correos manuales por enviar</h1>
          <p className="muted" style={{ margin: 0 }}>
            Los pasos de «correo manual» de las secuencias: el borrador ya va con los datos del contacto. Revísalo, personalízalo y envíalo;
            la secuencia sigue con el paso siguiente. Si lo saltas, no se envía y la secuencia continúa.
          </p>
        </div>
        <div className="chips">
          <Link href="/sequences/tasks" aria-current={all ? undefined : "page"}>Míos</Link>
          <Link href="/sequences/tasks?todos=1" aria-current={all ? "page" : undefined}>De todo el equipo</Link>
        </div>
      </div>
      {items.length === 0 && <p className="muted">No hay correos pendientes.</p>}
      <div style={{ display: "grid", gap: 14 }}>
        {items.map((m) => (
          <section key={m.activity_id} className="panel" aria-label={`Correo manual a ${m.person_name}`}>
            <div className="rule-head">
              <div>
                <p className="meta" style={{ margin: 0 }}>
                  <Link href={`/sequences/${m.sequence_id}`}>{m.sequence_name}</Link> · paso {m.step} · para hoy {dateTime(m.due_at)}
                  {all && m.owner_name ? ` · ${m.owner_name}` : ""}
                </p>
                <h3 style={{ margin: "2px 0 0" }}>
                  <Link href={`/persons/${m.person_id}`}>{m.person_name}</Link> {m.to ? <span className="muted">&lt;{m.to}&gt;</span> : <span className="tone-bad">sin email</span>}
                  {m.deal_id && <> · <Link href={`/deals/${m.deal_id}`}>{m.deal_title}</Link></>}
                </h3>
              </div>
              <form action={skipManualEmailAction.bind(null, m.activity_id)}>
                <button type="submit" className="btn secondary small" aria-label={`Saltar el correo a ${m.person_name}`}>Saltar</button>
              </form>
            </div>
            {m.note?.includes("Faltan datos") && <p className="ee-warn">{m.note.split("\n").find((l) => l.startsWith("Faltan datos"))} Complétalo en el texto antes de enviarlo.</p>}
            <ActionForm action={sendManualEmailAction.bind(null, m.activity_id)} submitLabel="Enviar" pendingLabel="Enviando…">
              <EmailEditor initialSubject={m.subject} initialBody={m.html} initialFormat="html" formatLocked aiReady={aiReady(ai)}
                           contacts={[{ id: m.person_id, label: m.person_name }]} label={`correo a ${m.person_name}`} />
            </ActionForm>
          </section>
        ))}
      </div>
    </main>
  );
}
