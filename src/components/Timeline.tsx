import { eventLabel, type TimelineEvent } from "@/lib/events";
import { dateTime } from "@/lib/format";

const ACTOR: Record<string, string> = { user: "Usuario", ai_agent: "IA", system: "Sistema", integration: "Integración" };

function detail(e: TimelineEvent): string | null {
  const p = e.payload as Record<string, unknown>;
  switch (e.event_type) {
    case "deal.stage_changed": return p.from_stage && p.to_stage ? `${p.from_stage} → ${p.to_stage}` : null;
    case "deal.lost": return [p.reason, p.note].filter(Boolean).join(" · ") +
      (p.follow_up_days ? ` · seguimiento en ${p.follow_up_days} días` : "");
    case "lead.form_submitted": return [p.source, p.source_detail].filter(Boolean).join(" · ");
    case "lead.created": return [p.source, p.source_detail].filter(Boolean).join(" · ");
    case "activity.created":
    case "activity.completed": return [p.subject, p.outcome === "no_show" ? "no se presentó" : null].filter(Boolean).join(" · ");
    case "note.created": return typeof p.excerpt === "string" ? p.excerpt : null;
    default: return null;
  }
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  if (events.length === 0) return <p className="muted">Sin actividad todavía.</p>;
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id}>
          <div><strong>{eventLabel(e.event_type)}</strong>{detail(e) && <span className="muted"> — {detail(e)}</span>}</div>
          <div className="meta">{dateTime(e.occurred_at)} · {e.actor_name ?? ACTOR[e.actor_type]}</div>
        </li>
      ))}
    </ol>
  );
}
