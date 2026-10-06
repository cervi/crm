import { personFromToken } from "@/lib/campaigns";
import { sql } from "@/lib/db";
import { Unsubscribe } from "./Unsubscribe";

export const dynamic = "force-dynamic";
export const metadata = { title: "Darse de baja", robots: { index: false } };

/** Baja de las comunicaciones (enlace al pie de los correos de campaña). Un clic en el botón y listo. */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const personId = personFromToken(token);
  const [p] = personId ? await sql<{ unsubscribed: boolean }[]>`SELECT unsubscribed_at IS NOT NULL AS unsubscribed FROM persons WHERE id = ${personId}` : [];
  return (
    <main className="proposal" style={{ maxWidth: 560 }}>
      <header><h1>Darse de baja</h1></header>
      {!p ? <p>Este enlace no es válido.</p>
        : p.unsubscribed ? <p role="status">Ya estás dado de baja: no volverás a recibir nuestros correos comerciales.</p>
        : <Unsubscribe token={token} />}
    </main>
  );
}
