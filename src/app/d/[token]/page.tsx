import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { DocViewer } from "@/components/library/DocViewer";
import { clientInfo } from "@/lib/esign-request";
import { docByToken, recordDocView } from "@/lib/library";

export const dynamic = "force-dynamic";
export const metadata = { title: "Documento", robots: { index: false, follow: false } };

/** Documento compartido con enlace personal: se ve aquí (o se salta al enlace) y queda registrado. */
const TEXTS = {
  es: { gone: "Este documento ya no está disponible", goneText: "Pide a quien te lo envió que te lo comparta de nuevo.", by: "Compartido por", download: "Descargar", noPreview: "Este archivo no se puede ver en el navegador. Descárgalo para abrirlo." },
  en: { gone: "This document is no longer available", goneText: "Ask the person who sent it to share it again.", by: "Shared by", download: "Download", noPreview: "This file can’t be previewed in the browser. Download it to open it." },
  ca: { gone: "Aquest document ja no està disponible", goneText: "Demana a qui te l'ha enviat que te'l torni a compartir.", by: "Compartit per", download: "Descarregar", noPreview: "Aquest fitxer no es pot veure al navegador. Descarrega'l per obrir-lo." },
  pt: { gone: "Este documento já não está disponível", goneText: "Peça a quem o enviou que o partilhe de novo.", by: "Partilhado por", download: "Descarregar", noPreview: "Este ficheiro não pode ser visto no navegador. Descarregue-o para o abrir." },
  fr: { gone: "Ce document n’est plus disponible", goneText: "Demandez à l’expéditeur de le partager à nouveau.", by: "Partagé par", download: "Télécharger", noPreview: "Ce fichier ne peut pas être affiché dans le navigateur. Téléchargez-le pour l’ouvrir." },
  de: { gone: "Dieses Dokument ist nicht mehr verfügbar", goneText: "Bitten Sie den Absender, es erneut zu teilen.", by: "Geteilt von", download: "Herunterladen", noPreview: "Diese Datei kann im Browser nicht angezeigt werden. Laden Sie sie herunter." },
  it: { gone: "Questo documento non è più disponibile", goneText: "Chiedi a chi te l’ha inviato di condividerlo di nuovo.", by: "Condiviso da", download: "Scarica", noPreview: "Questo file non si può vedere nel browser. Scaricalo per aprirlo." },
};

export default async function SharedDocPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Idioma del navegador de quien lo abre.
  const al = ((await headers()).get("accept-language") ?? "es").toLowerCase();
  const lang = (Object.keys(TEXTS) as (keyof typeof TEXTS)[]).find((k) => al.startsWith(k)) ?? (Object.keys(TEXTS) as (keyof typeof TEXTS)[]).find((k) => al.includes(k)) ?? "es";
  const t = TEXTS[lang];
  const d = await docByToken(token);
  if (!d || d.disabled) {
    return (
      <main className="sign-public sign-msg" lang={lang}>
        <h1>{t.gone}</h1>
        <p className="muted">{t.goneText}{d?.senderEmail ? ` (${d.senderEmail})` : ""}</p>
      </main>
    );
  }
  if (d.kind === "link" && d.url) {
    const { ip, ua } = clientInfo(await headers());
    await recordDocView(token, ip, ua).catch(() => null);
    redirect(d.url);
  }
  return <main className="sign-public" lang={lang}><DocViewer token={token} name={d.name} mime={d.mime} sender={d.sender} t={t} /></main>;
}
