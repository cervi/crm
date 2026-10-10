import Link from "next/link";
import { addLibraryLinkAction, archiveLibraryItemAction, updateLibraryItemAction } from "@/app/actions/library";
import { ActionForm } from "@/components/ActionForm";
import { DataTable } from "@/components/DataTable";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { LibraryUpload } from "@/components/library/LibraryUpload";
import { ShareDocButton } from "@/components/library/ShareDocButton";
import { requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { fileSize } from "@/lib/files";
import { duration, libraryFolders, listLibrary, listLinks } from "@/lib/library";

export const dynamic = "force-dynamic";
export const metadata = { title: "Biblioteca" };

const kindLabel = (mime: string | null, kind: string) =>
  kind === "link" ? "Enlace" : mime === "application/pdf" ? "PDF" : /presentation|powerpoint|keynote/.test(mime ?? "") ? "Presentación"
  : /sheet|excel|csv/.test(mime ?? "") ? "Hoja de cálculo" : /word|document/.test(mime ?? "") ? "Documento" : /^image\//.test(mime ?? "") ? "Imagen"
  : /^video\//.test(mime ?? "") ? "Vídeo" : "Archivo";

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ carpeta?: string; q?: string; archivados?: string; ver?: string }> }) {
  const [me, sp] = await Promise.all([requireUser(), searchParams]);
  const archived = sp.archivados === "1";
  const [items, all, folders] = await Promise.all([
    listLibrary({ folder: sp.carpeta || null, q: sp.q, archived }), listLibrary({ archived }), libraryFolders(),
  ]);
  const detail = sp.ver ? items.find((i) => i.id === sp.ver) ?? null : null;
  const links = detail ? await listLinks({ libraryId: detail.id }) : [];
  const counts = new Map<string, number>();
  for (const i of all) counts.set(i.folder, (counts.get(i.folder) ?? 0) + 1);
  const qs = (p: Record<string, string | null | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ carpeta: sp.carpeta, q: sp.q, archivados: archived ? "1" : null, ...p })) if (v) u.set(k, v);
    return u.toString() ? `/biblioteca?${u}` : "/biblioteca";
  };
  const writer = me.role !== "viewer";

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Biblioteca</h1>
          <p className="muted" style={{ margin: 0 }}>Presentaciones, casos de éxito, tarifas… a mano para todo el equipo. Compártelos con un enlace con seguimiento y sabrás quién los abre, cuántas veces y cuánto tiempo.</p>
        </div>
        {writer && (
          <div className="head-actions">
            <Drawer label={<><Icon name="plus" />Añadir enlace</>} title="Añadir un enlace" subtitle="Un vídeo, una web, un Google Slides… Al compartirlo, el clic queda registrado.">
              <ActionForm action={addLibraryLinkAction} submitLabel="Añadir" resetOnSuccess>
                <label className="field"><span className="label">Nombre *</span><input name="name" required maxLength={200} /></label>
                <label className="field"><span className="label">Enlace *</span><input name="url" type="url" required placeholder="https://…" /></label>
                <label className="field"><span className="label">Carpeta</span><input name="folder" list="lib-folders-2" defaultValue="Presentaciones" />
                  <datalist id="lib-folders-2">{folders.map((f) => <option key={f} value={f} />)}</datalist></label>
                <label className="field"><span className="label">Descripción</span><textarea name="description" rows={2} /></label>
              </ActionForm>
            </Drawer>
            <Drawer label={<><Icon name="plus" />Subir documento</>} buttonClass="btn" title="Subir a la biblioteca"><LibraryUpload folders={folders} /></Drawer>
          </div>
        )}
      </div>

      <nav className="chips" aria-label="Carpetas">
        <Link href={qs({ carpeta: null })} aria-current={!sp.carpeta ? "page" : undefined}>Todo<span className="chip-count">{all.length}</span></Link>
        {[...counts.entries()].map(([f, n]) => (
          <Link key={f} href={qs({ carpeta: f })} aria-current={sp.carpeta === f ? "page" : undefined}>{f}<span className="chip-count">{n}</span></Link>
        ))}
        <span className="spacer" />
        <Link href={qs({ archivados: archived ? null : "1" })}>{archived ? "Ocultar archivados" : "Ver archivados"}</Link>
      </nav>
      <form className="toolbar">
        {sp.carpeta && <input type="hidden" name="carpeta" value={sp.carpeta} />}
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Buscar en la biblioteca" aria-label="Buscar" />
        <button className="btn secondary">Buscar</button>
      </form>

      <DataTable id="library"
        empty={all.length === 0 ? <>La biblioteca está vacía. Sube la presentación de la empresa, tus casos de éxito o las tarifas para tenerlos a mano al escribir un correo.</> : <>No hay nada con este filtro.</>}
        columns={[
          { key: "doc", label: "Documento", required: true, pinned: true },
          { key: "folder", label: "Carpeta" },
          { key: "shared", label: "Compartido", className: "num" },
          { key: "opened", label: "Lo han abierto", className: "num" },
          { key: "views", label: "Aperturas", className: "num" },
          { key: "time", label: "Tiempo de lectura", className: "num", hidden: true },
          { key: "last", label: "Última apertura", className: "nowrap" },
          { key: "by", label: "Subido por", hidden: true },
          { key: "actions", label: "Acciones", required: true },
        ]}
        rows={items.map((i) => ({
          id: i.id, label: i.name, className: i.archived_at ? "row-muted" : undefined,
          cells: {
            doc: <span><Link href={`${qs({ ver: i.id })}#quien-lo-ha-abierto`} title="Ver quién lo ha abierto"><strong>{i.name}</strong></Link>
              <div className="meta">{kindLabel(i.mime, i.kind)}{i.size ? ` · ${fileSize(i.size)}` : ""}{i.description ? ` · ${i.description.slice(0, 80)}` : ""}</div></span>,
            folder: i.folder,
            shared: i.shared || <span className="muted">—</span>,
            opened: i.shared ? <>{i.opened} <span className="meta">({Math.round((i.opened / i.shared) * 100)} %)</span></> : <span className="muted">—</span>,
            views: i.views || <span className="muted">—</span>,
            time: i.seconds ? duration(i.seconds) : <span className="muted">—</span>,
            last: i.last_viewed_at ? dateTime(i.last_viewed_at) : <span className="muted">nunca</span>,
            by: i.creator,
            actions: (
              <span className="row-actions">
                <a className="btn secondary small" href={`/api/biblioteca/${i.id}?ver=1`} target="_blank" rel="noreferrer">Ver</a>
                {!i.archived_at && <ShareDocButton libraryId={i.id} label="Copiar enlace" />}
                {writer && (
                  <Drawer label="Editar" title={i.name} buttonTitle={`Editar ${i.name}`}>
                    <section className="drawer-section">
                      <ActionForm action={updateLibraryItemAction.bind(null, i.id)} submitLabel="Guardar cambios">
                        <label className="field"><span className="label">Nombre *</span><input name="name" required defaultValue={i.name} /></label>
                        {i.kind === "link" && <label className="field"><span className="label">Enlace</span><input name="url" type="url" defaultValue={i.url ?? ""} /></label>}
                        <label className="field"><span className="label">Carpeta</span><input name="folder" defaultValue={i.folder} /></label>
                        <label className="field"><span className="label">Descripción</span><textarea name="description" rows={2} defaultValue={i.description ?? ""} /></label>
                      </ActionForm>
                    </section>
                    {i.kind === "file" && (
                      <section className="drawer-section"><h3>Subir una versión nueva</h3><LibraryUpload replace={i.id} /></section>
                    )}
                    <section className="drawer-section">
                      <h3>{i.archived_at ? "Recuperar" : "Archivar"}</h3>
                      <p className="meta" style={{ marginTop: 0 }}>{i.archived_at ? "Vuelve a la biblioteca y sus enlaces funcionan otra vez." : "Desaparece de la biblioteca y los enlaces ya enviados dejan de funcionar. Se puede recuperar."}</p>
                      <ActionForm action={archiveLibraryItemAction.bind(null, i.id, !i.archived_at)} submitLabel={i.archived_at ? "Recuperar" : "Archivar"} secondary
                                  confirm={i.archived_at ? undefined : "Los enlaces que ya hayas enviado dejarán de abrir el documento."} />
                    </section>
                  </Drawer>
                )}
              </span>
            ),
          },
        }))}
      />

      {detail && (
        <section className="panel" id="quien-lo-ha-abierto" style={{ marginTop: 18, scrollMarginTop: 80 }} aria-label={`Quién ha abierto ${detail.name}`}>
          <div className="sign-head"><h2>Quién ha abierto «{detail.name}»</h2><Link href={qs({ ver: null })} className="meta">Cerrar</Link></div>
          {links.length === 0 ? <p className="muted">Aún no se ha compartido. Usa «Copiar enlace» o adjúntalo como enlace al escribir un correo desde un deal.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Con quién</th><th>Deal</th><th className="num">Aperturas</th><th className="num">Tiempo</th><th>Primera</th><th>Última</th><th>Compartido por</th></tr></thead>
                <tbody>
                  {links.map((l) => (
                    <tr key={l.id} className={l.disabled_at ? "row-muted" : undefined}>
                      <td>{l.person ?? <span className="muted">Enlace genérico</span>}</td>
                      <td>{l.deal_id ? <Link href={`/deals/${l.deal_id}`}>{l.deal}</Link> : <span className="muted">—</span>}</td>
                      <td className="num">{l.view_count || <span className="muted">0</span>}</td>
                      <td className="num">{l.seconds ? duration(l.seconds) : "—"}</td>
                      <td className="nowrap">{l.first_viewed_at ? dateTime(l.first_viewed_at) : <span className="muted">sin abrir</span>}</td>
                      <td className="nowrap">{l.last_viewed_at ? dateTime(l.last_viewed_at) : "—"}</td>
                      <td>{l.creator}<div className="meta">{dateTime(l.created_at)}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
