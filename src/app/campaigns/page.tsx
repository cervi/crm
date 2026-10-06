import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CAMPAIGN_STATUS, listCampaigns } from "@/lib/campaigns";
import { listSequences } from "@/lib/sequences";
import { listOutboundMailboxes, warmupLimit } from "@/lib/mailbox";
import { listPipelines } from "@/lib/pipelines";
import { listUsers } from "@/lib/users";
import { ActionForm } from "@/components/ActionForm";
import { CampaignFields } from "@/components/CampaignFields";
import { saveCampaignAction } from "@/app/actions/outbound";
import { money } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campañas de outbound" };

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)} %` : "—");

export default async function CampaignsPage() {
  await requireUser();
  const [campaigns, sequences, mailboxes, pipelines, users] = await Promise.all([
    listCampaigns(), listSequences(), listOutboundMailboxes(), listPipelines(), listUsers(),
  ]);
  return (
    <main className="page">
      <div className="page-head">
        <div>
          <h1>Campañas de outbound</h1>
          <p className="muted" style={{ margin: 0 }}>Listas de contactos (CSV, CRM, API o un agente), verificadas, con su primera línea personalizada y una secuencia desde vuestros buzones de outbound. Las respuestas se clasifican solas.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Campaña</th><th>Estado</th><th className="num">Contactos</th><th className="num">Enviados</th><th className="num">Abiertos</th>
            <th className="num">Respuestas</th><th className="num">Interesados</th><th className="num">Reuniones</th><th className="num">Deals</th><th className="num">Ganado</th></tr></thead>
          <tbody>
            {campaigns.length === 0 && <tr><td colSpan={10} className="empty-row">Todavía no hay campañas.</td></tr>}
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td><Link href={`/campaigns/${c.id}`}><strong>{c.name}</strong></Link>{c.sequence_name && <div className="meta">{c.sequence_name}</div>}</td>
                <td><span className={`badge ${c.status === "active" ? "won" : ""}`}>{CAMPAIGN_STATUS[c.status]}</span>
                  {c.stats.ready > 0 && <div className="meta">{c.stats.ready} para aprobar</div>}</td>
                <td className="num">{c.stats.contacts}</td>
                <td className="num">{c.stats.sent}</td>
                <td className="num">{pct(c.stats.opened, c.stats.sent)}</td>
                <td className="num">{c.stats.replied} <span className="meta">({pct(c.stats.replied, c.stats.enrolled + c.stats.replied)})</span></td>
                <td className="num">{c.stats.interested}</td>
                <td className="num">{c.stats.meetings}</td>
                <td className="num">{c.stats.deals}</td>
                <td className="num">{c.stats.won ? money(c.stats.won_value) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="panel" style={{ marginTop: 18 }}>
        <h2>Nueva campaña</h2>
        <ActionForm action={saveCampaignAction.bind(null, null)} submitLabel="Crear campaña">
          <CampaignFields sequences={sequences.filter((s) => s.is_active && s.steps > 0)}
                          mailboxes={mailboxes.map((m) => ({ id: m.id, email: m.email, paused: m.paused, limit: warmupLimit(m) }))}
                          pipelines={pipelines} users={users.filter((u) => u.kind === "human")} />
        </ActionForm>
      </section>
    </main>
  );
}
