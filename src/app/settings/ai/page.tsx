import Link from "next/link";
import { AI_PROVIDERS, AI_TASKS, aiReady, DEFAULT_PROMPTS, getAiSettings, promptFor } from "@/lib/ai";
import { encryptionConfigured } from "@/lib/crypto";
import { dateTime } from "@/lib/format";
import { saveAiSettingsAction, testAiAction } from "@/app/actions/ai";
import { ActionForm } from "@/components/ActionForm";
import { requireAdminPage } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Modelo de IA" };

export default async function AiSettingsPage() {
  await requireAdminPage();
  const s = await getAiSettings();
  const ready = aiReady(s);
  return (
    <main className="page medium">
      <div className="crumbs"><Link href="/settings">Ajustes</Link></div>
      <div className="page-head">
        <div>
          <h1>Modelo de IA</h1>
          <p className="muted" style={{ margin: 0 }}>
            El modelo que redacta los resúmenes: de cada deal, tras cada reunión, el parte del día y el traspaso a Customer Success.
            Sin modelo, el CRM los hace igualmente con reglas (más esquemáticos).
          </p>
        </div>
      </div>

      <section className={`panel ai-state ${ready ? "ok" : ""}`}>
        <div>
          <h2 style={{ margin: 0 }}>{ready ? `Activo: ${AI_PROVIDERS.find((p) => p.value === s.provider)?.label} · ${s.model}` : "Sin modelo configurado"}</h2>
          <p className="meta" style={{ margin: "4px 0 0" }}>
            {s.last_error ? <span className="tone-bad">Último error: {s.last_error}</span>
              : s.last_ok_at ? `Última respuesta correcta: ${dateTime(s.last_ok_at)}` : ready ? "Aún no se ha usado." : "Los resúmenes se hacen con reglas."}
          </p>
        </div>
        {ready && <ActionForm action={testAiAction} submitLabel="Probar conexión" pendingLabel="Probando…" secondary className="form inline" />}
      </section>

      <section className="panel">
        <ActionForm action={saveAiSettingsAction} submitLabel="Guardar">
          <div className="grid-2">
            <label className="field"><span className="label">Proveedor</span>
              <select name="provider" defaultValue={s.provider}>
                {AI_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
            <label className="field"><span className="label">Modelo</span>
              <input name="model" defaultValue={s.model ?? ""} placeholder="Nombre exacto del modelo en el proveedor" />
            </label>
            <label className="field"><span className="label">Clave de API</span>
              <input name="api_key" type="password" autoComplete="off" placeholder={s.has_key ? "Guardada (escribe otra para cambiarla)" : "Pega aquí la clave"} />
              {!encryptionConfigured() && <span className="meta tone-bad">Falta TOKEN_ENCRYPTION_KEY en el servidor para guardar la clave cifrada.</span>}
            </label>
            <label className="field"><span className="label">Dirección de la API (opcional)</span>
              <input name="base_url" defaultValue={s.base_url ?? ""} placeholder="Por defecto, la del proveedor" />
              <span className="meta">Solo para «Otro compatible» o si usáis un proxy.</span>
            </label>
          </div>
          {s.has_key && <label className="checkbox"><input type="checkbox" name="clear_key" />Borrar la clave guardada</label>}

          <fieldset className="fieldset">
            <legend>Prompts</legend>
            <p className="meta" style={{ marginTop: 0 }}>
              Las instrucciones de cada resumen. El modelo recibe además los datos del CRM en JSON. Deja el texto de serie si no quieres cambiarlo.
            </p>
            <div className="prompts">
              {AI_TASKS.map((t) => (
                <details key={t.value} className="prompt">
                  <summary>
                    <strong>{t.label}</strong> <span className="meta">{t.help}</span>
                    {promptFor(s, t.value) !== DEFAULT_PROMPTS[t.value] && <span className="badge ai">Personalizado</span>}
                  </summary>
                  <textarea name={`prompt_${t.value}`} rows={7} defaultValue={promptFor(s, t.value)} aria-label={`Prompt: ${t.label}`} />
                  <span className="meta">Para volver al de serie, borra el texto y guarda.</span>
                </details>
              ))}
            </div>
          </fieldset>
        </ActionForm>
      </section>
    </main>
  );
}
