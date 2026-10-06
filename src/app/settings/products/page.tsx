import Link from "next/link";
import { saveProductAction } from "@/app/actions/products";
import { ActionForm } from "@/components/ActionForm";
import { requireAdminPage } from "@/lib/auth";
import { money } from "@/lib/format";
import { BILLING_LABELS, listProducts, type Product } from "@/lib/products";

export const dynamic = "force-dynamic";
export const metadata = { title: "Productos" };

function ProductFields({ p }: { p?: Product }) {
  return (
    <div className="grid-3">
      <label className="field"><span className="label">Nombre</span><input name="name" required defaultValue={p?.name} /></label>
      <label className="field"><span className="label">Código (opcional)</span><input name="code" defaultValue={p?.code ?? ""} /></label>
      <label className="field"><span className="label">Precio (€)</span><input name="unit_price" type="number" min={0} step="0.01" required defaultValue={p?.unit_price ?? ""} /></label>
      <label className="field"><span className="label">Cobro</span>
        <select name="billing" defaultValue={p?.billing ?? "one_off"}>
          {Object.entries(BILLING_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select></label>
      <label className="field" style={{ gridColumn: "span 2" }}><span className="label">Descripción (opcional)</span><input name="description" defaultValue={p?.description ?? ""} /></label>
      {p && <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={p.is_active} />Activo</label>}
    </div>
  );
}

export default async function ProductsPage() {
  await requireAdminPage();
  const products = await listProducts(true);
  return (
    <main className="page" style={{ maxWidth: 980 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Productos</h1>
          <p className="muted" style={{ margin: 0 }}>Lo que vendéis. Se añaden a los deals (el importe del deal es la suma) y con ellos la IA prepara propuestas para el cliente.</p>
        </div>
      </div>
      <div className="rules">
        {products.map((p) => (
          <article key={p.id} className="panel" aria-label={`Producto ${p.name}`}>
            <div className="rule-head">
              <div>
                <h3 style={{ margin: 0 }}>{p.name} {!p.is_active && <span className="badge">Inactivo</span>}</h3>
                <p className="meta" style={{ margin: 0 }}>{money(p.unit_price)} · {BILLING_LABELS[p.billing]}{p.code ? ` · ${p.code}` : ""} · en {p.deals} deal{p.deals === 1 ? "" : "s"}</p>
              </div>
            </div>
            <details>
              <summary className="meta">Editar</summary>
              <ActionForm action={saveProductAction.bind(null, p.id)} submitLabel="Guardar" secondary><ProductFields p={p} /></ActionForm>
            </details>
          </article>
        ))}
      </div>
      <section className="panel" style={{ marginTop: 18 }}>
        <h2>Nuevo producto</h2>
        <ActionForm action={saveProductAction.bind(null, null)} submitLabel="Añadir producto" resetOnSuccess><ProductFields /></ActionForm>
      </section>
    </main>
  );
}
