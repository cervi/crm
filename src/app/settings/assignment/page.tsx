import Link from "next/link";
import { deleteAssignmentRuleAction, saveAssignmentRuleAction, setAssignmentEnabledAction } from "@/app/actions/assignment";
import { ActionForm } from "@/components/ActionForm";
import { assignmentSettings, FIELD_LABELS, listAssignmentRules, type AssignmentRule } from "@/lib/assignment";
import { requireAdminPage } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { listUsers } from "@/lib/users";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reparto de leads y deals" };

const ENTITY: Record<AssignmentRule["entity"], string> = { both: "Leads y deals", lead: "Solo leads", deal: "Solo deals" };

function RuleFields({ rule, users }: { rule?: AssignmentRule; users: { id: string; name: string }[] }) {
  return (
    <>
      <div className="grid-3">
        <label className="field"><span className="label">Se aplica a</span>
          <select name="entity" defaultValue={rule?.entity ?? "both"}>
            {Object.entries(ENTITY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        <label className="field"><span className="label">Cuando</span>
          <select name="field" defaultValue={rule?.field ?? "any"}>
            {Object.entries(FIELD_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        <label className="field"><span className="label">Valor</span>
          <input name="value" defaultValue={rule?.value ?? ""} placeholder="webinar, BOFU, 70, 10000, España…" /></label>
      </div>
      <fieldset className="fieldset">
        <legend>Repartir por turnos entre</legend>
        <div className="check-grid">
          {users.map((u) => (
            <label key={u.id} className="checkbox"><input type="checkbox" name="user_ids" value={u.id} defaultChecked={rule?.user_ids.includes(u.id)} />{u.name}</label>
          ))}
        </div>
      </fieldset>
    </>
  );
}

export default async function AssignmentPage() {
  await requireAdminPage();
  const [settings, rules, users] = await Promise.all([assignmentSettings(), listAssignmentRules(), listUsers()]);
  const humans = users.filter((u) => u.kind === "human");
  return (
    <main className="page" style={{ maxWidth: 900 }}>
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Reparto de leads y deals</h1>
          <p className="muted" style={{ margin: 0 }}>
            Los leads y deals que llegan sin responsable (formularios, enlace de reserva, importaciones) se asignan solos con la primera regla que
            cumplan, por turnos entre las personas elegidas. La puntuación de los leads (0–100) se calcula con su encaje e interés y se puede usar aquí.
          </p>
        </div>
      </div>

      <section className="panel">
        <h2>Reparto automático: {settings.assignment_enabled ? "activado" : "desactivado"}</h2>
        {settings.assignment_enabled && settings.assignment_since && (
          <p className="meta">Se reparte lo que llega desde el {dateTime(settings.assignment_since)}.</p>
        )}
        <form action={setAssignmentEnabledAction.bind(null, !settings.assignment_enabled)}>
          <button type="submit" className={settings.assignment_enabled ? "btn secondary" : "btn"}>
            {settings.assignment_enabled ? "Desactivar" : "Activar el reparto"}
          </button>
        </form>
      </section>

      <h2 className="section-title" style={{ marginTop: 22 }}>Reglas <span className="muted">(se aplica la primera que se cumpla)</span></h2>
      {rules.length === 0 && <p className="muted">Sin reglas todavía. Empieza con una «Todos» para repartir todo por turnos.</p>}
      <div className="rules">
        {rules.map((r, i) => (
          <article key={r.id} className="panel" aria-label={`Regla de reparto ${i + 1}`}>
            <div className="rule-head">
              <div>
                <h3 style={{ margin: 0 }}>{i + 1}. {ENTITY[r.entity]} · {FIELD_LABELS[r.field]}{r.value ? ` «${r.value}»` : ""}</h3>
                <p className="meta" style={{ margin: 0 }}>Por turnos entre {r.user_names.join(", ") || "—"}</p>
              </div>
              <form action={deleteAssignmentRuleAction.bind(null, r.id)}><button type="submit" className="btn secondary small">Quitar</button></form>
            </div>
            <details>
              <summary className="meta">Editar</summary>
              <ActionForm action={saveAssignmentRuleAction.bind(null, r.id)} submitLabel="Guardar" secondary>
                <RuleFields rule={r} users={humans} />
              </ActionForm>
            </details>
          </article>
        ))}
      </div>

      <section className="panel" style={{ marginTop: 18 }}>
        <h2>Nueva regla</h2>
        <ActionForm action={saveAssignmentRuleAction.bind(null, null)} submitLabel="Añadir regla" resetOnSuccess>
          <RuleFields users={humans} />
        </ActionForm>
      </section>
    </main>
  );
}
