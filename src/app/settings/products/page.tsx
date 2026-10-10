import Link from "next/link";
import { saveDiscountLimitAction, saveProductAction } from "@/app/actions/products";
import { sql } from "@/lib/db";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { requireAdminPage } from "@/lib/auth";
import { money } from "@/lib/format";
import { BILLING_LABELS, listProducts, type Product } from "@/lib/products";

export const dynamic = "force-dynamic";
export const metadata = { title: "Productos" };

function ProductFields({ p }: { p?: Product }) {
  return (
    <div className="grid-2">
      <label className="field"><span className="label">Nombre *</span><input name="name" required defaultValue={p?.name} /></label>
      <label className="field"><span className="label">Código (opcional)</span><input name="code" defaultValue={p?.code ?? ""} /></label>
      <label className="field"><span className="label">Precio (€) *</span><input name="unit_price" type="number" min={0} step="0.01" required defaultValue={p?.unit_price ?? ""} /></label>
      <label className="field"><span className="label">Cobro</span>
        <select name="billing" defaultValue={p?.billing ?? "one_off"}>
          {Object.entries(BILLING_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select></label>
      <label className="field"><span className="label">Descuento máximo sin aprobación (%)</span><input name="max_discount_pct" type="number" min={0} max={100} step="any" defaultValue={p?.max_discount_pct ?? ""} placeholder="el general" /></label>
      <label className="field span-2"><span className="label">Descripción (opcional)</span><input name="description" defaultValue={p?.description ?? ""} /></label>
      {p && <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={p.is_active} />Activo</label>}
    </div>
  );
}

export default async function ProductsPage() {
  await requireAdminPage();
  const [products, [settings]] = await Promise.all([listProducts(true), sql<{ max: string | null }[]>`SELECT max_discount_pct::text AS max FROM app_settings LIMIT 1`]);
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Productos</h1>
          <p className="muted" style={{ margin: 0 }}>Lo que vendéis. Se añaden a los deals (el importe del deal es la suma) y con ellos la IA prepara propuestas para el cliente.</p>
        </div>
        <div className="head-actions">
          <Drawer label={<><Icon name="plus" />Nuevo producto</>} buttonClass="btn" title="Nuevo producto">
            <ActionForm action={saveProductAction.bind(null, null)} submitLabel="Añadir producto" resetOnSuccess><ProductFields /></ActionForm>
          </Drawer>
        </div>
      </div>

      <section className="settings-inline" aria-label="Descuentos">
        <ActionForm action={saveDiscountLimitAction} submitLabel="Guardar" secondary className="form inline">
          <label className="field"><span className="label">Descuento máximo sin aprobación (%)</span>
            <input name="max_discount_pct" type="number" min={0} max={100} step="any" defaultValue={settings?.max ?? ""} placeholder="sin límite" style={{ width: 160 }} /></label>
        </ActionForm>
        <p className="meta">Hasta aquí, cualquiera (y la IA) aplica el descuento sin pedir permiso. Por encima, la línea espera a que un administrador la apruebe. Cada producto puede tener su propio límite.</p>
      </section>

      {products.length === 0 ? (
        <div className="empty-state"><strong>Aún no hay productos.</strong><span className="meta">Añade el primero con «Nuevo producto»: así podrás ponerlos en los deals y preparar propuestas.</span></div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Producto</th><th className="num">Precio</th><th>Cobro</th><th className="num">Dto. máx.</th><th className="num">En deals</th><th>Estado</th><th><span className="sr-only">Acciones</span></th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} aria-label={`Producto ${p.name}`} className={p.is_active ? undefined : "row-muted"}>
                  <td><strong>{p.name}</strong>{(p.code || p.description) && <div className="meta">{[p.code, p.description].filter(Boolean).join(" · ")}</div>}</td>
                  <td className="num">{money(p.unit_price)}</td>
                  <td>{BILLING_LABELS[p.billing]}</td>
                  <td className="num">{p.max_discount_pct !== null ? `${Number(p.max_discount_pct)} %` : <span className="muted">General</span>}</td>
                  <td className="num">{p.deals || <span className="muted">—</span>}</td>
                  <td>{p.is_active ? <span className="badge won">Activo</span> : <span className="badge">Inactivo</span>}</td>
                  <td className="row-actions">
                    <Drawer label="Editar" title={p.name} buttonTitle={`Editar ${p.name}`}>
                      <ActionForm action={saveProductAction.bind(null, p.id)} submitLabel="Guardar cambios"><ProductFields p={p} /></ActionForm>
                    </Drawer>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
