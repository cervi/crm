import Link from "next/link";
import { notFound } from "next/navigation";
import { cancelSignAction, deleteSignAction, duplicateSignAction, remindSignAction } from "@/app/actions/esign";
import { ActionForm } from "@/components/ActionForm";
import { Icon } from "@/components/Icon";
import { SignEditor } from "@/components/esign/SignEditor";
import { SignPreview } from "@/components/esign/SignPreview";
import { CopyLink } from "@/components/esign/CopyLink";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { dealParticipants } from "@/lib/deals";
import { getRequest, REQUEST_STATUS, SIGNER_STATUS, type SignEvent } from "@/lib/esign";
import { SIGN_LANGUAGES } from "@/lib/esign-i18n";
import { publicBase } from "@/lib/email-track";
import { dateTime } from "@/lib/format";
import { listConnections } from "@/lib/mailbox";

export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const g = await getRequest((await params).id);
  return { title: g ? `Firma · ${g.request.title}` : "Firma" };
}

const EVENT_TEXT: Record<string, string> = {
  created: "Documento creado", sent: "Enviado a firmar", invited: "Invitación enviada", viewed: "Lo ha abierto", code_sent: "Código enviado por correo",
  code_verified: "Código verificado", signed: "Ha firmado", declined: "Ha rechazado firmar", reminded: "Recordatorio enviado", completed: "Firmado por todos",
  cancelled: "Firma cancelada", expired: "Ha caducado", error: "Error",
};
const ago = (d: Date) => {
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  return days === 0 ? "hoy" : days === 1 ? "hace 1 día" : `hace ${days} días`;
};

