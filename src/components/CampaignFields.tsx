import type { Campaign } from "@/lib/campaigns";

type Opt = { id: string; name: string };

/** Campos de una campaña (nueva o editar). */
export function CampaignFields({ c, sequences, mailboxes, pipelines, users }: {
  c?: Campaign; sequences: Opt[]; mailboxes: { id: string; email: string; paused: boolean; limit: number }[]; pipelines: Opt[]; users: Opt[];
}) {
  return (
    <>
      <div className="grid-2">
        <label className="field"><span className="label">Nombre *</span><input name="name" required defaultValue={c?.name} placeholder="Directores comerciales · software · Q4" /></label>
        <label className="field"><span className="label">Secuencia de correos</span>
          <select name="sequence_id" defaultValue={c?.sequence_id ?? ""}>
            <option value="">Elige…</option>
            {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <span className="meta">En los pasos puedes usar {"{nombre}"}, {"{empresa}"} y {"{gancho}"} (la primera línea personalizada).</span></label>
        <label className="field"><span className="label">A quién buscamos: sector</span><input name="sector" defaultValue={c?.target.sector ?? ""} /></label>
        <label className="field"><span className="label">Tamaño</span><input name="size" defaultValue={c?.target.size ?? ""} placeholder="50–500 empleados" /></label>
        <label className="field"><span className="label">País</span><input name="country" defaultValue={c?.target.country ?? ""} /></label>
        <label className="field"><span className="label">Cargos</span><input name="roles" defaultValue={c?.target.roles ?? ""} placeholder="Director comercial, CEO" /></label>
        <label className="field"><span className="label">Los interesados entran en el pipeline</span>
          <select name="pipeline_id" defaultValue={c?.pipeline_id ?? ""}>
            <option value="">Outbound (o el primero)</option>
            {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        <label className="field"><span className="label">Responsable</span>
          <select name="owner_id" defaultValue={c?.owner_id ?? ""}>
            <option value="">El del buzón que envía</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select></label>
      </div>
      <fieldset className="field">
        <legend className="label">Buzones de outbound (se reparten los contactos entre ellos)</legend>
        {mailboxes.length === 0 && <p className="meta">No hay buzones de outbound: conéctalos en Ajustes → Correo, calendario y documentos (usad dominios secundarios, no el principal).</p>}
        {mailboxes.map((m) => (
          <label key={m.id} className="checkbox"><input type="checkbox" name={`mb_${m.id}`} defaultChecked={c?.mailbox_ids.includes(m.id)} />
            {m.email} <span className="meta">· hasta {m.limit} al día{m.paused ? " · en pausa" : ""}</span></label>
        ))}
      </fieldset>
      <div className="grid-3">
        <label className="field"><span className="label">Envía desde las</span>
          <select name="send_from" defaultValue={c?.send_from ?? 8}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00</option>)}</select></label>
        <label className="field"><span className="label">Hasta las</span>
          <select name="send_to" defaultValue={c?.send_to ?? 18}>{Array.from({ length: 24 }, (_, h) => <option key={h + 1} value={h + 1}>{h + 1}:00</option>)}</select></label>
        <div className="day-picks" role="group" aria-label="Días de envío">
          {["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"].map((d, i) => (
            <label key={d} className="checkbox"><input type="checkbox" name={`day_${i + 1}`} defaultChecked={(c?.send_days ?? [1, 2, 3, 4, 5]).includes(i + 1)} />{d}</label>
          ))}
        </div>
      </div>
      <label className="checkbox"><input type="checkbox" name="require_approval" defaultChecked={c?.require_approval ?? true} />
        Revisar y aprobar por lotes la primera línea de cada contacto antes de que salga</label>
    </>
  );
}
