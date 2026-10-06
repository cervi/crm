import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listAccounts, recomputeAccountHealth } from "@/lib/accounts";
import { listUsers } from "@/lib/users";
import { sql } from "@/lib/db";
import { date, money } from "@/lib/format";
import { HealthBadge } from "@/components/HealthBadge";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clientes" };

/** Cartera de Customer Success: cada cliente con su importe, salud, renovación, onboarding y expansión. */
export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ owner?: string; f?: string }> }) {
  const [me, sp] = await Promise.all([requireUser(), searchParams]);
  const owner = sp.owner === "all" ? null : isId(sp.owner) ? sp.owner : null;
  const filter = ["risk", "renewing", "onboarding"].includes(sp.f ?? "") ? sp.f! : null;
  // La salud se calcula en cada revisión; las cuentas nuevas, ahora.
  const [missing] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM contracts c WHERE c.status = 'active' AND NOT EXISTS (SELECT 1 FROM account_health h WHERE h.organization_id = c.organization_id)`;
  if (missing.n) await recomputeAccountHealth().catch((err) => console.error("[salud de cuentas]", err));
  const [rows, all, users] = await Promise.all([listAccounts({ owner, filter }), listAccounts({ owner }), listUsers()]);
  const arr = all.reduce((n, r) => n + r.arr, 0);
  const risk = all.filter((r) => r.health !== null && r.health < 40).length;
  const renewing = all.filter((r) => r.days_to_renewal !== null && r.days_to_renewal <= 120);
  const qs = (p: Record<string, string | null>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ owner: sp.owner ?? null, f: filter, ...p })) if (v) u.set(k, v);
    return `/accounts${u.size ? `?${u}` : ""}`;
  };
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Clientes</h1>
          <p className="muted" style={{ margin: 0 }}>La cartera de Customer Success: salud de cada cuenta, renovaciones, onboarding y oportunidades de expansión.</p>
        </div>
        <span className="spacer" />
        <Link href="/accounts/matrix" className="btn secondary">Matriz de productos</Link>
      </div>
      <section className="today-stats" aria-label="Resumen">
        <Link href={qs({ f: null })} className="today-stat"><span className="label">Clientes</span><strong>{all.length}</strong><span className="meta">{money(arr)} al año</span></Link>
        <Link href={qs({ f: "risk" })} className={`today-stat ${risk ? "bad" : ""}`}><span className="label">En riesgo</span><strong>{risk}</strong><span className="meta">salud por debajo de 40</span></Link>
        <Link href={qs({ f: "renewing" })} className="today-stat warn"><span className="label">Renuevan en 120 días</span><strong>{renewing.length}</strong><span className="meta">{money(renewing.reduce((n, r) => n + r.arr, 0))}</span></Link>
        <Link href={qs({ f: "onboarding" })} className="today-stat"><span className="label">En onboarding</span><strong>{all.filter((r) => r.onboarding_deal_id && !r.onboarding_done).length}</strong></Link>
        <div className="today-stat"><span className="label">Expansión abierta</span><strong>{all.reduce((n, r) => n + r.open_expansion, 0)}</strong><span className="meta">oportunidades</span></div>
      </section>
      <nav className="chips" aria-label="Responsable">
        <Link href={qs({ owner: null })} aria-current={!sp.owner ? "page" : undefined}>Todos</Link>
        <Link href={qs({ owner: me.id })} aria-current={owner === me.id ? "page" : undefined}>Mis clientes</Link>
        {users.filter((u) => u.kind === "human" && u.id !== me.id).map((u) => <Link key={u.id} href={qs({ owner: u.id })} aria-current={owner === u.id ? "page" : undefined}>{u.name}</Link>)}
      </nav>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Cliente</th><th>Salud</th><th className="num">Importe anual</th><th>Renovación</th><th>Onboarding</th><th>Satisfacción</th><th>Expansión</th><th>Customer Success</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="empty-row">Sin clientes{filter ? " con este filtro" : ""}. Un cliente aparece aquí al ganar su primer deal (o al darle un contrato).</td></tr>}
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/organizations/${r.id}`}><strong>{r.name}</strong></Link>{r.seats ? <div className="meta">{r.seats} licencias</div> : null}</td>
                <td><HealthBadge score={r.health} signals={r.health_signals} /></td>
                <td className="num">{money(r.arr)}</td>
                <td>{r.renewal_date ? <>{date(r.renewal_date)}<div className={r.days_to_renewal !== null && r.days_to_renewal <= 60 && !r.renewal_deal_id ? "meta tone-bad" : "meta"}>
                  {r.days_to_renewal} días{r.renewal_deal_id ? <> · <Link href={`/deals/${r.renewal_deal_id}`}>en marcha</Link></> : ""}</div></> : "—"}</td>
                <td>{r.onboarding_deal_id ? <Link href={`/deals/${r.onboarding_deal_id}`}>{r.onboarding_done ? "Terminado" : r.onboarding_stage}</Link> : "—"}</td>
                <td>{r.nps !== null ? `${r.nps}/10` : "—"}</td>
                <td>{r.open_expansion || "—"}</td>
                <td>{r.cs_owner_name ?? <span className="meta">Sin asignar</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
