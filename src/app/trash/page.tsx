import Link from "next/link";
import { restoreAction } from "@/app/actions/trash";
import { ActionForm } from "@/components/ActionForm";
import { dateTime } from "@/lib/format";
import { listTrash, TRASH_DAYS, TRASH_LABELS } from "@/lib/trash";

export const dynamic = "force-dynamic";
export const metadata = { title: "Papelera" };

export default async function TrashPage() {
  const items = await listTrash();
  return (
    <main className="page" style={{ maxWidth: 900 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Papelera</h1>
          <p className="muted" style={{ margin: 0 }}>Lo borrado se puede recuperar durante {TRASH_DAYS} días; después se elimina del todo.</p>
        </div>
      </div>
      {items.length === 0 ? <p className="muted">La papelera está vacía.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Qué</th><th>Nombre</th><th>Borrado</th><th>Se elimina</th><th /></tr></thead>
            <tbody>
              {items.map((t) => (
                <tr key={`${t.kind}${t.id}`}>
                  <td>{TRASH_LABELS[t.kind]}</td>
                  <td><strong>{t.name}</strong></td>
                  <td>{dateTime(t.deleted_at)}{t.deleted_by && <div className="meta">por {t.deleted_by}</div>}</td>
                  <td className="meta">{dateTime(new Date(new Date(t.deleted_at).getTime() + TRASH_DAYS * 86400000))}</td>
                  <td><ActionForm action={restoreAction.bind(null, t.kind, t.id)} submitLabel="Recuperar" secondary className="form inline" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
