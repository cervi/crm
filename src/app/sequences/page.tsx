import Link from "next/link";
import { createSequenceAction } from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { listSequences } from "@/lib/sequences";

export const dynamic = "force-dynamic";
export const metadata = { title: "Secuencias" };

export default async function SequencesPage() {
  const sequences = await listSequences();
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Secuencias</h1>
          <p className="muted" style={{ margin: 0 }}>
            Correos y tareas que salen solos, espaciados en días, desde el buzón del responsable del deal. Se paran en cuanto el contacto
            responde, agenda una reunión o el deal se cierra. Añade contactos desde la ficha del deal o en bloque desde la lista de deals.
          </p>
        </div>
        <Link className="btn secondary" href="/sequences/tasks">Correos manuales por enviar</Link>
      </div>

      {sequences.length === 0 && <p className="muted">Todavía no hay secuencias.</p>}
      <div className="table-wrap" style={{ marginBottom: 18 }}>
        <table>
          <thead>
            <tr><th>Secuencia</th><th className="num">Pasos</th><th className="num">En marcha</th><th className="num">Terminadas</th><th className="num">Respondieron</th><th>Estado</th></tr>
          </thead>
          <tbody>
            {sequences.map((s) => (
              <tr key={s.id}>
                <td><Link href={`/sequences/${s.id}`}><strong>{s.name}</strong></Link>{s.description && <div className="meta">{s.description}</div>}</td>
                <td className="num">{s.steps}</td>
                <td className="num">{s.active}</td>
                <td className="num">{s.completed}</td>
                <td className="num">{s.total ? `${s.replied} (${Math.round((s.replied / s.total) * 100)} %)` : "—"}</td>
                <td><span className={`badge ${s.is_active ? "won" : ""}`}>{s.is_active ? "Activa" : "Desactivada"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="panel">
        <h2>Nueva secuencia</h2>
        <ActionForm action={createSequenceAction} submitLabel="Crear y añadir pasos">
          <div className="grid-2">
            <label className="field"><span className="label">Nombre</span><input name="name" required maxLength={120} placeholder="Seguimiento tras la demo" /></label>
            <label className="field"><span className="label">Para qué es (opcional)</span><input name="description" maxLength={1000} /></label>
          </div>
        </ActionForm>
      </section>
    </main>
  );
}
