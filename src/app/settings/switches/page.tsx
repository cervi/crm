import Link from "next/link";
import { saveSwitchesAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/ActionForm";
import { requireAdminPage } from "@/lib/auth";
import { dateTime } from "@/lib/format";
import { SWITCHES, SWITCH_GROUPS, allSwitches, recentBlocked } from "@/lib/switches";

export const dynamic = "force-dynamic";
export const metadata = { title: "Interruptores" };

/** Encender o apagar módulos enteros, con lo que el servidor tiene bloqueado y lo que no ha salido por ello. */
export default async function SwitchesPage() {
  await requireAdminPage();
  const [states, blocked] = await Promise.all([allSwitches(), recentBlocked(50)]);
  const anyLocked = states.some((s) => s.locked);
  const emailOn = states.find((s) => s.key === "email_out")?.on;
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head"><div><h1>Interruptores</h1>
        <p className="muted" style={{ margin: 0 }}>Enciende o apaga módulos enteros del CRM. Apagar es inmediato y no borra nada: al encender, todo sigue donde estaba.</p></div></div>

      {anyLocked && (
        <p className="callout">Algunos están <strong>bloqueados por el servidor</strong> (variables <code>OUTBOUND_DISABLED</code> o <code>SWITCHES_OFF</code>):
          están apagados y desde aquí no se pueden encender. Para cambiarlos hay que tocar la configuración del servidor.</p>
      )}

      <ActionForm action={saveSwitchesAction} submitLabel="Guardar interruptores"
                  confirm={emailOn ? undefined : "Si enciendes «Enviar correos», empezarán a salir los correos programados y los de las secuencias activas."}
                  confirmWhen={emailOn ? undefined : { field: "email_out", value: "on" }}>
        {SWITCH_GROUPS.map(([g, title]) => (
          <section key={g} className="panel" aria-label={title}>
            <h2>{title}</h2>
            <ul className="switch-list">
              {states.filter((s) => s.group === g).map((s) => (
                <li key={s.key}>
                  <div><strong>{s.label}</strong><span className="meta">{s.help}</span>
                    {s.on && !emailOn && (s.key === "team_mail" || s.key === "sequences" || s.key === "campaigns") && (
                      <span className="meta tone-warn">Mientras «Enviar correos» esté apagado, sus correos no salen.</span>
                    )}</div>
                  <label className="switch-toggle">
                    <input type="checkbox" role="switch" name={s.key} defaultChecked={s.on} disabled={s.locked} aria-label={s.label} />
                    <span className={s.locked ? "meta" : undefined}>{s.locked ? "Bloqueado por el servidor" : s.on ? "Encendido" : "Apagado"}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </ActionForm>

      <section className="panel" aria-label="Lo que no ha salido">
        <h2>Lo que no ha salido</h2>
        <p className="meta" style={{ marginTop: 0 }}>Cada correo, invitación o aviso a otra herramienta que un interruptor ha parado. Sirve para comprobar que, con los envíos apagados, no ha salido nada.</p>
        {blocked.length === 0 ? <p className="muted">Nada parado todavía.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Cuándo</th><th>Qué</th><th>A quién / adónde</th><th>Asunto</th><th>Origen</th><th>Interruptor</th></tr></thead>
            <tbody>{blocked.map((b, i) => (
              <tr key={i}><td className="nowrap">{dateTime(b.at)}</td><td>{b.kind}</td><td>{b.target ?? "—"}</td><td>{b.subject ?? "—"}</td>
                <td className="meta">{b.source ?? "—"}</td><td className="meta">{SWITCHES[b.switch]?.label ?? b.switch}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </main>
  );
}
