import Link from "next/link";
import { ConfirmButton } from "@/components/ConfirmButton";
import { deleteAssignmentRuleAction, saveAssignmentRuleAction, setAssignmentEnabledAction } from "@/app/actions/assignment";
import { ActionForm } from "@/components/ActionForm";
import { Drawer } from "@/components/Drawer";
import { Icon } from "@/components/Icon";
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
    <main className="page medium">
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

      <section className="settings-inline" aria-label="Reparto automático">
        <form action={setAssignmentEnabledAction.bind(null, !settings.assignment_enabled)} className="switch-row">
          <button type="submit" className={settings.assignment_enabled ? "switch on" : "switch"} aria-pressed={settings.assignment_enabled}
                  aria-label={settings.assignment_enabled ? "Desactivar el reparto" : "Activar el reparto"}><i /></button>
          <h2 style={{ margin: 0, fontSize: 15 }}>Reparto automático: {settings.assignment_enabled ? "activado" : "desactivado"}</h2>
        </form>
        {settings.assignment_enabled && settings.assignment_since && <p className="meta">Se reparte lo que llega desde el {dateTime(settings.assignment_since)}.</p>}
      </section>

      <div className="block-head row" style={{ marginBottom: 10 }}>
        <div>
          <h2>Reglas</h2>
          <p className="meta">Se aplica la primera que se cumpla, de arriba abajo.</p>
        </div>
        <Drawer label={<><Icon name="plus" />Nueva regla</>} buttonClass="btn" title="Nueva regla de reparto">
          <ActionForm action={saveAssignmentRuleAction.bind(null, null)} submitLabel="Añadir regla" resetOnSuccess>
            <RuleFields users={humans} />
          </ActionForm>
        </Drawer>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th className="num">#</th><th>Aplica a</th><th>Cuando</th><th>Reparte por turnos entre</th><th><span className="sr-only">Acciones</span></th></tr></thead>
          <tbody>
            {rules.length === 0 && <tr><td colSpan={5} className="empty-row">Sin reglas todavía. Empieza con una «Todos» para repartir todo por turnos.</td></tr>}
            {rules.map((r, i) => (
              <tr key={r.id} aria-label={`Regla de reparto ${i + 1}`}>
                <td className="num">{i + 1}</td>
                <td>{ENTITY[r.entity]}</td>
                <td>{FIELD_LABELS[r.field]}{r.value ? <> «{r.value}»</> : ""}</td>
                <td>{r.user_names.join(", ") || <span className="muted">Nadie</span>}</td>
                <td className="row-actions">
                  <Drawer label="Editar" title={`Regla ${i + 1}`} subtitle={`${ENTITY[r.entity]} · ${FIELD_LABELS[r.field]}${r.value ? ` «${r.value}»` : ""}`} buttonTitle={`Editar la regla ${i + 1}`}>
                    <section className="drawer-section">
                      <ActionForm action={saveAssignmentRuleAction.bind(null, r.id)} submitLabel="Guardar cambios">
                        <RuleFields rule={r} users={humans} />
                      </ActionForm>
                    </section>
                    <section className="drawer-section">
                      <h3>Quitar la regla</h3>
                      <form action={deleteAssignmentRuleAction.bind(null, r.id)}><ConfirmButton label="Quitar la regla" confirm="Los leads nuevos dejarán de repartirse con esta regla." /></form>
                    </section>
                  </Drawer>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
