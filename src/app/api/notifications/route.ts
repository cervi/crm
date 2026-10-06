import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { listNotifications, markRead, unreadCount } from "@/lib/notifications";

export const dynamic = "force-dynamic";

export async function GET() {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  const [items, unread] = await Promise.all([listNotifications(me.id, 20), unreadCount(me.id)]);
  return NextResponse.json({ items, unread });
}

/** Marca como leído un aviso ({ id }) o todos. */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: "Inicia sesión." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  await markRead(me.id, typeof body?.id === "string" && /^[0-9a-f-]{36}$/i.test(body.id) ? body.id : undefined);
  return NextResponse.json({ unread: await unreadCount(me.id) });
}
