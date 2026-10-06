import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { availableSlots, senderFor } from "@/lib/mailbox";
import { formatSlots } from "@/lib/slots";
import { isId } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Próximos huecos libres del calendario de un usuario (?user=) o del responsable del deal (?deal=); si no tiene, de la primera cuenta conectada. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const dealId = q.get("deal"), userId = q.get("user");
  const [deal] = isId(dealId) ? await sql<{ owner_id: string | null }[]>`SELECT owner_id FROM deals WHERE id = ${dealId}` : [];
  const conn = await senderFor(isId(userId) ? userId : deal?.owner_id);
  if (!conn) return NextResponse.json({ error: "Conecta tu calendario en Ajustes → Correo, calendario y documentos." }, { status: 409 });
  const duration = Number(q.get("duration"));
  try {
    const slots = await availableSlots(conn, Number.isFinite(duration) && duration > 0 ? { duration } : {});
    return NextResponse.json({
      calendar: conn.email,
      slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
      text: formatSlots(slots, conn.scheduling.timezone),
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "No se pudo leer el calendario." }, { status: 502 });
  }
}
