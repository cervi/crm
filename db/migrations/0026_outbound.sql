-- =====================================================================
-- 0026 — Captación y outbound
--
--   · Perfil de cliente ideal (se rellena cuando lo defináis) y, con él,
--     la cualificación de cada lead: encaja / no encaja / falta saber.
--   · Enriquecimiento de empresas desde su web.
--   · Atribución UTM de cada lead.
--   · Buzones de outbound (dominios secundarios), con límite diario,
--     calentamiento y pausa automática si rebotan.
--   · Campañas de outbound: lista de contactos verificados, frase
--     personalizada aprobada por lotes, secuencia y respuestas clasificadas.
-- =====================================================================

BEGIN;

CREATE TABLE icp_profile (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  sectors        text[] NOT NULL DEFAULT '{}',
  min_employees  integer CHECK (min_employees >= 0),
  max_employees  integer CHECK (max_employees >= 0),
  countries      text[] NOT NULL DEFAULT '{}',
  roles          text[] NOT NULL DEFAULT '{}',
  exclusions     text[] NOT NULL DEFAULT '{}',   -- sectores, dominios o palabras que descartan
  must_have      text,                           -- otros criterios, en texto libre (para la IA)
  framework      text,                           -- cómo cualificáis (BANT, MEDDIC…), en texto libre
  updated_at     timestamptz NOT NULL DEFAULT now()
);
INSERT INTO icp_profile DEFAULT VALUES;

ALTER TABLE organizations
  ADD COLUMN description text,
  ADD COLUMN enriched_at timestamptz,
  ADD COLUMN enrichment  jsonb;

ALTER TABLE leads
  ADD COLUMN fit          text CHECK (fit IN ('fit', 'no_fit', 'unknown')),
  ADD COLUMN fit_reason   text,
  ADD COLUMN fit_missing  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN qualified_at timestamptz,
  ADD COLUMN utm          jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX leads_utm_campaign_idx ON leads ((utm->>'campaign')) WHERE utm ? 'campaign';

-- Cualificar o puntuar un lead no es «actividad» del lead: no cambia updated_at.
CREATE OR REPLACE FUNCTION leads_set_updated_at() RETURNS trigger AS $$
BEGIN
  IF (to_jsonb(NEW) - 'score' - 'score_reasons' - 'scored_at' - 'fit' - 'fit_reason' - 'fit_missing' - 'qualified_at' - 'updated_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'score' - 'score_reasons' - 'scored_at' - 'fit' - 'fit_reason' - 'fit_missing' - 'qualified_at' - 'updated_at') THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Buzones: el principal de cada persona y los de outbound (varios, de otros dominios).
ALTER TABLE mailbox_connections
  ADD COLUMN purpose       text NOT NULL DEFAULT 'main' CHECK (purpose IN ('main', 'outbound')),
  ADD COLUMN daily_limit   integer NOT NULL DEFAULT 40 CHECK (daily_limit BETWEEN 1 AND 500),
  ADD COLUMN warmup_start  date NOT NULL DEFAULT current_date,
  ADD COLUMN paused        boolean NOT NULL DEFAULT false,
  ADD COLUMN paused_reason text;
ALTER TABLE mailbox_connections DROP CONSTRAINT mailbox_connections_user_id_key;
CREATE UNIQUE INDEX mailbox_connections_main_uq ON mailbox_connections (user_id) WHERE purpose = 'main';
CREATE UNIQUE INDEX mailbox_connections_outbound_uq ON mailbox_connections (lower(email)) WHERE purpose = 'outbound';

CREATE TABLE campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'finished')),
  sequence_id      uuid REFERENCES sequences(id) ON DELETE SET NULL,
  mailbox_ids      uuid[] NOT NULL DEFAULT '{}',
  pipeline_id      uuid REFERENCES pipelines(id) ON DELETE SET NULL,   -- dónde nacen los deals de los interesados
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  target           jsonb NOT NULL DEFAULT '{}'::jsonb,                 -- {sector, size, country, roles}
  require_approval boolean NOT NULL DEFAULT true,
  send_days        integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  send_from        integer NOT NULL DEFAULT 8 CHECK (send_from BETWEEN 0 AND 23),
  send_to          integer NOT NULL DEFAULT 18 CHECK (send_to BETWEEN 1 AND 24),
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id     uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  person_id       uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  email           text NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN (
                    'pending',        -- por verificar
                    'invalid',        -- email no válido o dominio sin correo
                    'ready',          -- verificado, esperando aprobación de la frase
                    'approved',       -- aprobado, se inscribe en la secuencia
                    'enrolled',       -- en la secuencia
                    'interested', 'later', 'not_interested', 'unsubscribed', 'bounced', 'completed', 'skipped')),
  verify_note     text,
  personal_line   text,
  mailbox_id      uuid REFERENCES mailbox_connections(id) ON DELETE SET NULL,
  enrollment_id   uuid REFERENCES sequence_enrollments(id) ON DELETE SET NULL,
  deal_id         uuid REFERENCES deals(id) ON DELETE SET NULL,
  reply_class     text,
  reply_summary   text,
  last_reply_id   uuid,
  retake_at       date,
  source          text,                                   -- csv, crm, api, mcp
  added_at        timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, person_id)
);
CREATE INDEX campaign_contacts_status_idx ON campaign_contacts (campaign_id, status);
CREATE INDEX campaign_contacts_person_idx ON campaign_contacts (person_id);

ALTER TABLE sequence_enrollments
  ADD COLUMN mailbox_id          uuid REFERENCES mailbox_connections(id) ON DELETE SET NULL,
  ADD COLUMN campaign_contact_id uuid REFERENCES campaign_contacts(id) ON DELETE SET NULL;

ALTER TABLE emails
  ADD COLUMN mailbox_id  uuid REFERENCES mailbox_connections(id) ON DELETE SET NULL,
  ADD COLUMN campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  ADD COLUMN bounced     boolean NOT NULL DEFAULT false,
  ADD COLUMN reply_class text;     -- respuestas: interesado, más adelante, fuera de la oficina…
CREATE INDEX emails_mailbox_day_idx ON emails (mailbox_id, sent_at) WHERE direction = 'out';

ALTER TABLE person_emails ADD COLUMN bounced_at timestamptz;

INSERT INTO agent_jobs (key, agent, name, description, params, position) VALUES
  ('lead_enrich', 'captacion', 'Enriquecer las empresas nuevas',
   'Con la web de la empresa (por el dominio del email): sector, tamaño aproximado, país y a qué se dedica.', '{}', 10),
  ('lead_qualify', 'captacion', 'Cualificar los leads con vuestro perfil de cliente ideal',
   'Cada lead nuevo: encaja, no encaja o falta saber algo, con el motivo. Mientras el perfil esté vacío, no descarta a nadie.', '{}', 20),
  ('campaign_prepare', 'prospeccion', 'Preparar los contactos de las campañas',
   'Verifica los emails y escribe la primera línea personalizada de cada contacto; tú apruebas por lotes.', '{}', 10),
  ('campaign_replies', 'prospeccion', 'Clasificar las respuestas de las campañas',
   'Interesado (crea el deal), más adelante (programa el retome), no interesado o baja (sale de todo), fuera de la oficina (pausa y retoma).', '{}', 20);

INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position, agent) VALUES
  ('inbound_first_reply', 'Responder en minutos a los leads que encajan',
   'Lead nuevo de la web que encaja (o sin perfil definido): primer correo con tu enlace de reserva.',
   'ask', ARRAY['off', 'ask', 'auto'], '{"max_age_hours": 72}', 5, 'captacion');

COMMIT;
