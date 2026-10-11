import Link from "next/link";
import { requireAdminPage } from "@/lib/auth";
import { aiSpend } from "@/lib/ai";
import { sql } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { fileSize } from "@/lib/files";
import { ROLE_LABELS } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Uso y actividad del equipo" };

/** Uso (como «Uso» y «Descripción general del usuario» de Pipedrive): cuánto se usa el CRM y quién. */
export default async function UsagePage() {
  await requireAdminPage();
  const [[c], spend, people] = await Promise.all([
    sql<{ users: number; invited: number; deals: number; open_deals: number; persons: number; orgs: number; leads: number; files_bytes: number;
          emails_month: number; seq_emails_month: number; activities_month: number; mailboxes: number }[]>`
      SELECT (SELECT count(*)::int FROM users WHERE kind = 'human' AND is_active AND (password_hash IS NOT NULL OR sso_enabled)) AS users,
             (SELECT count(*)::int FROM users WHERE kind = 'human' AND is_active AND password_hash IS NULL AND last_login_at IS NULL) AS invited,
             (SELECT count(*)::int FROM deals WHERE deleted_at IS NULL) AS deals,
             (SELECT count(*)::int FROM deals WHERE deleted_at IS NULL AND status = 'open') AS open_deals,
             (SELECT count(*)::int FROM persons WHERE deleted_at IS NULL) AS persons,
             (SELECT count(*)::int FROM organizations WHERE deleted_at IS NULL) AS orgs,
             (SELECT count(*)::int FROM leads WHERE deleted_at IS NULL) AS leads,
             coalesce((SELECT sum(size)::bigint FROM files), 0)::float8 AS files_bytes,
             (SELECT count(*)::int FROM emails WHERE direction = 'out' AND status = 'sent' AND sent_at >= date_trunc('month', now())) AS emails_month,
             (SELECT count(*)::int FROM emails WHERE direction = 'out' AND status = 'sent' AND enrollment_id IS NOT NULL AND sent_at >= date_trunc('month', now())) AS seq_emails_month,
             (SELECT count(*)::int FROM activities WHERE done AND done_at >= date_trunc('month', now())) AS activities_month,
             (SELECT count(*)::int FROM mailbox_connections WHERE status = 'active') AS mailboxes`,
    aiSpend().catch(() => null),
    sql<{ id: string; name: string; role: keyof typeof ROLE_LABELS; last_login_at: Date | null; logins: number; emails: number; activities: number; deals_won: number; mailbox: boolean }[]>`
      SELECT u.id, u.name, u.role, u.last_login_at,
             (SELECT count(*)::int FROM login_events l WHERE l.user_id = u.id AND l.success AND l.at > now() - interval '30 days') AS logins,
             (SELECT count(*)::int FROM emails m WHERE m.user_id = u.id AND m.direction = 'out' AND m.status = 'sent' AND m.sent_at > now() - interval '30 days') AS emails,
             (SELECT count(*)::int FROM activities a WHERE a.owner_id = u.id AND a.done AND a.done_at > now() - interval '30 days') AS activities,
             (SELECT count(*)::int FROM deals d WHERE d.owner_id = u.id AND d.status = 'won' AND d.won_at > now() - interval '30 days') AS deals_won,
             EXISTS (SELECT 1 FROM mailbox_connections m WHERE m.user_id = u.id AND m.purpose = 'main' AND m.status = 'active') AS mailbox
      FROM users u WHERE u.kind = 'human' AND u.is_active
      ORDER BY u.last_login_at DESC NULLS LAST`,
  ]);
  const money = (n: number) => `${n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
  // Arriba lo que mira un administrador (accesos, correo, IA); debajo, cuánto hay guardado.
  const main: [string, string | number, string?][] = [
    ["Usuarios con acceso", c.users, c.invited ? `${c.invited} invitados sin entrar` : undefined],
    ["Buzones conectados", c.mailboxes, c.mailboxes < c.users ? `${c.users - c.mailboxes} sin conectar` : undefined],
    ["Correos enviados este mes", c.emails_month, c.seq_emails_month ? `${c.seq_emails_month} de secuencias` : undefined],
    ["Actividades hechas este mes", c.activities_month],
    ["IA este mes", spend ? money(spend.month) : "—", spend?.budget ? `de ${money(spend.budget)} de presupuesto` : spend ? `${spend.calls} consultas a la IA` : undefined],
  ];
  const stored: [string, string | number][] = [
    ["Deals", `${c.deals.toLocaleString("es-ES")} (${c.open_deals.toLocaleString("es-ES")} abiertos)`], ["Contactos", c.persons.toLocaleString("es-ES")],
    ["Empresas", c.orgs.toLocaleString("es-ES")], ["Leads", c.leads.toLocaleString("es-ES")], ["Archivos", c.files_bytes ? fileSize(c.files_bytes) : "Sin archivos"],
  ];
  return (
    <main className="page">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><div><h1>Uso y actividad del equipo</h1><p className="muted" style={{ margin: 0 }}>Cuánto se usa el CRM y quién lo está usando.</p></div></div>
      <section className="kpi-row" aria-label="Uso">
        {main.map(([l, v, h]) => <div key={l} className="kpi"><span className="meta">{l}</span><strong>{v}</strong>{h && <span className="meta">{h}</span>}</div>)}
      </section>
      <p className="usage-stored meta" aria-label="Datos guardados">{stored.map(([l, v]) => <span key={l}>{l}: <strong>{v}</strong></span>)}</p>
      <section className="panel" aria-label="Por persona">
        <h2>Por persona (últimos 30 días)</h2>
        <div className="table-wrap flat"><table>
          <thead><tr><th>Persona</th><th>Última entrada</th><th className="num">Entradas</th><th className="num">Correos</th><th className="num">Actividades</th><th className="num">Deals ganados</th><th>Correo</th></tr></thead>
          <tbody>{people.map((p) => (
            <tr key={p.id}>
              <td><strong>{p.name}</strong><div className="meta">{ROLE_LABELS[p.role]}</div></td>
              <td className="nowrap">{p.last_login_at ? dateTime(p.last_login_at) : <span className="muted">Nunca</span>}</td>
              <td className="num">{p.logins || "—"}</td><td className="num">{p.emails || "—"}</td><td className="num">{p.activities || "—"}</td><td className="num">{p.deals_won || "—"}</td>
              <td>{p.mailbox ? <span className="badge">Conectado</span> : <span className="meta">Sin conectar</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
        <p className="meta">Quien no entra o no tiene el correo conectado no deja rastro en el CRM: revisa con él si necesita ayuda. <Link href="/settings/users">Usuarios</Link></p>
      </section>
    </main>
  );
}
