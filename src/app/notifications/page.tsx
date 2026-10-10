import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { listNotifications, markRead } from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const metadata = { title: "Avisos" };

export default async function NotificationsPage() {
  const me = await requireUser();
  const items = await listNotifications(me.id, 200);
  // Al abrir la lista completa, todo queda leído.
  await markRead(me.id);
  return (
    <main className="page narrow">
      <div className="page-head"><h1>Avisos</h1></div>
      {items.length === 0 && <p className="muted">No tienes avisos. Aquí verás cuándo te mencionan en una nota, te asignan un deal o un cliente responde, reserva o acepta una propuesta.</p>}
      <ul className="items">
        {items.map((n) => (
          <li key={n.id} className={n.read_at ? "item" : "item unread"}>
            <div className="item-head">
              {n.link ? <Link href={n.link}><strong>{n.title}</strong></Link> : <strong>{n.title}</strong>}
              <span className="spacer" />
              <span className="meta">{n.actor_name ? `${n.actor_name} · ` : ""}{dateTime(n.created_at)}</span>
            </div>
            {n.body && <p className="note-body">{n.body}</p>}
          </li>
        ))}
      </ul>
    </main>
  );
}