export default async function SignRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const [me, { id }] = await Promise.all([requireUser(), params]);
  const g = await getRequest(id);
  if (!g) notFound();
  const { request: r, signers, fields, events } = g;
  const back = r.deal_id ? `/deals/${r.deal_id}` : "/firmas";

  if (r.status === "draft") {
    const [participants, users, conns] = await Promise.all([
      r.deal_id ? dealParticipants(r.deal_id) : Promise.resolve([]),
      sql<{ id: string; name: string; email: string | null }[]>`SELECT id, name, email FROM users WHERE kind = 'human' AND is_active ORDER BY name`,
      listConnections(),
    ]);
    const senders = conns.filter((c) => c.status === "active").map((c) => ({ id: c.user_id, name: c.user_name ?? c.email, email: c.email }));
    return (
      <main className="page sign-page">
        <div className="crumbs">{r.deal_id ? <Link href={`/deals/${r.deal_id}`}>{r.deal_title}</Link> : <Link href="/firmas">Firmas</Link>}</div>
        <div className="page-head">
          <div>
            <h1>Preparar para firmar</h1>
            <p className="muted" style={{ margin: 0 }}>{r.file_name} · {r.pages.length} página{r.pages.length === 1 ? "" : "s"} · borrador guardado</p>
          </div>
          <div className="head-actions">
            <ActionForm action={deleteSignAction.bind(null, id, back)} submitLabel="Descartar borrador" secondary className="form inline"
                        confirm="Se borra este borrador. El PDF original no se toca." />
          </div>
        </div>
        <SignEditor id={id} back={back} pages={r.pages}
          init={{ title: r.title, language: r.language, subject: r.subject, message: r.message, sequential: r.sequential, require_code: r.require_code,
                  reminder_days: r.reminder_days, expires_days: r.expires_days, sender_id: r.sender_id }}
          signers={signers.map((s) => ({ id: s.id, key: s.id, name: s.name, email: s.email, kind: s.kind, user_id: s.user_id, person_id: s.person_id, color: s.color }))}
          fields={fields.map((f) => ({ signer_id: f.signer_id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, hint: f.hint }))}
          suggestions={[
            ...participants.filter((p) => p.email).map((p) => ({ name: p.full_name, email: p.email!, kind: "external" as const, person_id: p.person_id,
              note: [p.job_title, p.organization_name].filter(Boolean).join(" · ") || "contacto del deal" })),
            ...users.filter((u) => u.email).map((u) => ({ name: u.name, email: u.email!, kind: "internal" as const, user_id: u.id, note: u.id === me.id ? "tú" : "de tu equipo" })),
          ]}
          senders={senders} />
      </main>
    );
  }

  // Enviado, firmado, rechazado…
  const st = REQUEST_STATUS[r.status];
  const signedN = signers.filter((s) => s.status === "signed").length;
  const base = publicBase();
  const owners = new Map(signers.map((s) => [s.id, s]));
  return (
    <main className="page medium sign-page">
      <div className="crumbs">{r.deal_id ? <Link href={`/deals/${r.deal_id}`}>{r.deal_title}</Link> : null} <Link href="/firmas">Firmas</Link></div>
      <div className="page-head">
        <div>
          <h1>{r.title}</h1>
          <p className="muted" style={{ margin: 0 }}>
            <span className={`badge ${st.tone}`}>{st.label}</span>{" "}
            {signedN}/{signers.length} firmas · {r.sent_at ? `enviado ${dateTime(r.sent_at)}` : ""}
            {r.status === "sent" && r.expires_at ? ` · caduca ${dateTime(r.expires_at)}` : ""}
            {r.completed_at ? ` · completado ${dateTime(r.completed_at)}` : ""} · {SIGN_LANGUAGES[r.language]}{r.sequential ? " · en orden" : ""}
          </p>
        </div>
        <div className="head-actions">
          {r.has_signed && <a className="btn" href={`/api/firmas/${id}/pdf?v=signed&dl=1`}><Icon name="download" />Descargar firmado</a>}
          <a className="btn secondary" href={`/api/firmas/${id}/pdf?dl=1`}><Icon name="download" />Original</a>
          {r.status === "sent" && (
            <ActionForm action={cancelSignAction.bind(null, id)} submitLabel="Cancelar la firma" secondary className="form inline"
                        confirm="Los enlaces dejan de funcionar y nadie más podrá firmar. Lo ya firmado se conserva en el registro." />
          )}
          {(r.status === "declined" || r.status === "expired" || r.status === "cancelled") && (
            <ActionForm action={duplicateSignAction.bind(null, id)} submitLabel="Crear una versión nueva" className="form inline" />
          )}
        </div>
      </div>

      {r.status === "sent" && (
        <p className="callout">
          {signers.filter((s) => s.status === "pending").map((s) => s.name).join(", ") || "Nadie"} {signers.filter((s) => s.status === "pending").length === 1 ? "tiene" : "tienen"} la firma pendiente
          {r.sent_at ? ` desde ${ago(r.sent_at)}` : ""}. {r.reminder_days ? `Les recordamos solos cada ${r.reminder_days} día${r.reminder_days === 1 ? "" : "s"}.` : "Los recordatorios automáticos están desactivados."}
        </p>
      )}

      <section className="panel" aria-label="Firmantes">
        <h2>Firmantes</h2>
        <div className="table-wrap">
          <table>
            <thead><tr>{r.sequential && <th className="num">Orden</th>}<th>Firmante</th><th>Estado</th><th>Abierto</th><th>Firmado</th><th><span className="sr-only">Acciones</span></th></tr></thead>
            <tbody>
              {signers.map((s) => (
                <tr key={s.id}>
                  {r.sequential && <td className="num">{s.position}</td>}
                  <td><span className={`signer-dot c${s.color}`} aria-hidden="true" /><strong>{s.name}</strong>
                    <div className="meta">{s.email} · {s.kind === "internal" ? "de tu empresa" : "del cliente"}</div></td>
                  <td><span className={`badge ${s.status === "signed" ? "won" : s.status === "declined" ? "lost" : s.status === "pending" ? "warn" : ""}`}>{SIGNER_STATUS[s.status]}</span>
                    {s.decline_reason && <div className="meta">«{s.decline_reason}»</div>}</td>
                  <td className="nowrap">{s.first_viewed_at ? <>{dateTime(s.first_viewed_at)}<div className="meta">{s.view_count} {s.view_count === 1 ? "vez" : "veces"}</div></> : <span className="muted">Aún no</span>}</td>
                  <td className="nowrap">{s.signed_at ? <>{dateTime(s.signed_at)}{s.ip && <div className="meta">IP {s.ip}</div>}</> : <span className="muted">—</span>}</td>
                  <td className="row-actions">
                    {r.status === "sent" && s.status === "pending" && (
                      <>
                        <ActionForm action={remindSignAction.bind(null, id, s.id)} submitLabel="Recordar" secondary className="form inline" />
                        {base && <CopyLink url={`${base}/firma/${s.token}`} />}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="sign-status-grid">
        <section className="panel" aria-label="Documento">
          <h2>Documento</h2>
          <SignPreview url={r.has_signed ? `/api/firmas/${id}/pdf` : `/api/firmas/${id}/pdf`} pages={r.pages}
                       fields={fields.map((f) => ({ id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h,
                         value: owners.get(f.signer_id)?.status === "signed" ? f.value : null, owner: owners.get(f.signer_id)?.name ?? "", color: owners.get(f.signer_id)?.color ?? 1 }))} />
        </section>
        <section className="panel" aria-label="Registro de auditoría">
          <h2>Registro</h2>
          <ol className="audit-list">
            {events.map((e: SignEvent) => (
              <li key={e.id} className={`k-${e.kind}`}>
                <span className="meta nowrap">{dateTime(e.at)}</span>
                <span><strong>{EVENT_TEXT[e.kind] ?? e.kind}</strong>{e.signer_name ? ` · ${e.signer_name}` : ""}
                  {e.detail && <span className="meta"> · {e.detail}</span>}{e.ip && <span className="meta"> · IP {e.ip}</span>}</span>
              </li>
            ))}
          </ol>
          <p className="meta">Huella del original (SHA-256): <code className="hash">{r.original_sha256}</code></p>
          {r.signed_sha256 && <p className="meta">Huella del firmado: <code className="hash">{r.signed_sha256}</code></p>}
        </section>
      </div>
    </main>
  );
}
