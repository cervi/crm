import Link from "next/link";
import { headers } from "next/headers";
import { assignMeetingNoteAction, ignoreMeetingNoteAction, pasteMeetingNoteAction } from "@/app/actions/meetings";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { EntityPicker } from "@/components/EntityPicker";
import { Icon } from "@/components/Icon";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { listMeetingNotes, meetingNoteCounts, NOTE_SOURCES, type MeetingNote } from "@/lib/meeting-notes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reuniones grabadas" };

const TABS = [
  { key: "pending", label: "Por asociar" },
  { key: "matched", label: "Asociadas" },
  { key: "ignored", label: "Descartadas" },
] as const;

function Excerpt({ n }: { n: MeetingNote }) {
  const text = (n.summary || n.notes || "").replace(/[#*_>`]/g, "").trim();
  return text ? <p className="meta clamp-2" style={{ margin: "4px 0 0" }}>{text.slice(0, 280)}</p> : null;
}

export default async function MeetingNotesPage({ searchParams }: { searchParams: Promise<{ ver?: string; pegar?: string }> }) {
  const [me, sp] = await Promise.all([requireUser(), searchParams]);
  const counts = await meetingNoteCounts();
  const view = (TABS.find((t) => t.key === sp.ver)?.key ?? ((counts.pending ?? 0) > 0 || !(counts.matched ?? 0) ? "pending" : "matched"));
  const [notes, google] = await Promise.all([
    listMeetingNotes({ status: view }),
    sql<{ email: string; notes_error: string | null; sync_calendar: boolean }[]>`
      SELECT email, notes_error, sync_calendar FROM mailbox_connections WHERE provider = 'google' AND status = 'active'`,
  ]);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  const apiReady = (process.env.INBOUND_API_KEYS ?? "").split(",").some((k) => k.trim().length >= 16);
  const writer = me.role !== "viewer";
  const missingScope = google.filter((g) => g.notes_error);

  return (
    <main className="page medium">
      <div className="page-head">
        <div>
          <h1>Reuniones grabadas</h1>
          <p className="muted" style={{ margin: 0 }}>
            Las notas de Granola y de Gemini en Google Meet llegan solas y se guardan en su reunión, contacto y deal o lead.
            La reunión queda como realizada y la IA prepara el correo de resumen y actualiza lo que sabemos del deal.
          </p>
        </div>
        <div className="head-actions">
          <Drawer label="Cómo conectarlo" title="Conectar Granola y Google Meet" subtitle="Una vez conectado no hay que hacer nada: las notas llegan después de cada reunión.">
            <div className="stack">
              <h3>Google Meet (notas de Gemini)</h3>
              <ol className="steps-list">
                <li>En Meet, activa «Tomar notas con Gemini» (o la transcripción) en la reunión. Google adjunta el documento al evento del calendario.</li>
                <li>Conecta tu cuenta de Google en <Link href="/settings/mailbox">Ajustes → Correo, calendario y documentos</Link> con el calendario activado.</li>
                <li>Si ya la tenías conectada, vuelve a conectarla una vez para dar permiso de lectura de esos documentos.</li>
              </ol>
              {google.length === 0 && <p className="callout">Aún no hay ninguna cuenta de Google conectada.</p>}

              <h3>Granola (con Zapier)</h3>
              <ol className="steps-list">
                <li>En Zapier, crea un Zap con el disparador <strong>Granola → Note Added to Granola Folder</strong> (elige una carpeta, p. ej. «CRM») o <strong>Note Shared to Zapier</strong>.</li>
                <li>Acción: <strong>Webhooks by Zapier → POST</strong> a <code>{origin}/api/v1/meetings</code>, con <em>Payload type</em> <code>json</code>.</li>
                <li>En <em>Data</em> añade: <code>source</code> = <code>granola</code>, <code>id</code>, <code>title</code>, <code>creator_email</code>,{" "}
                  <code>attendees_email</code>, <code>attendees_name</code>, <code>started_at</code> (fecha del evento), <code>summary</code>, <code>notes</code>, <code>transcript</code> y <code>link</code>, cada uno con su campo de Granola.</li>
                <li>En <em>Headers</em>: <code>Authorization</code> = <code>Bearer</code> y la clave de la API de entrada (la misma que usáis para formularios).</li>
                <li>Prueba el Zap: la nota aparecerá aquí.</li>
              </ol>
              {apiReady
                ? <p className="callout good">La API de entrada está activa.</p>
                : <p className="callout">La API de entrada aún no está activa: hay que definir la variable <code>INBOUND_API_KEYS</code> en el servidor.</p>}
              <p className="meta">La integración de Granola con Zapier es para sus planes de pago. Sin ella, copia las notas y pégalas con «Pegar notas».</p>

              <h3>Cómo se asocian</h3>
              <ul className="plain-list meta">
                <li>Primero, a la reunión del calendario que ya está en el CRM (misma reunión o mismos contactos a la misma hora).</li>
                <li>Si no, al deal abierto de los asistentes; si no tienen, a su lead abierto; si no, al contacto.</li>
                <li>Si un asistente no está en el CRM pero su empresa sí (por el dominio del correo), se da de alta en ella.</li>
                <li>Las reuniones solo con gente de tu equipo se descartan. Si hay dudas, la nota espera aquí.</li>
              </ul>
            </div>
          </Drawer>
          {writer && (
            <Drawer label={<><Icon name="plus" />Pegar notas</>} title="Pegar notas de una reunión" defaultOpen={sp.pegar === "1"}
                    subtitle="Para notas copiadas de Granola, de otra herramienta o escritas a mano. Se asocian igual que las automáticas.">
              <ActionForm action={pasteMeetingNoteAction} submitLabel="Guardar notas" resetOnSuccess>
                <label className="field"><span className="label">Título de la reunión</span><input name="title" maxLength={300} placeholder="Demo con Acme" /></label>
                <label className="field"><span className="label">Fecha y hora</span><input name="started_at" type="datetime-local" /></label>
                <label className="field"><span className="label">Asistentes (correos) *</span>
                  <input name="attendees" required placeholder="ana@acme.com, Luis Pérez <luis@acme.com>" />
                  <span className="meta">Con sus correos se encuentra el contacto y su deal.</span></label>
                <label className="field"><span className="label">Notas o resumen *</span><textarea name="notes" rows={8} required /></label>
                <label className="field"><span className="label">Transcripción</span><textarea name="transcript" rows={4} /></label>
              </ActionForm>
            </Drawer>
          )}
        </div>
      </div>

      {missingScope.length > 0 && (
        <p className="callout">
          No podemos leer las notas de Meet de {missingScope.map((g) => g.email).join(", ")}: falta un permiso nuevo.{" "}
          <Link href="/settings/mailbox">Vuelve a conectar la cuenta de Google</Link>.
        </p>
      )}

      <nav className="tabs" aria-label="Estado">
        {TABS.map((t) => (
          <Link key={t.key} href={`/reuniones?ver=${t.key}`} className={view === t.key ? "active" : ""} aria-current={view === t.key ? "page" : undefined}>
            {t.label}{counts[t.key] ? <span className="count">{counts[t.key]}</span> : null}
          </Link>
        ))}
      </nav>

      {notes.length === 0 ? (
        <section className="panel empty">
          {view === "pending" ? <p>No hay notas esperando. Las que no se puedan asociar solas aparecerán aquí.</p>
            : view === "matched" ? <p>Todavía no ha llegado ninguna nota. Mira «Cómo conectarlo» para enlazar Granola o Google Meet.</p>
            : <p>No hay notas descartadas.</p>}
        </section>
      ) : (
        <ul className="card-list">
          {notes.map((n) => (
            <li key={n.id} className="panel">
              <div className="row-between">
                <div>
                  <strong>{n.title || "Reunión sin título"}</strong>
                  <div className="meta">
                    {NOTE_SOURCES[n.source] ?? n.source} · {dateTime(n.started_at ?? n.created_at)}{n.owner_name ? ` · ${n.owner_name}` : ""}
                    {n.attendees.length ? ` · ${n.attendees.slice(0, 4).map((a) => a.name || a.email).join(", ")}${n.attendees.length > 4 ? ` y ${n.attendees.length - 4} más` : ""}` : ""}
                    {n.transcript_len ? " · con transcripción" : ""}
                  </div>
                </div>
                {n.link && <a className="btn secondary small" href={n.link} target="_blank" rel="noreferrer">Ver original</a>}
              </div>
              <Excerpt n={n} />
              {n.status === "matched" ? (
                <p className="meta" style={{ marginBottom: 0 }}>
                  <Icon name="check" /> {n.deal_id ? <>En el deal <Link href={`/deals/${n.deal_id}`}>{n.deal_title}</Link></>
                    : n.lead_id ? <>En el lead <Link href={`/leads/${n.lead_id}`}>{n.lead_title}</Link></>
                    : n.person_names.length ? <>En {n.person_names.join(", ")}</> : "Asociada"}
                  {n.match_reason ? ` · ${n.match_reason.toLowerCase()}` : ""}
                </p>
              ) : (
                <>
                  {n.match_reason && <p className="meta" style={{ marginBottom: 0 }}>{n.match_reason}</p>}
                  {writer && (
                    <div className="row-actions" style={{ marginTop: 8 }}>
                      {n.status === "pending" && (
                        <Drawer label="Asociar" buttonClass="btn small" title="Asociar la nota" subtitle={n.title ?? undefined}>
                          <ActionForm action={assignMeetingNoteAction.bind(null, n.id)} submitLabel="Asociar">
                            <EntityPicker name="deal_id" type="deals" label="Deal" placeholder="Busca un deal abierto" />
                            <EntityPicker name="lead_id" type="leads" label="O un lead" placeholder="Busca un lead abierto" />
                            <EntityPicker name="person_id" type="persons" label="Contacto" placeholder="Opcional si eliges deal o lead" />
                            <p className="meta">Se crea la reunión como realizada con estas notas y la IA prepara el resumen.</p>
                          </ActionForm>
                        </Drawer>
                      )}
                      <ActionForm action={ignoreMeetingNoteAction.bind(null, n.id, n.status === "pending")} secondary className="form inline"
                                  submitLabel={n.status === "pending" ? "Descartar" : "Recuperar"} />
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
