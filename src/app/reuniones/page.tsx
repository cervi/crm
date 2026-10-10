import Link from "next/link";
import { headers } from "next/headers";
import { assignMeetingNoteAction, ignoreMeetingNoteAction, pasteMeetingNoteAction } from "@/app/actions/meetings";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
import { AssignNoteFields } from "@/components/meetings/AssignNoteFields";
import { requireUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { getMeetingNote, listMeetingNotes, meetingNoteCounts, NOTE_SOURCES, type MeetingNote } from "@/lib/meeting-notes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reuniones grabadas" };

const TABS = [
  { key: "pending", label: "Por asociar" },
  { key: "matched", label: "Asociadas" },
  { key: "ignored", label: "Descartadas" },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** Extracto legible: sin encabezados ni marcas de Markdown, las líneas separadas por «·». */
function excerpt(n: MeetingNote) {
  const lines = (n.summary || n.notes || "").split("\n")
    .filter((l) => !/^\s*#/.test(l) && !/^\s*(resumen|summary|notas|notes|próximos pasos|next steps)\s*:?\s*$/i.test(l))
    .map((l) => l.replace(/^\s*[-*•]\s+/, "").replace(/[*_`>]/g, "").trim()).filter(Boolean);
  const t = lines.join(" · ");
  return t.length > 260 ? `${t.slice(0, 257)}…` : t;
}

function Where({ n }: { n: MeetingNote }) {
  if (n.deal_id) return <>En el deal <Link href={`/deals/${n.deal_id}`}>{n.deal_title}</Link></>;
  if (n.lead_id) return <>En el lead <Link href={`/leads/${n.lead_id}`}>{n.lead_title}</Link></>;
  return <>En la ficha de {n.person_names.join(", ") || "el contacto"}</>;
}

export default async function MeetingNotesPage({ searchParams }: { searchParams: Promise<{ ver?: string; pegar?: string; hecho?: string; accion?: string }> }) {
  const [me, sp] = await Promise.all([requireUser(), searchParams]);
  const admin = me.role === "admin";
  const viewer = { id: me.id, admin };
  const counts = await meetingNoteCounts(viewer);
  const view: Tab = TABS.find((t) => t.key === sp.ver)?.key ?? ((counts.pending ?? 0) > 0 || !(counts.matched ?? 0) ? "pending" : "matched");
  const [notes, google, done] = await Promise.all([
    listMeetingNotes(viewer, { status: view }),
    sql<{ email: string; notes_error: string | null; user_id: string }[]>`
      SELECT email, notes_error, user_id FROM mailbox_connections
      WHERE provider = 'google' AND status = 'active' AND (${admin} OR user_id = ${me.id})`,
    sp.hecho ? getMeetingNote(viewer, sp.hecho) : Promise.resolve(null),
  ]);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:3000"}`;
  const apiReady = (process.env.INBOUND_API_KEYS ?? "").split(",").some((k) => k.trim().length >= 16);
  const writer = me.role !== "viewer";
  const mine = google.find((g) => g.user_id === me.id);
  const missingScope = google.filter((g) => g.notes_error);

  return (
    <main className="page medium">
      <div className="page-head">
        <div>
          <h1>Reuniones grabadas</h1>
          <p className="muted" style={{ margin: 0 }}>Las notas de tus reuniones (Granola, Gemini en Meet) se guardan solas en su deal o lead.</p>
        </div>
        <div className="head-actions">
          <Drawer label="Cómo conectarlo" title="Conectar Granola y Google Meet" subtitle="Se conecta una vez: después las notas llegan solas tras cada reunión.">
            <div className="stack">
              <h3>Google Meet (notas de Gemini)</h3>
              <ol className="steps-list">
                <li>En la reunión de Meet, activa «Tomar notas con Gemini» o la transcripción. Google adjunta el documento al evento del calendario.</li>
                <li>Conecta tu cuenta de Google en <Link href="/settings/mailbox">Ajustes → Correo, calendario y documentos</Link> con el calendario activado.
                  {mine ? " Ya la tienes conectada." : ""}</li>
                <li>Si la conectaste antes de esta función, vuelve a conectarla una vez para dar permiso de lectura de esos documentos.</li>
              </ol>

              <h3>Granola</h3>
              {admin ? (
                <>
                  <ol className="steps-list">
                    <li>En Zapier, crea un Zap con el disparador <strong>Granola → Note Added to Granola Folder</strong> (elige una carpeta, p. ej. «CRM») o <strong>Note Shared to Zapier</strong>.</li>
                    <li>Acción: <strong>Webhooks by Zapier → POST</strong> a <code>{origin}/api/v1/meetings</code>, con <em>Payload type</em> <code>json</code>.</li>
                    <li>En <em>Data</em> añade <code>source</code> = <code>granola</code> y, cada uno con su campo de Granola: <code>id</code>, <code>title</code>, <code>creator_email</code>,{" "}
                      <code>attendees_email</code>, <code>attendees_name</code>, <code>started_at</code>, <code>summary</code>, <code>notes</code>, <code>transcript</code> y <code>link</code>.</li>
                    <li>En <em>Headers</em>: <code>Authorization</code> = <code>Bearer</code> seguido de la clave de la API de entrada (la de los formularios).</li>
                    <li>Prueba el Zap: la nota aparecerá aquí.</li>
                  </ol>
                  {apiReady
                    ? <p className="callout good">La API de entrada está activa.</p>
                    : <p className="callout">Falta activar la API de entrada: define la variable <code>INBOUND_API_KEYS</code> en el servidor.</p>}
                  <p className="meta">La conexión de Granola con Zapier es de sus planes de pago. Sin ella, se pueden copiar las notas y usar «Pegar notas».</p>
                </>
              ) : (
                <p>Lo conecta tu administrador una vez para todo el equipo. Mientras tanto, copia las notas de Granola y usa «Pegar notas».</p>
              )}

              <h3>Cómo se asocian</h3>
              <ul className="plain-list meta">
                <li>A la reunión del calendario que ya está en el CRM (la misma reunión, o los mismos contactos a esa hora).</li>
                <li>Si no, al deal abierto de los asistentes; si no tienen, a su lead; si tampoco, a la ficha del contacto.</li>
                <li>Si un asistente no está en el CRM pero su empresa sí (por el dominio del correo), se da de alta en ella.</li>
                <li>Las reuniones solo con gente de tu equipo se descartan sin guardar su contenido.</li>
                <li>La reunión queda como realizada y la IA prepara el correo de resumen como borrador para que lo revises (salvo que lo tengas en automático en Ajustes → Automatizaciones), y apunta en el deal lo que se habló.</li>
              </ul>
            </div>
          </Drawer>
          {writer && (
            <Drawer label={<><Icon name="plus" />Pegar notas</>} title="Pegar notas de una reunión" defaultOpen={sp.pegar === "1"}
                    subtitle="Para notas copiadas de Granola u otra herramienta. Se asocian igual que las automáticas.">
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

      {done && sp.accion === "asociada" && done.status === "matched" && (
        <p className="callout good" role="status">
          <Icon name="check" /> «{done.title || "Reunión"}» guardada {done.deal_id ? <>en el deal <Link href={`/deals/${done.deal_id}`}>{done.deal_title}</Link></>
            : done.lead_id ? <>en el lead <Link href={`/leads/${done.lead_id}`}>{done.lead_title}</Link></> : "en la ficha del contacto"} como reunión realizada.
        </p>
      )}
      {done && sp.accion === "descartada" && done.status === "ignored" && (
        <div className="callout good row-between" role="status">
          <span><Icon name="check" /> «{done.title || "Reunión"}» descartada.</span>
          <ActionForm action={ignoreMeetingNoteAction.bind(null, done.id, false, view)} submitLabel="Deshacer" secondary className="form inline" />
        </div>
      )}
      {done && sp.accion === "recuperada" && done.status === "pending" && (
        <p className="callout good" role="status"><Icon name="check" /> «{done.title || "Reunión"}» vuelve a «Por asociar».</p>
      )}

      {missingScope.length > 0 && (
        <p className="callout">
          {missingScope.some((g) => g.user_id === me.id)
            ? <>No podemos leer las notas de Meet de tu cuenta de Google: falta un permiso. <Link href="/settings/mailbox">Vuelve a conectarla</Link>.</>
            : <>No podemos leer las notas de Meet de {missingScope.map((g) => g.email).join(", ")}: cada uno tiene que volver a conectar su cuenta de Google.</>}
        </p>
      )}

      <nav className="tabs" aria-label="Estado">
        {TABS.map((t) => (
          <Link key={t.key} href={`/reuniones?ver=${t.key}`} aria-current={view === t.key ? "page" : undefined}>
            {t.label}{counts[t.key] ? <span className={t.key === "pending" ? "count" : "count neutral"}>{counts[t.key]}</span> : null}
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
          {notes.map((n) => {
            const others = n.attendees.filter((a) => a.email !== n.organizer_email);
            const text = excerpt(n);
            return (
              <li key={n.id} className="panel">
                <strong>{n.title || "Reunión sin título"}</strong>
                <div className="meta">
                  {dateTime(n.started_at ?? n.created_at)} · {NOTE_SOURCES[n.source] ?? n.source}
                  {others.length ? ` · Con ${others.slice(0, 3).map((a) => a.name || a.email).join(", ")}${others.length > 3 ? ` y ${others.length - 3} más` : ""}` : ""}
                  {admin && n.owner_name && n.owner_id !== me.id ? ` · De ${n.owner_name}` : ""}
                  {n.transcript_len ? " · Con transcripción" : ""}
                </div>
                {text && <p className="meta clamp-2 note-meta">{text}</p>}
                {n.status === "matched" ? (
                  <p className="meta note-meta"><Icon name="check" /> <Where n={n} />{n.match_reason ? ` · ${n.match_reason}` : ""}</p>
                ) : n.match_reason ? <p className="meta note-meta">{n.match_reason}</p> : null}
                <div className="note-actions">
                  {writer && n.status === "pending" && (
                    <Drawer label="Asociar" buttonClass="btn" title="¿A qué va esta nota?" subtitle={n.title ?? undefined}>
                      <ActionForm action={assignMeetingNoteAction.bind(null, n.id, view)} submitLabel="Asociar">
                        <AssignNoteFields candidates={n.candidates} />
                      </ActionForm>
                    </Drawer>
                  )}
                  {writer && n.status === "matched" && (
                    <Drawer label="Cambiar" title="Mover la nota a otro sitio" subtitle={n.title ?? undefined}>
                      <ActionForm action={assignMeetingNoteAction.bind(null, n.id, view)} submitLabel="Mover">
                        <AssignNoteFields candidates={[]} move />
                      </ActionForm>
                    </Drawer>
                  )}
                  {writer && n.status === "pending" && (
                    <ActionForm action={ignoreMeetingNoteAction.bind(null, n.id, true, view)} secondary className="form inline" submitLabel="Descartar" />
                  )}
                  {writer && n.status === "ignored" && (n.summary || n.notes) && (
                    <ActionForm action={ignoreMeetingNoteAction.bind(null, n.id, false, view)} secondary className="form inline" submitLabel="Recuperar" />
                  )}
                  {n.link && <a className="btn secondary" href={n.link} target="_blank" rel="noreferrer">Ver original</a>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
