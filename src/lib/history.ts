import { activityLabel, dateTime, outcomeLabel } from "./format";
import { eventLabel, type TimelineEvent } from "./events";
import { callOutcomeLabel } from "./contact-workspace";
import { fileSize, type StoredFile } from "./files";
import type { Activity } from "./activities";
import type { Note } from "./notes";
import type { EmailRow } from "./emails";

// Historia de una ficha (contacto, empresa o deal) en un solo hilo, con su
// tipo para poder filtrar: notas, actividades, llamadas, correos, archivos y
// cambios (el «changelog» de Pipedrive).

export type HistoryKind = "note" | "activity" | "call" | "email" | "file" | "change";
export type HistoryItem = {
  id: string; kind: HistoryKind; at: string; title: string; body?: string | null; meta?: string | null;
  tone?: "good" | "bad" | null; href?: string | null; pinned?: boolean; noteId?: string;
};

const actorName = (e: TimelineEvent) => e.actor_name ?? (e.actor_type === "ai_agent" ? "IA" : e.actor_type === "integration" ? "Integración" : "Sistema");

/** Eventos que ya salen por su cuenta (nota, actividad, correo, archivo, llamada): no se repiten como cambio. */
const COVERED = /^(activity\.|note\.created|email\.(received|scheduled|opened|clicked)|file\.|call\.logged)/;

export function buildHistory(src: { notes?: Note[]; activities?: Activity[]; emails?: EmailRow[]; files?: StoredFile[]; events?: TimelineEvent[];
                                    showDeal?: boolean }): HistoryItem[] {
  const deal = (title: string | null | undefined) => (src.showDeal && title ? ` · ${title}` : "");
  const items: HistoryItem[] = [
    ...(src.notes ?? []).map((n) => ({
      id: `n${n.id}`, kind: "note" as const, at: new Date(n.created_at).toISOString(), title: n.is_pinned ? "Nota fijada" : "Nota",
      body: n.content, meta: `${dateTime(n.created_at)}${n.author_name ? ` · ${n.author_name}` : ""}${deal(n.deal_title)}`,
      pinned: n.is_pinned, noteId: n.id,
    })),
    ...(src.activities ?? []).filter((a) => a.done).map((a) => {
      const call = a.type === "call";
      return {
        id: `a${a.id}`, kind: call ? "call" as const : "activity" as const, at: new Date(a.done_at ?? a.due_at ?? 0).toISOString(),
        title: `${activityLabel(a.type)}: ${a.subject}${a.outcome ? ` — ${outcomeLabel(a.outcome).toLowerCase()}` : ""}`,
        body: a.note, tone: a.outcome === "no_show" || (call && a.call_outcome && a.call_outcome !== "answered") ? "bad" as const : null,
        meta: [dateTime(a.done_at), a.owner_name, a.duration_minutes ? `${a.duration_minutes} min` : null,
               call ? callOutcomeLabel(a.call_outcome) : null].filter(Boolean).join(" · ") + deal(a.deal_title),
      };
    }),
    ...(src.emails ?? []).filter((m) => m.status === "sent" || m.status === "scheduled").map((m) => ({
      id: `m${m.id}`, kind: "email" as const, at: new Date(m.at).toISOString(),
      title: `${m.direction === "in" ? "Correo recibido" : m.status === "scheduled" ? "Correo programado" : "Correo enviado"}: ${m.subject || "(sin asunto)"}`,
      body: m.body.length > 600 ? `${m.body.slice(0, 600)}…` : m.body,
      meta: [dateTime(m.at), m.direction === "in" ? m.from_email : `para ${m.to_name ?? m.to_email ?? ""}`,
             m.direction === "out" && m.open_count ? `abierto ${m.open_count} ${m.open_count === 1 ? "vez" : "veces"}` : null,
             m.direction === "out" && m.click_count ? `${m.click_count} clic${m.click_count === 1 ? "" : "s"}` : null].filter(Boolean).join(" · "),
      href: `/emails/${m.id}`,
    })),
    ...(src.files ?? []).map((f) => ({
      id: `f${f.id}`, kind: "file" as const, at: new Date(f.created_at).toISOString(), title: `Archivo: ${f.name}`,
      meta: [dateTime(f.created_at), f.uploader, fileSize(f.size)].filter(Boolean).join(" · ") + deal(f.deal_title), href: `/api/files/${f.id}`,
    })),
    ...(src.events ?? []).filter((e) => !COVERED.test(e.event_type)).map((e) => {
      const p = e.payload as Record<string, unknown>;
      const detail = e.event_type.endsWith("tags_changed") ? (Array.isArray(p.tags) && p.tags.length ? (p.tags as string[]).join(", ") : "sin etiquetas")
        : e.event_type === "person.changed_company" ? String(p.organization ?? "")
        : e.event_type.startsWith("sequence.") ? [p.sequence, p.reason].filter(Boolean).join(" · ")
        : e.event_type === "deal.lost" ? [p.reason, p.note].filter(Boolean).join(" · ")
        : e.event_type === "deal.stage_changed" && p.from_stage ? `${p.from_stage} → ${p.to_stage}`
        : e.event_type.startsWith("deal.document_") ? String(p.title ?? "")
        : e.event_type.endsWith("owner_changed") && (p.from_name || p.to_name) ? `${p.from_name ?? "sin responsable"} → ${p.to_name ?? "sin responsable"}`
        : null;
      return {
        id: `e${e.id}`, kind: "change" as const, at: new Date(e.occurred_at).toISOString(), title: eventLabel(e.event_type),
        body: detail || null, meta: `${dateTime(e.occurred_at)} · ${actorName(e)}`,
        tone: e.event_type === "deal.won" ? "good" as const : e.event_type === "deal.lost" ? "bad" as const : null,
      };
    }),
  ];
  return items.sort((a, b) => b.at.localeCompare(a.at));
}
