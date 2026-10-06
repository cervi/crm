-- =====================================================================
-- 0005_mailbox.sql — Correo y calendario conectados (Microsoft 365)
--
--   mailbox_connections  Buzón de Outlook de cada usuario del CRM: tokens
--                        cifrados, estado de la sincronización y sus
--                        preferencias para ofrecer huecos.
--
-- Con un buzón conectado:
--   * los correos del CRM salen desde ese buzón (quedan en «Enviados»);
--   * los correos y reuniones con contactos del CRM se registran solos;
--   * la IA puede ofrecer huecos libres del calendario ({huecos}).
-- =====================================================================

BEGIN;

CREATE TABLE mailbox_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  provider        text NOT NULL DEFAULT 'microsoft' CHECK (provider IN ('microsoft')),
  email           text NOT NULL,
  display_name    text,
  tokens          text NOT NULL,              -- cifrado (AES-256-GCM) con TOKEN_ENCRYPTION_KEY
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error')),
  last_error      text,
  -- Preferencias para ofrecer huecos: días laborables (1 = lunes … 7 = domingo),
  -- horario, duración, margen entre reuniones, antelación mínima, cuántos días
  -- mirar y cuántos huecos ofrecer.
  scheduling      jsonb NOT NULL DEFAULT '{}'::jsonb,
  sync_mail       boolean NOT NULL DEFAULT true,
  sync_calendar   boolean NOT NULL DEFAULT true,
  mail_synced_at  timestamptz,
  calendar_synced_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER mailbox_connections_updated_at BEFORE UPDATE ON mailbox_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Correos y reuniones sincronizados: la referencia externa evita duplicados
-- (msg:<Internet-Message-ID>, evt:<id del evento>).
CREATE UNIQUE INDEX activities_external_ref_uq ON activities (external_ref) WHERE external_ref IS NOT NULL;

-- Con buzón conectado, los correos ya pueden salir solos.
UPDATE ai_permissions SET allowed_autonomy = ARRAY['off', 'ask', 'auto'] WHERE action_type = 'draft_email';
UPDATE automation_rules SET allowed_autonomy = ARRAY['off', 'ask', 'auto']
WHERE key IN ('stale_deal_followup', 'no_show_rebook');

-- Las plantillas pueden incluir {huecos}: los próximos huecos libres de tu calendario.
UPDATE automation_rules
SET params = jsonb_set(params, '{body}', to_jsonb(E'Hola {nombre},\n\nNo coincidimos en la {sesion} de hoy, no pasa nada. ¿Te encaja alguno de estos huecos para retomarla?\n\n{huecos}\n\nUn saludo,\n{responsable}'::text))
WHERE key = 'no_show_rebook';

INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position) VALUES
  ('offer_session_slots',
   'Fase sin su sesión: ofrecer huecos',
   'Si un deal está en una fase que requiere una sesión y no la tiene agendada, prepara un correo al contacto con tus próximos huecos libres. Necesita el calendario conectado; si no lo está, se crea la tarea de agendarla.',
   'ask', ARRAY['off', 'ask', 'auto'],
   '{"grace_days": 0, "cooldown_days": 4, "subject": "{deal}: ¿cuándo hacemos la {sesion}?", "body": "Hola {nombre},\n\nPara seguir con {deal}, el siguiente paso es la {sesion}. Te propongo estos huecos:\n\n{huecos}\n\nDime cuál te viene mejor y te envío la invitación.\n\nUn saludo,\n{responsable}"}', 0);

COMMIT;
