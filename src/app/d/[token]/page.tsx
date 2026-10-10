import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DocViewer } from "@/components/library/DocViewer";
import { clientInfo } from "@/lib/esign-request";
import { docByToken, recordDocView } from "@/lib/library";

export const dynamic = "force-dynamic";
export const metadata = { title: "Documento", robots: { index: false, follow: false } };

/** Documento compartido con enlace personal: se ve aquí (o se salta al enlace) y queda registrado. */
export default async function SharedDocPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const d = await docByToken(token);
  if (!d || d.disabled) {
    return (
      <main className="sign-public sign-msg">
        <h1>Este documento ya no está disponible</h1>
        <p className="muted">Pide a quien te lo envió que te lo comparta de nuevo.{d?.senderEmail ? ` (${d.senderEmail})` : ""}</p>
      </main>
    );
  }
  if (d.kind === "link" && d.url) {
    const { ip, ua } = clientInfo(await headers());
    await recordDocView(token, ip, ua).catch(() => null);
    redirect(d.url);
  }
  return <main className="sign-public"><DocViewer token={token} name={d.name} mime={d.mime} sender={d.sender} /></main>;
}
