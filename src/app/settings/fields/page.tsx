import Link from "next/link";
import { ENTITY_LABELS, FIELD_TYPES, listFieldDefinitions, type CustomEntity } from "@/lib/custom-fields";
import { createFieldAction, updateFieldAction } from "@/app/actions/settings";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campos personalizados" };

const ENTITIES = Object.keys(ENTITY_LABELS) as CustomEntity[];

export default async function FieldsPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  await requireAdminPage();
  const { entity: e } = await searchParams;
  const entity: CustomEntity = ENTITIES.includes(e as CustomEntity) ? (e as CustomEntity) : "deal";
  const defs = await listFieldDefinitions(entity, true);
  const typeLabel = (t: string) => FIELD_TYPES.find((f) => f.value === t)?.label ?? t;

  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Campos personalizados</h1>
          <p className="muted" style={{ margin: 0 }}>Datos propios de vuestro negocio en deals, contactos, empresas y leads.</p>
        </div>
        <div className="head-actions">
          <Drawer label={<><Icon name="plus" />Nuevo campo</>} buttonClass="btn" title={`Nuevo campo en ${ENTITY_LABELS[entity].toLowerCase()}`}>
            <ActionForm action={createFieldAction} submitLabel="Crear campo" resetOnSuccess>
              <input type="hidden" name="entity_type" value={entity} />
              <label className="field"><span className="label">Nombre *</span><input name="label" required /></label>
              <label className="field"><span className="label">Tipo *</span>
                <select name="field_type" defaultValue="text">
                  {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              <label className="field"><span className="label">Opciones (solo para «Opción única» y «Varias opciones»; una por línea)</span>
                <textarea name="options" rows={4} /></label>
              <label className="checkbox"><input type="checkbox" name="is_required" /> Obligatorio</label>
            </ActionForm>
          </Drawer>
        </div>
      </div>
      <nav className="tabs">
        {ENTITIES.map((x) => (
          <Link key={x} href={`/settings/fields?entity=${x}`} aria-current={x === entity ? "page" : undefined}>{ENTITY_LABELS[x]}</Link>
        ))}
      </nav>

      {defs.length === 0 ? (
        <div className="empty-state">
          <strong>Todavía no hay campos personalizados en {ENTITY_LABELS[entity].toLowerCase()}.</strong>
          <span className="meta">Crea uno con «Nuevo campo»: aparecerá en las fichas y en los formularios, y podrás verlo como columna en las tablas.</span>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Campo</th><th>Tipo</th><th>Obligatorio</th><th>Estado</th><th><span className="sr-only">Acciones</span></th></tr></thead>
            <tbody>
              {defs.map((d) => {
                const isOption = d.field_type === "single_option" || d.field_type === "multi_option";
                return (
                  <tr key={d.id} className={d.is_archived ? "row-muted" : undefined} aria-label={`Campo ${d.label}`}>
                    <td><strong>{d.label}</strong>{isOption && <div className="meta">{(d.options ?? []).length} opciones</div>}</td>
                    <td>{typeLabel(d.field_type)}</td>
                    <td>{d.is_required ? "Sí" : <span className="muted">No</span>}</td>
                    <td>{d.is_archived ? <span className="badge">Archivado</span> : <span className="badge won">En uso</span>}</td>
                    <td className="row-actions">
                      <Drawer label="Editar" title={d.label} subtitle={`${typeLabel(d.field_type)} · clave interna ${d.key}`} buttonTitle={`Editar el campo ${d.label}`}>
                        <ActionForm action={updateFieldAction.bind(null, d.id)} submitLabel="Guardar cambios">
                          <label className="field"><span className="label">Nombre *</span><input name="label" required defaultValue={d.label} /></label>
                          {isOption && (
                            <label className="field"><span className="label">Opciones (una por línea)</span>
                              <textarea name="options" rows={8} defaultValue={(d.options ?? []).map((o) => o.label).join("\n")} /></label>
                          )}
                          <label className="checkbox"><input type="checkbox" name="is_required" defaultChecked={d.is_required} /> Obligatorio al crear o editar</label>
                          <label className="checkbox"><input type="checkbox" name="is_archived" defaultChecked={d.is_archived} /> Archivado (se oculta de los formularios, pero se conservan los valores)</label>
                        </ActionForm>
                      </Drawer>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
