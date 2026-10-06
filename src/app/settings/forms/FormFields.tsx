import { FIELD_DEFAULT_LABELS, FIELD_KEYS, type WebForm } from "@/lib/webforms";

/** Campos del editor de un formulario web (los mismos al crear y al editar). */
export function FormEditorFields({ f, aiOn }: { f?: WebForm | null; aiOn: boolean }) {
  const has = (k: string) => f ? f.fields.some((x) => x.key === k) : ["full_name", "email", "company", "message"].includes(k);
  const field = (k: string) => f?.fields.find((x) => x.key === k);
  return (
    <>
      <div className="grid-2">
        <label className="field"><span className="label">Nombre interno</span><input name="name" required defaultValue={f?.name ?? ""} placeholder="Contacto de la web" /></label>
        <label className="field"><span className="label">Dirección</span><input name="slug" required defaultValue={f?.slug ?? ""} placeholder="contacto" />
          <span className="meta">/f/<em>esta-direccion</em></span></label>
        <label className="field"><span className="label">Título visible</span><input name="title" required defaultValue={f?.title ?? "Hablemos"} /></label>
        <label className="field"><span className="label">Texto bajo el título</span><input name="description" defaultValue={f?.description ?? ""} /></label>
      </div>
      <fieldset className="fieldset">
        <legend>Campos</legend>
        <div className="form-fields-grid">
          {FIELD_KEYS.map((k) => (
            <div key={k} className="form-field-row">
              <label className="checkbox"><input type="checkbox" name={`field_${k}`} defaultChecked={has(k)} disabled={k === "email"} />{FIELD_DEFAULT_LABELS[k]}</label>
              <input name={`label_${k}`} defaultValue={field(k)?.label ?? FIELD_DEFAULT_LABELS[k]} aria-label={`Etiqueta de ${FIELD_DEFAULT_LABELS[k]}`} />
              <label className="checkbox"><input type="checkbox" name={`required_${k}`} defaultChecked={k === "email" || (field(k)?.required ?? k === "full_name")} disabled={k === "email"} />Obligatorio</label>
            </div>
          ))}
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Al recibirlo</legend>
        <div className="grid-3">
          <label className="field"><span className="label">Origen</span><input name="source" required defaultValue={f?.source ?? "formulario web"} /></label>
          <label className="field"><span className="label">Detalle del origen</span><input name="source_detail" defaultValue={f?.source_detail ?? ""} placeholder="Página de precios" /></label>
          <label className="field"><span className="label">Crea</span>
            <select name="intent" defaultValue={f?.intent ?? "lead"}>
              <option value="lead">Un lead</option>
              <option value="demo_request">Un deal (solicitud de demo)</option>
            </select></label>
          <label className="field"><span className="label">Etapa</span>
            <select name="funnel_stage" defaultValue={f?.funnel_stage ?? ""}>
              <option value="">—</option><option value="tofu">TOFU</option><option value="mofu">MOFU</option><option value="bofu">BOFU</option>
            </select></label>
          <label className="field"><span className="label">Etiquetas (separadas por comas)</span><input name="tags" defaultValue={f?.tags.join(", ") ?? ""} /></label>
          <label className="field"><span className="label">Llevar después a (opcional)</span><input name="redirect_url" type="url" defaultValue={f?.redirect_url ?? ""} placeholder="https://…/gracias" /></label>
        </div>
        <label className="field"><span className="label">Mensaje de gracias</span><input name="success_message" required defaultValue={f?.success_message ?? "¡Gracias! Te escribimos muy pronto."} /></label>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Chat con IA</legend>
        <label className="checkbox"><input type="checkbox" name="chat_enabled" defaultChecked={f?.chat_enabled ?? false} />Ofrecer también un chat con IA que responde, cualifica y recoge los datos</label>
        {!aiOn && <p className="meta">Para que aparezca, configura el modelo de IA en Ajustes → Modelo de IA.</p>}
        <label className="field"><span className="label">Qué vendéis y qué conviene preguntar</span>
          <textarea name="chat_context" rows={4} defaultValue={f?.chat_context ?? ""} placeholder="Somos… Ayudamos a… Pregunta por el tamaño del equipo, la herramienta actual y cuándo quieren empezar." /></label>
      </fieldset>
      {f && <label className="checkbox"><input type="checkbox" name="is_active" defaultChecked={f.is_active} />Formulario activo</label>}
    </>
  );
}
