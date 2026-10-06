import Link from "next/link";
import { contractsOf, getAccountHealth, usageOf } from "@/lib/accounts";
import { sql } from "@/lib/db";
import { date, dateTime, money } from "@/lib/format";
import { listProducts } from "@/lib/products";
import { ActionForm } from "./ActionForm";
import { HealthBadge } from "./HealthBadge";
import { createExpansionAction, createRenewalAction, saveContractAction, setCsOwnerAction } from "@/app/actions/accounts";

type User = { id: string; name: string; kind: string };

function Spark({ points }: { points: { value: number }[] }) {
  if (points.length < 2) return null;
  const vals = points.map((p) => p.value), min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const d = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${28 - ((v - min) / span) * 26}`).join(" ");
  return <svg className="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points={d} /></svg>;
}

function ContractFields({ c, users }: { c?: Awaited<ReturnType<typeof contractsOf>>[number]; users: User[] }) {
  return (
    <div className="grid-2">
      <label className="field span-2"><span className="label">Nombre</span><input name="name" required defaultValue={c?.name ?? "Contrato anual"} /></label>
      <label className="field"><span className="label">Inicio</span><input name="start_date" type="date" required defaultValue={c?.start_date ?? new Date().toISOString().slice(0, 10)} /></label>
      <label className="field"><span className="label">Renovación</span><input name="renewal_date" type="date" defaultValue={c?.renewal_date ?? ""} /></label>
      <label className="field"><span className="label">Importe anual (€)</span><input name="annual_value" type="number" min={0} step="0.01" required defaultValue={c ? Number(c.annual_value) : ""} /></label>
      <label className="field"><span className="label">Licencias contratadas</span><input name="seats" type="number" min={1} defaultValue={c?.seats ?? ""} /></label>
      <label className="field"><span className="label">Responsable de CS</span>
        <select name="cs_owner_id" defaultValue={c?.cs_owner_id ?? ""}><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
      <label className="field"><span className="label">Estado</span>
        <select name="status" defaultValue={c?.status ?? "active"}><option value="active">Activo</option><option value="ended">Terminado</option><option value="cancelled">Cancelado (baja)</option></select></label>
      <label className="checkbox"><input type="checkbox" name="auto_renew" defaultChecked={c?.auto_renew ?? true} />Renovación automática</label>
      <label className="field span-2"><span className="label">Notas</span><textarea name="notes" rows={2} defaultValue={c?.notes ?? ""} /></label>
    </div>
  );
}

/** Ficha de cliente dentro de la empresa: contratos, salud, uso, onboarding, renovación y expansión. */
export async function AccountPanel({ orgId, csOwnerId, users }: { orgId: string; csOwnerId: string | null; users: User[] }) {
  const [contracts, health, usage, surveys, related, products] = await Promise.all([
    contractsOf(orgId), getAccountHealth(orgId), usageOf(orgId),
    sql<{ score: number; comment: string | null; kind: string; answered_at: Date }[]>`
      SELECT score, comment, kind, answered_at FROM surveys WHERE organization_id = ${orgId} AND answered_at IS NOT NULL ORDER BY answered_at DESC LIMIT 5`,
    sql<{ id: string; title: string; deal_type: string; status: string; stage: string; value: string | null }[]>`
      SELECT d.id, d.title, d.deal_type, d.status, s.name AS stage, d.value::text FROM deals d JOIN stages s ON s.id = d.stage_id
      WHERE d.organization_id = ${orgId} AND d.deal_type IN ('onboarding', 'renewal', 'upsell', 'cross_sell') AND d.deleted_at IS NULL
      ORDER BY (d.status = 'open') DESC, d.created_at DESC LIMIT 10`,
    listProducts(),
  ]);
  const humans = users.filter((u) => u.kind === "human");
  const active = contracts.filter((c) => c.status === "active");
  if (contracts.length === 0) {
    return (
      <section className="panel" aria-label="Cliente">
        <h2>Cliente</h2>
        <p className="muted">Todavía no es cliente. Al ganar un deal se crea su contrato y su onboarding; también puedes darlo de alta a mano.</p>
        <details>
          <summary className="meta">+ Dar de alta un contrato</summary>
          <ActionForm action={saveContractAction.bind(null, orgId, null)} submitLabel="Crear contrato" secondary><ContractFields users={humans} /></ActionForm>
        </details>
      </section>
    );
  }
  const arr = active.reduce((n, c) => n + Number(c.annual_value), 0);
  const seats = active.reduce((n, c) => n + (c.seats ?? 0), 0);
  const seatsUsed = usage.find((u) => ["licencias_en_uso", "seats_used", "usuarios"].includes(u.metric))?.last ?? null;
  const owned = new Set(active.flatMap((c) => c.items.map((i) => i.product_id)));
  return (
    <section className="panel account" aria-label="Cliente">
      <div className="item-head">
        <h2 style={{ margin: 0 }}>Cliente</h2>
        {health && <HealthBadge score={health.score} signals={health.signals} />}
        <span className="spacer" />
        <span className="meta">{active.length ? `${money(arr)} al año` : "Sin contrato activo"}</span>
      </div>
      <dl className="dl compact" style={{ marginTop: 8 }}>
        <div className="dl-row"><dt>Renovación</dt><dd>{active[0]?.renewal_date ? <>{date(active[0].renewal_date)} <span className="meta">(en {active[0].days_to_renewal} días)</span></> : "—"}</dd></div>
        {seats > 0 && <div className="dl-row"><dt>Licencias</dt><dd>{seatsUsed !== null ? `${seatsUsed} en uso de ${seats}` : `${seats} contratadas`}</dd></div>}
        <div className="dl-row"><dt>Customer Success</dt><dd>
          <ActionForm action={setCsOwnerAction.bind(null, orgId)} submitLabel="Guardar" secondary className="form inline">
            <select name="cs_owner_id" defaultValue={csOwnerId ?? ""} aria-label="Responsable de Customer Success">
              <option value="">Sin asignar</option>{humans.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </ActionForm></dd></div>
        {surveys[0] && <div className="dl-row"><dt>Satisfacción</dt><dd><strong>{surveys[0].score}</strong>/10 <span className="meta">· {date(surveys[0].answered_at)}{surveys[0].comment ? ` · «${surveys[0].comment}»` : ""}</span></dd></div>}
      </dl>

      {health && health.signals.length > 0 && (
        <ul className="signal-list" style={{ margin: "10px 0" }}>
          {health.signals.map((x) => (
            <li key={x.key} className={`signal ${x.tone}`}><span className="signal-points">{x.points > 0 ? "+" : ""}{x.points}</span><span>{x.label}{x.detail && <span className="meta"> — {x.detail}</span>}</span></li>
          ))}
        </ul>
      )}

      {usage.length > 0 && (
        <>
          <h3>Uso del producto</h3>
          <table className="usage-table"><tbody>
            {usage.map((u) => (
              <tr key={u.metric}><td>{u.metric.replace(/_/g, " ")}</td><td className="num"><strong>{u.last.toLocaleString("es-ES")}</strong></td>
                <td className={u.change30 === null ? "meta" : u.change30 < -0.05 ? "tone-bad" : u.change30 > 0.05 ? "tone-good" : "meta"}>
                  {u.change30 === null ? "—" : `${u.change30 >= 0 ? "+" : ""}${Math.round(u.change30 * 100)} % en 30 días`}</td>
                <td style={{ width: 110 }}><Spark points={u.points} /></td></tr>
            ))}
          </tbody></table>
        </>
      )}

      <h3>Contratos</h3>
      <ul className="items">
        {contracts.map((c) => (
          <li key={c.id} className={c.status === "active" ? "item" : "item done"}>
            <div className="item-head">
              <strong>{c.name}</strong>
              <span className={`badge ${c.status === "active" ? "won" : c.status === "cancelled" ? "lost" : ""}`}>{{ active: "Activo", ended: "Terminado", cancelled: "Cancelado" }[c.status]}</span>
              <span className="spacer" />
              <span className="meta">{money(c.annual_value, c.currency)}/año · desde {date(c.start_date)}{c.cs_owner_name ? ` · ${c.cs_owner_name}` : ""}</span>
            </div>
            {c.items.length > 0 && <p className="meta" style={{ margin: "4px 0" }}>{c.items.map((i) => `${i.name}${i.quantity !== 1 ? ` ×${i.quantity}` : ""}`).join(" · ")}</p>}
            <details>
              <summary className="meta">Editar</summary>
              <ActionForm action={saveContractAction.bind(null, orgId, c.id)} submitLabel="Guardar" secondary><ContractFields c={c} users={humans} /></ActionForm>
              {c.status === "active" && !related.some((d) => d.deal_type === "renewal" && d.status === "open") && (
                <ActionForm action={createRenewalAction.bind(null, orgId, c.id)} submitLabel="Preparar la renovación ahora" pendingLabel="…" secondary className="form inline" />
              )}
            </details>
          </li>
        ))}
      </ul>
      <details>
        <summary className="meta">+ Otro contrato</summary>
        <ActionForm action={saveContractAction.bind(null, orgId, null)} submitLabel="Crear contrato" secondary><ContractFields users={humans} /></ActionForm>
      </details>

      <h3>Onboarding, renovaciones y expansión</h3>
      {related.length === 0 ? <p className="meta">Nada todavía.</p> : (
        <ul className="mini-list">
          {related.map((d) => (
            <li key={d.id}><div><Link href={`/deals/${d.id}`}>{d.title}</Link>
              <div className="meta">{{ onboarding: "Onboarding", renewal: "Renovación", upsell: "Upsell", cross_sell: "Cross-sell" }[d.deal_type]} · {d.status === "open" ? d.stage : d.status === "won" ? "Ganado" : "Perdido"}{d.value ? ` · ${money(d.value)}` : ""}</div></div></li>
          ))}
        </ul>
      )}
      <details>
        <summary className="meta">+ Oportunidad de expansión</summary>
        <ActionForm action={createExpansionAction.bind(null, orgId)} submitLabel="Crear oportunidad" secondary>
          <div className="grid-2">
            <label className="field"><span className="label">Tipo</span><select name="type"><option value="upsell">Upsell (más de lo que ya tiene)</option><option value="cross_sell">Cross-sell (otro producto)</option></select></label>
            <label className="field"><span className="label">Producto</span><select name="product_id" defaultValue=""><option value="">—</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.name}{owned.has(p.id) ? " (ya lo tiene)" : ""}</option>)}</select></label>
            <label className="field span-2"><span className="label">Título</span><input name="title" required placeholder="Ampliar licencias para el equipo de Madrid" /></label>
            <label className="field"><span className="label">Importe estimado (€)</span><input name="value" type="number" min={0} step="0.01" /></label>
          </div>
        </ActionForm>
      </details>
      {surveys.length > 1 && (
        <details>
          <summary className="meta">Encuestas ({surveys.length})</summary>
          <ul className="mini-list">{surveys.map((s, i) => <li key={i}><div><strong>{s.score}</strong>/10 · {dateTime(s.answered_at)}{s.comment && <div className="meta">«{s.comment}»</div>}</div></li>)}</ul>
        </details>
      )}
    </section>
  );
}
