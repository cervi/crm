import Link from "next/link";
import { ENTITY_LABELS, FIELD_TYPES, listFieldDefinitions, type CustomEntity } from "@/lib/custom-fields";
import { createFieldAction, updateFieldAction } from "@/app/actions/settings";
import { ActionForm } from "@/components/ActionForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campos personalizados" };

const ENTITIES = Object.keys(ENTITY_LABELS) as CustomEntity[];

export default async function FieldsPage({ searchParams }: { searchParams: Promise<{ entity?: string }> }) {
  const { entity: e } = await searchParams;
  const entity: CustomEntity = ENTITIES.includes(e as CustomEntity) ? (e as CustomEntity) : "deal";
  const defs = await listFieldDefinitions(entity, true);
  const typeLabel = (t: string) => FIELD_TYPES.find((f) => f.value === t)?.label ?? t;

  return (
    <main className="page" style={{ maxWidth: 1000 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><h1>Campos personalizados</h1></div>
      <nav className="tabs">
        {ENTITIES.map((x) => (
          <Link key={x} href={`/settings/fields?entity=${x}`} aria-current={x === entity ? "page" : undefined}>{ENTITY_LABELS[x]}</Link>
        ))}
      </nav>

      <div className="stack">
        {defs.length === 0 && <p className="muted">Todavía no hay campos personalizados en {ENTITY_LABELS[entity].toLowerCase()}.</p>}
        <ul className="items">
          {defs.map((d) => {
            const isOption = d.field_type === "single_option" || d.field_type === "multi_option";
            return (
              <li key={d.id} className={d.is_archived ? "item done" : "item"}>
                <div className="item-head" style={{ marginBottom: 6 }}>
                  <strong>{d.label}</strong>
                  <span className="badge">{typeLabel(d.field_type)}</span>
                  {d.is_archived && <span className="badge">Archivado</span>}
                  <span className="spacer" /><code>{d.key}</code>
                </div>
                <ActionForm action={updateFieldAction.bind(null, d.id)} submitLabel="Guardar" className="form inline">
                  <label className="field" style={{ flex: 1 }}><span className="label">Nombre</span><input name="label" required defaultValue={d.label} /></label>
                  {isOption && (
                    <label className="field" style={{ flex: 1 }}><span className="label">Opciones (una por línea)</span>
                      <textarea name="options" rows={3} defaultValue={(d.options ?? []).map((o) => o.label).join("\n")} /></label>
                  )}
                  <label className="checkbox"><input type="checkbox" name="is_required" defaultChecked={d.is_required} /> Obligatorio</label>
                  <label className="checkbox"><input type="checkbox" name="is_archived" defaultChecked={d.is_archived} /> Archivado</label>
                </ActionForm>
              </li>
            );
          })}
        </ul>

        <section className="panel">
          <h2>Nuevo campo en {ENTITY_LABELS[entity].toLowerCase()}</h2>
          <ActionForm action={createFieldAction} submitLabel="Crear campo" resetOnSuccess>
            <input type="hidden" name="entity_type" value={entity} />
            <div className="grid-2">
              <label className="field"><span className="label">Nombre *</span><input name="label" required /></label>
              <label className="field"><span className="label">Tipo *</span>
                <select name="field_type" defaultValue="text">
                  {FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              <label className="field span-2"><span className="label">Opciones (solo para «Opción única» y «Varias opciones»; una por línea)</span>
                <textarea name="options" rows={3} /></label>
              <label className="checkbox"><input type="checkbox" name="is_required" /> Obligatorio</label>
            </div>
          </ActionForm>
          <p className="meta">Archivar un campo lo oculta de los formularios pero conserva los valores guardados.</p>
        </section>
      </div>
    </main>
  );
}
