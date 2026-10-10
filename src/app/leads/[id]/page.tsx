import Link from "next/link";
import { trashAction } from "@/app/actions/trash";
import { ScoreBadge, ScoreReasons } from "@/components/ScoreBadge";
import { FitBadge } from "@/components/FitBadge";
import { recomputeScores } from "@/lib/scoring";
import { notFound } from "next/navigation";
import { getLead } from "@/lib/leads";
import { listPipelines } from "@/lib/pipelines";
import { listActivitiesFor } from "@/lib/activities";
import { listNotesFor } from "@/lib/notes";
import { timeline } from "@/lib/events";
import { listUsers } from "@/lib/users";
import { sql } from "@/lib/db";
import { dateTime, FUNNEL_STAGES, STATUS_LABELS } from "@/lib/format";
import { isId } from "@/lib/validation";
import { archiveLeadAction, convertLeadAction, updateLeadAction } from "@/app/actions/deals";
import { ActionForm } from "@/components/ActionForm";
import { ActivityPanel } from "@/components/ActivityPanel";
import { NotePanel } from "@/components/NotePanel";
import { OwnerSelect } from "@/components/forms";
import { Timeline } from "@/components/Timeline";

export const dynamic = "force-dynamic";
export const metadata = { title: "Lead" };

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id)) notFound();
  let lead = await getLead(id);
  if (!lead) notFound();
  // Aún sin puntuar (recién llegado): se calcula ahora.
  if (lead.score === null) {
    await recomputeScores(id).catch(() => 0);
    lead = (await getLead(id)) ?? lead;
  }

  const [pipelines, activities, notes, users, events] = await Promise.all([
    listPipelines(), listActivitiesFor({ leadId: id }), listNotesFor({ leadId: id }), listUsers(),
    timeline(sql, [{ type: "lead", id }], 40),
  ]);
  const back = `/leads/${id}`;
  const [org] = lead.organization_id
    ? await sql<{ industry: string | null; employee_count: number | null; country: string | null; city: string | null; description: string | null }[]>`
        SELECT industry, employee_count, country, city, description FROM organizations WHERE id = ${lead.organization_id}`
    : [];
  const inbound = pipelines.find((p) => p.name.toLowerCase() === "inbound") ?? pipelines[0];

  return (
    <main className="page">
      <div className="crumbs"><Link href="/leads">Leads</Link></div>
      <div className="page-head">
        <h1>{lead.person_name ?? lead.title}</h1>
        <span className={`badge ${lead.status}`}>{STATUS_LABELS[lead.status]}</span>
        {lead.funnel_stage && <span className={`badge ${lead.funnel_stage}`}>{lead.funnel_stage.toUpperCase()}</span>}
        <ScoreBadge score={lead.score} reasons={lead.score_reasons} />
        <span className="spacer" />
        {lead.status === "open" && (
          <ActionForm action={archiveLeadAction.bind(null, id)} submitLabel="Archivar" secondary className="form inline" />
        )}
        <ActionForm action={trashAction.bind(null, "lead", id)} submitLabel="Borrar lead" pendingLabel="…" secondary className="form inline"
          confirm="El lead irá a la papelera; desde allí se puede recuperar durante un tiempo." />
      </div>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <h2>Datos</h2>
            <dl className="dl">
              <div className="dl-row"><dt>Contacto</dt><dd>{lead.person_id ? <Link href={`/persons/${lead.person_id}`}>{lead.person_name}</Link> : "—"}</dd></div>
              <div className="dl-row"><dt>Email</dt><dd>{lead.email ?? "—"}</dd></div>
              <div className="dl-row"><dt>Empresa</dt><dd>{lead.organization_id ? <Link href={`/organizations/${lead.organization_id}`}>{lead.organization_name}</Link> : "—"}</dd></div>
              <div className="dl-row"><dt>Origen</dt><dd>{lead.source ?? "—"}</dd></div>
              <div className="dl-row"><dt>Detalle</dt><dd>{lead.source_detail ?? "—"}</dd></div>
              <div className="dl-row"><dt>Etiquetas</dt><dd>{lead.tags.length ? lead.tags.join(", ") : "—"}</dd></div>
              <div className="dl-row"><dt>Responsable</dt><dd>{lead.owner_name ?? "—"}</dd></div>
              <div className="dl-row"><dt>Alta</dt><dd>{dateTime(lead.created_at)}</dd></div>
              {lead.converted_deal_id && (
                <div className="dl-row"><dt>Deal</dt><dd><Link href={`/deals/${lead.converted_deal_id}`}>{lead.deal_title}</Link> · {dateTime(lead.converted_at)}</dd></div>
              )}
            </dl>
          </section>

          <section className="panel" aria-label="Encaje">
            <h2>Encaje con vuestro perfil <FitBadge fit={lead.fit} reason={lead.fit_reason} /></h2>
            <p className="muted" style={{ margin: 0 }}>{lead.fit_reason ?? "Todavía sin cualificar: el agente de captación lo hace en la próxima revisión."}</p>
            {lead.fit === "unknown" && lead.fit_reason?.startsWith("Sin perfil") && <p className="meta"><Link href="/settings/icp">Definir el perfil de cliente ideal</Link></p>}
            {org && (org.industry || org.employee_count || org.country || org.description) && (
              <dl className="dl compact" style={{ marginTop: 10 }}>
                {org.description && <div className="dl-row"><dt>A qué se dedica</dt><dd>{org.description}</dd></div>}
                {org.industry && <div className="dl-row"><dt>Sector</dt><dd>{org.industry}</dd></div>}
                {org.employee_count && <div className="dl-row"><dt>Empleados</dt><dd>{org.employee_count}</dd></div>}
                {org.country && <div className="dl-row"><dt>País</dt><dd>{[org.city, org.country].filter(Boolean).join(", ")}</dd></div>}
              </dl>
            )}
            {Object.keys(lead.utm ?? {}).length > 0 && (
              <p className="meta">Atribución: {Object.entries(lead.utm).map(([k, v]) => `${({ source: "fuente", medium: "medio", campaign: "campaña", term: "término", content: "contenido" } as Record<string, string>)[k] ?? k}: ${v}`).join(" · ")}</p>
            )}
          </section>

          <section className="panel" aria-label="Puntuación">
            <h2>Puntuación {lead.score !== null && <span className="muted">{lead.score} / 100</span>}</h2>
            <ScoreReasons reasons={lead.score_reasons} />
          </section>

          {lead.status === "open" && (
            <section className="panel">
              <h2>Convertir en deal</h2>
              <ActionForm action={convertLeadAction.bind(null, id)} submitLabel="Crear deal">
                <div className="grid-2">
                  <label className="field span-2"><span className="label">Título *</span>
                    <input name="title" required defaultValue={`${lead.organization_name ?? lead.person_name ?? "Nuevo deal"} — ${lead.source_detail ?? lead.source ?? ""}`.replace(/ — $/, "")} /></label>
                  <label className="field"><span className="label">Pipeline</span>
                    <select name="pipeline_id" defaultValue={inbound?.id}>
                      {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </label>
                  <label className="field"><span className="label">Importe</span><input type="number" name="value" min={0} step="0.01" /></label>
                  <OwnerSelect users={users} value={lead.owner_id} />
                </div>
              </ActionForm>
            </section>
          )}

          <section className="panel">
            <h2>Etapa y responsable</h2>
            <ActionForm action={updateLeadAction.bind(null, id)} submitLabel="Guardar" secondary className="form inline">
              <label className="field"><span className="label">Etapa</span>
                <select name="funnel_stage" defaultValue={lead.funnel_stage ?? ""}>
                  <option value="">—</option>
                  {FUNNEL_STAGES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </label>
              <OwnerSelect users={users} value={lead.owner_id} />
              {lead.status === "archived" && <label className="checkbox"><input type="checkbox" name="unarchive" /> Reabrir</label>}
            </ActionForm>
          </section>

          <section className="panel"><h2>Historial</h2><Timeline events={events} /></section>
        </div>
        <div className="stack">
          <ActivityPanel activities={activities} refs={{ lead_id: id, person_id: lead.person_id ?? undefined }} back={back} users={users} />
          <NotePanel notes={notes} refs={{ lead_id: id }} back={back} />
        </div>
      </div>
    </main>
  );
}
