import Link from "next/link";
import { notFound } from "next/navigation";
import { enrollManyAction } from "@/app/actions/sequences";
import { ActionForm } from "@/components/ActionForm";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { listConnections, listOutboundMailboxes } from "@/lib/mailbox";
import { ENROLL_ISSUES, checkEnrollment, getSequence, type EnrollIssue } from "@/lib/sequences";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Añadir contactos a la secuencia" };

type Found = { id: string; full_name: string; email: string | null; organization: string | null; job_title: string | null; owner: string | null; active_seq: string | null };

/** Añadir contactos (como en Apollo): buscarlos o pegar sus correos, revisar los avisos y elegir el buzón. */
export default async function AddContactsPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ q?: string; pegar?: string; ids?: string | string[]; libres?: string }>;
}) {
  const [{ id }, sp, user] = await Promise.all([params, searchParams, requireUser()]);
  if (!isId(id)) notFound();
  const seq = await getSequence(id);
  if (!seq) notFound();
  const back = `/sequences/${id}?tab=contactos`;
  const ids = (Array.isArray(sp.ids) ? sp.ids : (sp.ids ?? "").split(",")).map((x) => x.trim()).filter(isId);

  // Correos pegados: los que ya están en el CRM entran a la revisión; los que no, se pueden crear.
  const pasted = (sp.pegar ?? "").split(/[\n,;]+/).map((l) => l.trim()).filter(Boolean).slice(0, 1000);
  const pastedEmails = pasted.map((l) => ({ line: l, email: (l.match(/[^\s<>"]+@[^\s<>"]+\.[^\s<>"]+/)?.[0] ?? "").toLowerCase() })).filter((x) => x.email);
  let unknown: string[] = [];
  if (pastedEmails.length) {
    const known = await sql<{ email: string; person_id: string }[]>`
      SELECT DISTINCT ON (lower(pe.email)) lower(pe.email) AS email, pe.person_id FROM person_emails pe JOIN persons p ON p.id = pe.person_id AND p.deleted_at IS NULL
      WHERE lower(pe.email) = ANY(${pastedEmails.map((x) => x.email)}::text[])`;
    ids.push(...known.map((k) => k.person_id));
    unknown = pastedEmails.filter((x) => !known.some((k) => k.email === x.email)).map((x) => x.line);
  }
  const reviewing = ids.length > 0 || unknown.length > 0;

  const q = (sp.q ?? "").trim();
  const found = !reviewing && q.length >= 2 ? await sql<Found[]>`
    SELECT p.id, p.full_name, o.name AS organization, po.job_title, u.name AS owner,
           (SELECT email FROM person_emails WHERE person_id = p.id ORDER BY is_primary DESC, created_at LIMIT 1) AS email,
           (SELECT s.name FROM sequence_enrollments e JOIN sequences s ON s.id = e.sequence_id WHERE e.person_id = p.id AND e.status IN ('active', 'paused') LIMIT 1) AS active_seq
    FROM persons p
    LEFT JOIN LATERAL (SELECT organization_id, job_title FROM person_organizations WHERE person_id = p.id AND status = 'current' ORDER BY created_at DESC LIMIT 1) po ON true
    LEFT JOIN organizations o ON o.id = po.organization_id
    LEFT JOIN users u ON u.id = p.owner_id
    WHERE p.deleted_at IS NULL AND p.unsubscribed_at IS NULL
      AND (lower(p.full_name) LIKE ${`%${q.toLowerCase()}%`} OR lower(coalesce(o.name, '')) LIKE ${`%${q.toLowerCase()}%`}
           OR lower(coalesce(po.job_title, '')) LIKE ${`%${q.toLowerCase()}%`}
           OR EXISTS (SELECT 1 FROM person_emails pe WHERE pe.person_id = p.id AND lower(pe.email) LIKE ${`%${q.toLowerCase()}%`}))
      AND (${sp.libres !== "1"} OR NOT EXISTS (SELECT 1 FROM sequence_enrollments e WHERE e.person_id = p.id AND e.status IN ('active', 'paused')))
    ORDER BY p.full_name LIMIT 200` : [];

  const checks = reviewing ? await checkEnrollment(id, ids) : [];
  const byIssue = new Map<EnrollIssue | "ok", number>();
  for (const c of checks) byIssue.set(c.issue ?? "ok", (byIssue.get(c.issue ?? "ok") ?? 0) + 1);
  const [conns, outbound] = reviewing ? await Promise.all([listConnections(), listOutboundMailboxes()]) : [[], []];
  const mailboxes = [...conns, ...outbound].filter((c) => c.status === "active" && !c.paused);
  const mine = conns.find((c) => c.user_id === user.id && c.status === "active");

  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/sequences">Secuencias</Link> · <Link href={back}>{seq.name}</Link></div>
      <div className="page-head"><div><h1>Añadir contactos</h1>
        <p className="muted" style={{ margin: 0 }}>Empiezan en el paso 1 según el horario de envío de la secuencia{seq.is_active ? "" : " (ahora está en pausa: no saldrá nada hasta que la actives)"}.</p></div></div>

      {!reviewing && (
        <div className="grid-2">
          <section className="panel">
            <h2>Buscar en el CRM</h2>
            <form className="form" method="get">
              <label className="field"><span className="label">Nombre, correo, empresa o cargo</span><input name="q" defaultValue={q} autoFocus minLength={2} required /></label>
              <label className="checkbox"><input type="checkbox" name="libres" value="1" defaultChecked={sp.libres === "1"} />Solo los que no están en ninguna secuencia</label>
              <div className="form-actions"><button className="btn secondary" type="submit">Buscar</button></div>
            </form>
          </section>
          <section className="panel">
            <h2>Pegar correos</h2>
            <form className="form" method="get">
              <label className="field"><span className="label">Uno por línea (o «Nombre &lt;correo&gt;»)</span>
                <textarea name="pegar" rows={5} required placeholder={"ana@empresa.com\nLuis Pérez <luis@otra.com>"} /></label>
              <div className="form-actions"><button className="btn secondary" type="submit">Revisar</button></div>
            </form>
          </section>
        </div>
      )}

      {!reviewing && q.length >= 2 && (
        <section className="panel" aria-label="Resultados">
          {found.length === 0 ? <p className="muted">Nadie con «{q}».</p> : (
            <form method="get">
              <div className="play-head"><h2 style={{ margin: 0 }}>{found.length} contacto{found.length === 1 ? "" : "s"}{found.length === 200 ? " (los 200 primeros)" : ""}</h2>
                <button className="btn" type="submit">Revisar los seleccionados</button></div>
              <div className="table-wrap flat"><table>
                <thead><tr><th className="check-col" /><th>Contacto</th><th>Empresa</th><th>Responsable</th><th>Ahora</th></tr></thead>
                <tbody>{found.map((p) => (
                  <tr key={p.id}>
                    <td className="check-col"><input type="checkbox" name="ids" value={p.id} defaultChecked={!p.active_seq && Boolean(p.email)} aria-label={`Elegir a ${p.full_name}`} /></td>
                    <td><strong>{p.full_name}</strong><div className="meta">{p.email ?? "sin email"}{p.job_title ? ` · ${p.job_title}` : ""}</div></td>
                    <td>{p.organization ?? "—"}</td><td className="meta">{p.owner ?? "—"}</td>
                    <td className="meta">{p.active_seq ? `En «${p.active_seq}»` : "—"}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </form>
          )}
        </section>
      )}

      {reviewing && (
        <ActionForm action={enrollManyAction.bind(null, id)} submitLabel={`Añadir a «${seq.name}»`} pendingLabel="Añadiendo…">
          {checks.map((c) => <input key={c.person_id} type="hidden" name="ids" value={c.person_id} />)}
          <section className="panel" aria-label="Revisión">
            <h2>Revisión</h2>
            <ul className="plain-list">
              <li><strong>{byIssue.get("ok") ?? 0}</strong> listos para entrar</li>
              {(Object.keys(ENROLL_ISSUES) as EnrollIssue[]).filter((k) => byIssue.get(k)).map((k) => (
                <li key={k}>
                  <strong>{byIssue.get(k)}</strong> {ENROLL_ISSUES[k].label.toLowerCase()}{" "}
                  {ENROLL_ISSUES[k].blocking ? <span className="meta">· no entran</span>
                    : <label className="checkbox" style={{ display: "inline-flex", marginLeft: 6 }}><input type="checkbox" name="include" value={k} />Añadirlos igualmente</label>}
                </li>
              ))}
              {unknown.length > 0 && <li><strong>{unknown.length}</strong> correos que no están en el CRM <span className="meta">· créalos antes (Contactos → Importar) o pega solo los que existen</span></li>}
            </ul>
            <details>
              <summary className="meta">Ver la lista ({checks.length})</summary>
              <div className="table-wrap flat"><table>
                <thead><tr><th>Contacto</th><th>Empresa</th><th>Aviso</th></tr></thead>
                <tbody>{checks.map((c) => (
                  <tr key={c.person_id}><td>{c.name}<div className="meta">{c.email ?? "sin email"}</div></td><td>{c.organization ?? "—"}</td>
                    <td>{c.issue ? <span className={`badge ${ENROLL_ISSUES[c.issue].blocking ? "lost" : "warn"}`}>{ENROLL_ISSUES[c.issue].label}</span> : <span className="badge won">Listo</span>}
                      {c.detail && <div className="meta">{c.detail}</div>}</td></tr>
                ))}</tbody>
              </table></div>
            </details>
          </section>
          <section className="panel" aria-label="Buzón">
            <h2>Desde qué buzón</h2>
            {mailboxes.length === 0 ? <p className="callout">No hay ningún buzón conectado: los correos automáticos no podrán salir. Conéctalo en <Link href="/settings/mailbox">Correo, calendario y documentos</Link>.</p> : (
              <>
                <div className="rules-grid">
                  {mailboxes.map((m) => (
                    <label key={m.id} className="checkbox"><input type="checkbox" name="mailbox_ids" value={m.id} defaultChecked={m.id === mine?.id} />
                      {m.email} <span className="meta">{m.purpose === "outbound" ? "outbound" : m.user_name}</span></label>
                  ))}
                </div>
                <p className="meta" style={{ margin: 0 }}>Si eliges varios, se reparten según la capacidad libre de cada uno hoy. Si no eliges ninguno, sale del buzón del responsable de cada contacto.</p>
              </>
            )}
          </section>
          <p className="meta"><Link href={`/sequences/${id}/anadir`}>Empezar de nuevo</Link></p>
        </ActionForm>
      )}
    </main>
  );
}
