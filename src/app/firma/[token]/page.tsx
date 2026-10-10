import { signerView } from "@/lib/esign";
import { signDate, signTexts } from "@/lib/esign-i18n";
import { SignerApp } from "@/components/esign/SignerApp";

export const dynamic = "force-dynamic";
export const metadata = { title: "Firmar documento", robots: { index: false, follow: false } };

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ""));

/** Página pública donde cada firmante revisa y firma (enlace personal). */
export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const v = await signerView(token);
  if (!v) {
    return <main className="sign-public sign-msg"><h1>Este enlace no es válido</h1><p className="muted">Revisa que lo has copiado entero, o pide a quien te lo envió que te lo mande de nuevo.</p></main>;
  }
  const t = signTexts(v.request.language);
  const lang = v.request.language;
  const contact = v.senderEmail ? fill(t.contact, { email: v.senderEmail }) : null;
  const msg = (title: string, text: string, extra?: React.ReactNode) => (
    <main className="sign-public sign-msg" lang={lang}>
      <p className="meta">{v.request.title}</p>
      <h1>{title}</h1>
      <p className="muted">{text}</p>
      {extra}
      {contact && <p className="meta">{contact}</p>}
    </main>
  );
  if (v.state === "completed" || v.state === "signed") {
    return msg(t.doneTitle, v.state === "completed" ? t.doneAll : t.doneWaiting,
      v.state === "completed"
        ? <p><a className="btn" href={`/api/public/firma/${token}/pdf?v=signed&dl=1`}>{t.downloadSigned}</a></p>
        : v.me.signed_at ? <p className="meta">{fill(t.signedOn, { date: signDate(lang, v.me.signed_at, true) })}</p> : null);
  }
  if (v.state === "declined") return msg(t.declinedTitle, t.declinedText);
  if (v.state === "expired") return msg(t.expired, "");
  if (v.state === "cancelled") return msg(t.cancelled, "");
  if (v.state === "stopped") return msg(t.cancelled, t.declinedByOther);
  if (v.state === "waiting") return msg(t.notYourTurn, t.notYourTurnText);

  const owners = new Map(v.signers.map((s) => [s.id, s]));
  return (
    <main className="sign-public" lang={lang}>
      <SignerApp t={t} v={{
        token, title: v.request.title, pages: v.request.pages, requireCode: v.request.require_code, email: v.me.email, name: v.me.name,
        color: v.me.color, today: signDate(lang, new Date()), contact,
        fields: v.fields.map((f) => ({ id: f.id, type: f.type, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, required: f.required, hint: f.hint,
          mine: f.mine, value: f.value, owner: owners.get(f.signer_id)?.name ?? "", color: owners.get(f.signer_id)?.color ?? 1 })),
      }} />
    </main>
  );
}
