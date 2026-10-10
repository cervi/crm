import Link from "next/link";
import { mergeAction } from "@/app/actions/duplicates";
import { ActionForm } from "@/components/ActionForm";
import { date } from "@/lib/format";
import { findDuplicates } from "@/lib/duplicates";

export const dynamic = "force-dynamic";
export const metadata = { title: "Duplicados" };

export default async function DuplicatesPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind: k } = await searchParams;
  const kind = k === "organization" ? "organization" : "person";
  const groups = await findDuplicates(kind);
  const path = kind === "person" ? "persons" : "organizations";
  return (
    <main className="page medium">
      <div className="page-head">
        <div>
          <h1>Duplicados</h1>
          <p className="muted" style={{ margin: 0 }}>
            {kind === "person" ? "Contactos con el mismo nombre en la misma empresa." : "Empresas con el mismo nombre (sin contar S.L., S.A.…)."}{" "}
            Al fusionar, todo pasa al que se queda (deals, actividades, notas, correos, emails y teléfonos) y el resto va a la papelera.
          </p>
        </div>
      </div>
      <nav className="tabs">
        <Link href="/duplicates" aria-current={kind === "person" ? "page" : undefined}>Contactos</Link>
        <Link href="/duplicates?kind=organization" aria-current={kind === "organization" ? "page" : undefined}>Empresas</Link>
      </nav>
      {groups.length === 0 && <p className="muted">No hay duplicados a la vista.</p>}
      <div className="rules">
        {groups.map((g) => (
          <article key={g.key} className="panel" aria-label={`Duplicados ${g.members[0].name}`}>
            <ActionForm action={mergeAction.bind(null, kind)} submitLabel={`Fusionar (${g.members.length})`} secondary>
              <table className="dup-table">
                <thead><tr><th>Se queda</th><th>Fusionar</th><th>{kind === "person" ? "Contacto" : "Empresa"}</th><th className="num">Deals</th><th>Alta</th></tr></thead>
                <tbody>
                  {g.members.map((m, i) => (
                    <tr key={m.id}>
                      <td><input type="radio" name="primary" value={m.id} defaultChecked={i === 0} aria-label={`Se queda ${m.name}`} /></td>
                      <td><input type="checkbox" name="ids" value={m.id} defaultChecked aria-label={`Fusionar ${m.name}`} /></td>
                      <td><Link href={`/${path}/${m.id}`}>{m.name}</Link>{m.detail && <div className="meta">{m.detail}</div>}</td>
                      <td className="num">{m.deals}</td>
                      <td>{date(m.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ActionForm>
          </article>
        ))}
      </div>
    </main>
  );
}
