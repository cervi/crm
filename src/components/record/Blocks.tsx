import Link from "next/link";
import { ConfirmButton } from "../ConfirmButton";
import { ActionForm } from "@/components/ActionForm";
import { Avatar } from "@/components/Avatar";
import { Icon } from "@/components/Icon";
import { FileDrop } from "./FileDrop";
import {
  addFollowerAction, deleteFileAction, followAction, logCallAction, quickCompleteAction, removeFollowerAction, setTagsAction,
} from "@/app/actions/contact";

import { createActivityAction, createNoteAction } from "@/app/actions/records";
import { activeActivityTypes } from "@/lib/activity-types";
import { CALL_OUTCOMES, type Overview, type Tag, type TagEntity } from "@/lib/contact-workspace";
import { fileSize, type StoredFile } from "@/lib/files";
import type { Follower, FollowEntity } from "@/lib/followers";
import type { Activity } from "@/lib/activities";
import type { Note } from "@/lib/notes";
import type { EmailRow } from "@/lib/emails";
import { activityLabel, date, dateTime, money } from "@/lib/format";

// Piezas de las fichas de contacto, empresa y deal (al estilo de Pipedrive).

type Refs = Record<string, string>;
const hidden = (refs: Refs) => Object.entries(refs).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);

/** Seguidores: seguir/dejar de seguir y añadir a alguien del equipo. */
export function FollowersBlock({ type, id, followers, me, users, back }: {
  type: FollowEntity; id: string; followers: Follower[]; me: string; users: { id: string; name: string }[]; back: string;
}) {
  const following = followers.some((f) => f.user_id === me);
  const others = users.filter((u) => !followers.some((f) => f.user_id === u.id));
  return (
    <section className="side-section" aria-label="Seguidores">
      <div className="side-head">
        <h3 title="Quien sigue recibe avisos de lo importante: respuestas, cambios, notas, archivos…">Seguidores <span className="muted">{followers.length}</span></h3>
        <form action={followAction.bind(null, type, id, !following, back)}>
          <button type="submit" className="btn secondary small">{following ? "Dejar de seguir" : "Seguir"}</button>
        </form>
      </div>
      {followers.length > 0 && (
        <ul className="follower-list">
          {followers.map((f) => (
            <li key={f.user_id}>
              <Avatar name={f.name} size="sm" /> {f.name}
              {f.user_id !== me && (
                <form action={removeFollowerAction.bind(null, type, id, f.user_id, back)}>
                  <button type="submit" className="link-btn meta" aria-label={`Quitar a ${f.name} de seguidores`}>Quitar</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <details>
          <summary className="meta">+ Añadir seguidor</summary>
          <ActionForm action={addFollowerAction.bind(null, type, id, back)} submitLabel="Añadir" secondary className="form inline">
            <select name="user_id" aria-label="Seguidor">{others.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          </ActionForm>
        </details>
      )}
    </section>
  );
}

/** Etiquetas de colores con edición rápida. */
export function TagsBlock({ entity, id, tags, all, back }: { entity: TagEntity; id: string; tags: Tag[]; all: Tag[]; back: string }) {
  const listId = `tags-${entity}-${id}`;
  return (
    <div className="tags-block" aria-label="Etiquetas">
      {tags.map((t) => <span key={t.id} className={`tag tag-${t.color}`}>{t.name}</span>)}
      <details className="tags-edit">
        <summary className="meta">{tags.length ? "Editar etiquetas" : "+ Etiqueta"}</summary>
        <ActionForm action={setTagsAction.bind(null, entity, id, back)} submitLabel="Guardar" secondary className="form inline">
          <label className="field"><span className="label">Etiquetas (separadas por comas)</span><input name="tags" list={listId} defaultValue={tags.map((t) => t.name).join(", ")} placeholder="cliente vip, evento 2026" style={{ minWidth: 240 }} /></label>
          <datalist id={listId}>{all.map((t) => <option key={t.id} value={t.name} />)}</datalist>
          <label className="field"><span className="label">Color para etiquetas nuevas</span><select name="color" defaultValue="blue">
            {[["blue", "Azul"], ["green", "Verde"], ["orange", "Naranja"], ["red", "Rojo"], ["purple", "Morado"], ["gray", "Gris"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        </ActionForm>
      </details>
    </div>
  );
}

/** Formulario de «Registrar llamada». */
export function CallForm({ refs, back, phone }: { refs: Refs; back: string; phone?: string | null }) {
  return (
    <ActionForm action={logCallAction.bind(null, back)} submitLabel="Registrar llamada" resetOnSuccess>
      {hidden(refs)}
      {phone && <p className="meta" style={{ margin: 0 }}><a href={`tel:${phone.replace(/[^\d+]/g, "")}`}><Icon name="send" /> Llamar al {phone}</a> y luego apunta cómo fue.</p>}
      <div className="field"><span className="label">¿Cómo fue?</span>
        <div className="outcome-picks">
          {CALL_OUTCOMES.map((o, i) => (
            <label key={o.value} className="pick"><input type="radio" name="outcome" value={o.value} defaultChecked={i === 0} />{o.label}</label>
          ))}
        </div>
      </div>
      <div className="grid-2">
        <label className="field"><span className="label">Duración (min)</span><input name="minutes" type="number" min={0} max={600} placeholder="5" /></label>
        <label className="field"><span className="label">Siguiente llamada</span>
          <select name="follow_up_days" defaultValue="">
            <option value="">No programar</option><option value="1">Mañana</option><option value="2">En 2 días</option>
            <option value="7">En una semana</option><option value="14">En dos semanas</option><option value="30">En un mes</option>
          </select>
        </label>
      </div>
      <label className="field"><span className="label">Notas de la llamada</span><textarea name="note" rows={3} placeholder="Qué se habló, próximos pasos…" /></label>
    </ActionForm>
  );
}

/** Pestaña de archivos: subir y lista. */
export function FilesPanel({ refs, files, back }: { refs: Refs; files: StoredFile[]; back: string }) {
  return (
    <div className="stack" style={{ gap: 10 }}>
      <FileDrop refs={refs} />
      {files.length > 0 && <FilesList files={files} back={back} />}
    </div>
  );
}

export function FilesList({ files, back, showDeal }: { files: StoredFile[]; back: string; showDeal?: boolean }) {
  return (
    <ul className="file-list" aria-label="Archivos">
      {files.map((f) => (
        <li key={f.id}>
          <a href={`/api/files/${f.id}`} className="file-name"><Icon name="download" />{f.name}</a>
          {/^(image\/|application\/pdf)/.test(f.mime) && <a className="meta" href={`/api/files/${f.id}?ver=1`} target="_blank" rel="noreferrer">ver</a>}
          <span className="meta">{fileSize(f.size)} · {date(f.created_at)}{f.uploader ? ` · ${f.uploader}` : ""}{showDeal && f.deal_title ? ` · ${f.deal_title}` : ""}</span>
          <form action={deleteFileAction.bind(null, f.id, back)}><ConfirmButton label="Borrar" className="link-btn meta" ariaLabel={`Borrar ${f.name}`} confirm="El archivo se borra del todo, no va a la papelera." /></form>
        </li>
      ))}
    </ul>
  );
}

/** Resumen de la relación (el «Overview» de Pipedrive). */
export function OverviewBlock({ o }: { o: Overview }) {
  const since = (d: Date | null) => {
    if (!d) return "nunca";
    const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
    return days <= 0 ? "hoy" : days === 1 ? "ayer" : `hace ${days} días`;
  };
  return (
    <section className="side-section" aria-label="Resumen de la relación">
      <h3>Resumen</h3>
      <dl className="overview">
        <div><dt>Último contacto</dt><dd className={o.last_contact && Date.now() - new Date(o.last_contact).getTime() > 30 * 86400000 ? "tone-bad" : undefined}>{since(o.last_contact)}</dd></div>
        <div><dt>Próxima actividad</dt><dd>{o.next_activity ? dateTime(o.next_activity) : <span className="tone-bad">sin programar</span>}</dd></div>
        <div><dt>Actividades</dt><dd>{o.activities_done} hechas · {o.activities_open} pendientes</dd></div>
        <div><dt>Llamadas</dt><dd>{o.calls}</dd></div>
        <div><dt>Correos</dt><dd>{o.emails_out} enviados · {o.emails_in} recibidos</dd></div>
        <div><dt>Deals</dt><dd>{o.open_deals} abiertos · {o.won_deals} ganados{o.won_value ? ` (${money(o.won_value)})` : ""}</dd></div>
        {o.first_seen && <div><dt>En el CRM desde</dt><dd>{date(o.first_seen)}</dd></div>}
      </dl>
    </section>
  );
}

/** Enfoque: lo pendiente (actividades, correos programados y notas fijadas). */
export function FocusBlock({ activities, scheduled, pinned, back }: { activities: Activity[]; scheduled: EmailRow[]; pinned: Note[]; back: string }) {
  const pending = activities.filter((a) => !a.done);
  if (!pending.length && !scheduled.length && !pinned.length) {
    return <section aria-label="Enfoque"><h2 className="section-title">Enfoque</h2><p className="muted">No hay nada pendiente. Programa la siguiente actividad para no perder el hilo.</p></section>;
  }
  return (
    <section aria-label="Enfoque">
      <h2 className="section-title">Enfoque <span className="muted">{pending.length + scheduled.length + pinned.length}</span></h2>
      <ul className="focus-list">
        {pinned.map((n) => (
          <li key={n.id} className="focus-item pinned"><span className="badge">Nota fijada</span><p className="note-body">{n.content}</p></li>
        ))}
        {pending.map((a) => (
          <li key={a.id} className={`focus-item${a.is_overdue ? " overdue" : ""}`}>
            <form action={quickCompleteAction.bind(null, a.id, back)}><button type="submit" className="check-btn" aria-label={`Completar «${a.subject}»`} title="Marcar como hecha"><Icon name="check" /></button></form>
            <div>
              <strong>{activityLabel(a.type)}: {a.subject}</strong>
              <div className="meta">{a.due_at ? dateTime(a.due_at) : "sin fecha"}{a.is_overdue ? " · vencida" : ""}{a.owner_name ? ` · ${a.owner_name}` : ""}{a.deal_title ? ` · ${a.deal_title}` : ""}</div>
            </div>
          </li>
        ))}
        {scheduled.map((m) => (
          <li key={m.id} className="focus-item"><span className="badge">Correo programado</span><Link href={`/emails/${m.id}`}>{m.subject}</Link><span className="meta"> · {dateTime(m.scheduled_at)}</span></li>
        ))}
      </ul>
    </section>
  );
}

/** Nota rápida (con @menciones). */
export function NoteForm({ refs, back }: { refs: Refs; back: string }) {
  return (
    <ActionForm action={createNoteAction.bind(null, back)} submitLabel="Guardar nota" resetOnSuccess>
      {hidden(refs)}
      <textarea name="content" rows={3} required placeholder="Escribe una nota… (con @Nombre avisas a alguien del equipo)" aria-label="Nota" />
    </ActionForm>
  );
}

/** Programar una actividad. */
export async function ActivityForm({ refs, back, users, me, defaultType = "call" }: {
  refs: Refs; back: string; users: { id: string; name: string }[]; me: string; defaultType?: string;
}) {
  const types = await activeActivityTypes();
  return (
    <ActionForm action={createActivityAction.bind(null, back)} submitLabel="Programar" resetOnSuccess>
      {hidden(refs)}
      <div className="grid-2">
        <label className="field"><span className="label">Tipo</span>
          <select name="type" defaultValue={types.some((t) => t.key === defaultType) ? defaultType : types[0]?.key}>
            {types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label className="field"><span className="label">Asunto *</span><input name="subject" required aria-label="Asunto de la actividad" /></label>
        <label className="field"><span className="label">Fecha y hora</span><input type="datetime-local" name="due_at" /></label>
        <label className="field"><span className="label">Duración (min)</span><input type="number" name="duration_minutes" min={5} max={480} placeholder="30" /></label>
        <label className="field"><span className="label">Responsable</span>
          <select name="owner_id" defaultValue={me}>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        </label>
        <label className="field"><span className="label">Enlace de la reunión</span><input name="meeting_url" /></label>
        <label className="field span-2"><span className="label">Notas</span><textarea name="note" rows={2} /></label>
      </div>
    </ActionForm>
  );
}
