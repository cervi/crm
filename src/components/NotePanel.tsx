import Link from "next/link";
import { ActionForm } from "./ActionForm";
import { createNoteAction } from "@/app/actions/records";
import type { Note } from "@/lib/notes";
import { dateTime } from "@/lib/format";

type Ref = { deal_id?: string; lead_id?: string; person_id?: string; organization_id?: string };

export function NotePanel({ notes, refs, back }: { notes: Note[]; refs: Ref; back: string }) {
  return (
    <section className="panel stack">
      <h2>Notas</h2>
      <ActionForm action={createNoteAction.bind(null, back)} submitLabel="Añadir nota" secondary resetOnSuccess>
        {Object.entries(refs).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
        <textarea name="content" rows={3} required placeholder="Escribe una nota…" aria-label="Nota" />
      </ActionForm>
      {notes.length === 0 && <p className="muted" style={{ margin: 0 }}>Sin notas todavía.</p>}
      <ul className="items">
        {notes.map((n) => (
          <li key={n.id} className="item">
            <p className="note-body">{n.content}</p>
            <div className="meta">
              {dateTime(n.created_at)}{n.author_name && ` · ${n.author_name}`}
              {n.deal_id && !refs.deal_id && <> · <Link href={`/deals/${n.deal_id}`}>{n.deal_title}</Link></>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
