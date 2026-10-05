-- =====================================================================
-- 0001_core.sql — Modelo de datos base del CRM
--
-- Entidades: usuarios, empresas, contactos (con historial laboral),
-- leads, pipelines y fases, deals, productos, actividades, notas,
-- etiquetas, campos personalizados y un registro de eventos que sirve
-- de historial, de auditoría (incluida la IA) y de fuente para las
-- automatizaciones.
--
-- Convenciones:
--   * Claves primarias UUID (gen_random_uuid, nativo desde PostgreSQL 13).
--   * Los campos personalizados se guardan en la columna jsonb `custom`
--     de cada entidad; sus definiciones viven en custom_field_definitions.
--   * `pipedrive_id` permite importar desde Pipedrive de forma repetible
--     (si se relanza la importación, no se duplican registros).
--   * Borrado lógico con `deleted_at` en las entidades principales.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Usuarios del CRM (personas del equipo y agentes de IA)
-- ---------------------------------------------------------------------

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  email        text,
  kind         text NOT NULL DEFAULT 'human' CHECK (kind IN ('human', 'ai_agent')),
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
  is_active    boolean NOT NULL DEFAULT true,
  pipedrive_id bigint UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------
-- Empresas
-- ---------------------------------------------------------------------

CREATE TABLE organizations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  domain       text,                       -- clave principal de deduplicación
  website      text,
  industry     text,
  employee_count integer CHECK (employee_count IS NULL OR employee_count >= 0),
  country      text,
  city         text,
  address      text,
  owner_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  custom       jsonb NOT NULL DEFAULT '{}'::jsonb,
  pipedrive_id bigint UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE UNIQUE INDEX organizations_domain_uq ON organizations (lower(domain))
  WHERE domain IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX organizations_name_idx ON organizations (lower(name));
CREATE INDEX organizations_custom_gin ON organizations USING gin (custom);

-- ---------------------------------------------------------------------
-- Contactos (personas)
-- ---------------------------------------------------------------------

CREATE TABLE persons (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name   text,
  last_name    text,
  full_name    text GENERATED ALWAYS AS (
                 nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')
               ) STORED,
  linkedin_url text,
  owner_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Consentimiento para comunicaciones comerciales (RGPD)
  marketing_consent    boolean NOT NULL DEFAULT false,
  marketing_consent_at timestamptz,
  unsubscribed_at      timestamptz,
  custom       jsonb NOT NULL DEFAULT '{}'::jsonb,
  pipedrive_id bigint UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  CHECK (first_name IS NOT NULL OR last_name IS NOT NULL)
);
CREATE INDEX persons_name_idx ON persons (lower(full_name));
CREATE INDEX persons_custom_gin ON persons USING gin (custom);

-- Varios emails y teléfonos por contacto, como en Pipedrive.
CREATE TABLE person_emails (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id  uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  email      text NOT NULL CHECK (position('@' IN email) > 1),
  label      text NOT NULL DEFAULT 'work' CHECK (label IN ('work', 'personal', 'other')),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Un email pertenece a un solo contacto: base de la deduplicación.
CREATE UNIQUE INDEX person_emails_email_uq ON person_emails (lower(email));
CREATE UNIQUE INDEX person_emails_one_primary ON person_emails (person_id) WHERE is_primary;

CREATE TABLE person_phones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id  uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  phone      text NOT NULL,
  label      text NOT NULL DEFAULT 'work' CHECK (label IN ('work', 'mobile', 'personal', 'other')),
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX person_phones_person_idx ON person_phones (person_id);
CREATE UNIQUE INDEX person_phones_one_primary ON person_phones (person_id) WHERE is_primary;

-- Relación contacto–empresa con historial: quien deja la empresa pasa a
-- 'former' y conserva todo su historial; puede tener otra relación
-- 'current' con su nueva empresa.
CREATE TABLE person_organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_title       text,
  status          text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'former')),
  started_at      date,
  ended_at        date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'former' OR ended_at IS NULL),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX person_organizations_current_uq
  ON person_organizations (person_id, organization_id) WHERE status = 'current';
CREATE INDEX person_organizations_org_idx ON person_organizations (organization_id, status);

-- ---------------------------------------------------------------------
-- Pipelines y fases
-- ---------------------------------------------------------------------

CREATE TABLE pipelines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  position     integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  pipedrive_id bigint UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pipelines_name_uq ON pipelines (lower(name));

CREATE TABLE stages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id      uuid NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name             text NOT NULL,
  position         integer NOT NULL,
  win_probability  integer CHECK (win_probability BETWEEN 0 AND 100),
  -- Días sin avanzar a partir de los cuales el deal se considera parado
  -- ("rotting" en Pipedrive). Lo usará el seguimiento automático.
  rotten_after_days integer CHECK (rotten_after_days IS NULL OR rotten_after_days > 0),
  -- Sesión que debe celebrarse en esta fase (demo, llamada…). Si el deal
  -- no la tiene agendada, el seguimiento automático intentará agendarla.
  required_activity_type text CHECK (required_activity_type IN
                     ('call', 'meeting', 'video_call', 'demo', 'email', 'task', 'deadline')),
  is_active        boolean NOT NULL DEFAULT true,
  pipedrive_id     bigint UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pipeline_id, position) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (id, pipeline_id)       -- permite la FK compuesta desde deals
);

-- ---------------------------------------------------------------------
-- Productos y motivos de pérdida
-- ---------------------------------------------------------------------

CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  code         text UNIQUE,
  unit_price   numeric(14, 2) CHECK (unit_price IS NULL OR unit_price >= 0),
  currency     char(3) NOT NULL DEFAULT 'EUR',
  billing      text NOT NULL DEFAULT 'one_off' CHECK (billing IN ('one_off', 'monthly', 'yearly')),
  is_active    boolean NOT NULL DEFAULT true,
  pipedrive_id bigint UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lost_reasons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text NOT NULL UNIQUE,
  -- Si se informa, al perder un deal por este motivo se programa una
  -- tarea de seguimiento a N días.
  followup_days integer CHECK (followup_days IS NULL OR followup_days > 0),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Leads (antes de ser deal)
-- ---------------------------------------------------------------------

CREATE TABLE leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  person_id        uuid REFERENCES persons(id) ON DELETE SET NULL,
  organization_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
  source           text,          -- origen: webinar, ebook, formulario web…
  source_detail    text,          -- qué contenido concreto (nombre del webinar…)
  funnel_stage     text CHECK (funnel_stage IN ('tofu', 'mofu', 'bofu')),
  status           text NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'converted', 'archived')),
  converted_deal_id uuid,         -- FK añadida tras crear deals
  converted_at     timestamptz,
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  custom           jsonb NOT NULL DEFAULT '{}'::jsonb,
  pipedrive_id     text UNIQUE,   -- en Pipedrive los leads usan UUID
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CHECK (person_id IS NOT NULL OR organization_id IS NOT NULL),
  CHECK ((status = 'converted') = (converted_deal_id IS NOT NULL))
);
CREATE INDEX leads_status_idx ON leads (status) WHERE deleted_at IS NULL;
CREATE INDEX leads_person_idx ON leads (person_id);
CREATE INDEX leads_org_idx ON leads (organization_id);
CREATE INDEX leads_source_idx ON leads (source, funnel_stage);

-- ---------------------------------------------------------------------
-- Deals
-- ---------------------------------------------------------------------

CREATE TABLE deals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title               text NOT NULL,
  organization_id     uuid REFERENCES organizations(id) ON DELETE SET NULL,
  pipeline_id         uuid NOT NULL,
  stage_id            uuid NOT NULL,
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  value               numeric(14, 2) CHECK (value IS NULL OR value >= 0),
  currency            char(3) NOT NULL DEFAULT 'EUR',
  expected_close_date date,
  owner_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  lead_id             uuid REFERENCES leads(id) ON DELETE SET NULL,  -- lead de origen
  source              text,
  stage_entered_at    timestamptz NOT NULL DEFAULT now(),
  won_at              timestamptz,
  lost_at             timestamptz,
  lost_reason_id      uuid REFERENCES lost_reasons(id) ON DELETE SET NULL,
  lost_note           text,
  custom              jsonb NOT NULL DEFAULT '{}'::jsonb,
  pipedrive_id        bigint UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  -- La fase siempre pertenece al pipeline del deal.
  FOREIGN KEY (stage_id, pipeline_id) REFERENCES stages (id, pipeline_id),
  FOREIGN KEY (pipeline_id) REFERENCES pipelines (id),
  CHECK (status <> 'won'  OR won_at  IS NOT NULL),
  CHECK (status <> 'lost' OR lost_at IS NOT NULL)
);
CREATE INDEX deals_board_idx ON deals (pipeline_id, stage_id, status) WHERE deleted_at IS NULL;
CREATE INDEX deals_org_idx ON deals (organization_id);
CREATE INDEX deals_owner_idx ON deals (owner_id, status);
CREATE INDEX deals_custom_gin ON deals USING gin (custom);

ALTER TABLE leads
  ADD CONSTRAINT leads_converted_deal_fk
  FOREIGN KEY (converted_deal_id) REFERENCES deals(id) ON DELETE SET NULL;

-- Contactos asociados a cada deal (uno o varios).
CREATE TABLE deal_participants (
  deal_id    uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  person_id  uuid NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role       text,                 -- decisor, usuario, técnico…
  is_primary boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, person_id)
);
CREATE UNIQUE INDEX deal_participants_one_primary ON deal_participants (deal_id) WHERE is_primary;
CREATE INDEX deal_participants_person_idx ON deal_participants (person_id);

CREATE TABLE deal_products (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id    uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  quantity   numeric(12, 2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  discount_pct numeric(5, 2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deal_products_deal_idx ON deal_products (deal_id);

-- Historial de fases: base de los tiempos de conversión por fase.
CREATE TABLE deal_stage_history (
  id            bigserial PRIMARY KEY,
  deal_id       uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  pipeline_id   uuid NOT NULL REFERENCES pipelines(id),
  from_stage_id uuid REFERENCES stages(id),
  to_stage_id   uuid NOT NULL REFERENCES stages(id),
  changed_at    timestamptz NOT NULL
);
CREATE INDEX deal_stage_history_deal_idx ON deal_stage_history (deal_id, changed_at);

-- ---------------------------------------------------------------------
-- Actividades (llamadas, reuniones, tareas…) y notas
-- ---------------------------------------------------------------------

CREATE TABLE activities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN
                     ('call', 'meeting', 'video_call', 'demo', 'email', 'task', 'deadline')),
  subject          text NOT NULL,
  note             text,
  due_at           timestamptz,
  duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  done             boolean NOT NULL DEFAULT false,
  done_at          timestamptz,
  -- Resultado de una sesión: permite detectar ausencias (no_show).
  outcome          text CHECK (outcome IN ('held', 'no_show', 'rescheduled', 'cancelled')),
  deal_id          uuid REFERENCES deals(id) ON DELETE CASCADE,
  lead_id          uuid REFERENCES leads(id) ON DELETE CASCADE,
  person_id        uuid REFERENCES persons(id) ON DELETE SET NULL,
  organization_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
  owner_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_id    uuid REFERENCES users(id) ON DELETE SET NULL,  -- persona o agente de IA
  meeting_url      text,
  external_ref     text,          -- id del evento en el calendario
  transcript       text,          -- transcripción de la llamada, si la hay
  summary          text,          -- resumen generado
  pipedrive_id     bigint UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (deal_id IS NOT NULL OR lead_id IS NOT NULL OR person_id IS NOT NULL OR organization_id IS NOT NULL),
  CHECK (done = (done_at IS NOT NULL))
);
CREATE INDEX activities_pending_idx ON activities (owner_id, due_at) WHERE NOT done;
CREATE INDEX activities_deal_idx ON activities (deal_id, due_at);
CREATE INDEX activities_person_idx ON activities (person_id, due_at);
CREATE INDEX activities_org_idx ON activities (organization_id, due_at);
CREATE INDEX activities_lead_idx ON activities (lead_id, due_at);

CREATE TABLE notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content         text NOT NULL,
  deal_id         uuid REFERENCES deals(id) ON DELETE CASCADE,
  lead_id         uuid REFERENCES leads(id) ON DELETE CASCADE,
  person_id       uuid REFERENCES persons(id) ON DELETE CASCADE,
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  author_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  is_pinned       boolean NOT NULL DEFAULT false,
  pipedrive_id    bigint UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (deal_id IS NOT NULL OR lead_id IS NOT NULL OR person_id IS NOT NULL OR organization_id IS NOT NULL)
);
CREATE INDEX notes_deal_idx ON notes (deal_id);
CREATE INDEX notes_person_idx ON notes (person_id);
CREATE INDEX notes_org_idx ON notes (organization_id);
CREATE INDEX notes_lead_idx ON notes (lead_id);

-- ---------------------------------------------------------------------
-- Etiquetas
-- ---------------------------------------------------------------------

CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  color      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tags_name_uq ON tags (lower(name));

CREATE TABLE organization_tags (
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  tag_id          uuid REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (organization_id, tag_id)
);
CREATE TABLE person_tags (
  person_id uuid REFERENCES persons(id) ON DELETE CASCADE,
  tag_id    uuid REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (person_id, tag_id)
);
CREATE TABLE lead_tags (
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  tag_id  uuid REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);
CREATE TABLE deal_tags (
  deal_id uuid REFERENCES deals(id) ON DELETE CASCADE,
  tag_id  uuid REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (deal_id, tag_id)
);

-- ---------------------------------------------------------------------
-- Campos personalizados (definiciones; los valores van en `custom`)
-- ---------------------------------------------------------------------

CREATE TABLE custom_field_definitions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('organization', 'person', 'lead', 'deal')),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label       text NOT NULL,
  field_type  text NOT NULL CHECK (field_type IN
                ('text', 'long_text', 'number', 'money', 'date', 'datetime', 'boolean',
                 'single_option', 'multi_option', 'user', 'url', 'email', 'phone')),
  options     jsonb,               -- para single_option / multi_option: [{"key","label"}]
  is_required boolean NOT NULL DEFAULT false,
  position    integer NOT NULL DEFAULT 0,
  is_archived boolean NOT NULL DEFAULT false,
  pipedrive_key text,              -- hash del campo en Pipedrive, para la importación
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, key),
  CHECK (
    CASE WHEN field_type IN ('single_option', 'multi_option')
         THEN coalesce(jsonb_typeof(options) = 'array', false)
              AND CASE WHEN jsonb_typeof(options) = 'array'
                       THEN jsonb_array_length(options) > 0 ELSE false END
         ELSE options IS NULL
    END
  )
);

-- ---------------------------------------------------------------------
-- Registro de eventos: historial, auditoría y disparador de automatizaciones
-- ---------------------------------------------------------------------

CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  entity_type text NOT NULL CHECK (entity_type IN
                ('organization', 'person', 'lead', 'deal', 'activity', 'note')),
  entity_id   uuid NOT NULL,
  event_type  text NOT NULL,       -- p. ej. 'deal.created', 'deal.stage_changed', 'deal.won'
  actor_type  text NOT NULL DEFAULT 'system'
                CHECK (actor_type IN ('user', 'ai_agent', 'system', 'integration')),
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  processed_at timestamptz         -- lo marca el motor de automatizaciones
);
CREATE INDEX events_entity_idx ON events (entity_type, entity_id, occurred_at);
CREATE INDEX events_unprocessed_idx ON events (id) WHERE processed_at IS NULL;
CREATE INDEX events_type_idx ON events (event_type, occurred_at);

-- ---------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'organizations', 'persons', 'person_organizations', 'pipelines', 'stages',
    'products', 'leads', 'deals', 'activities', 'notes', 'custom_field_definitions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t || '_updated_at', t);
  END LOOP;
END $$;

-- Deals: fechas de cambio de fase / cierre y su historial. Si quien
-- actualiza informa explícitamente las fechas (p. ej. la importación de
-- Pipedrive), se respetan.
CREATE OR REPLACE FUNCTION deals_before_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.stage_id IS DISTINCT FROM OLD.stage_id
       AND NEW.stage_entered_at IS NOT DISTINCT FROM OLD.stage_entered_at THEN
      NEW.stage_entered_at := now();
    END IF;
    IF NEW.status = 'open' THEN
      NEW.won_at := NULL; NEW.lost_at := NULL;
      NEW.lost_reason_id := NULL; NEW.lost_note := NULL;
    END IF;
  END IF;
  IF NEW.status = 'won'  AND NEW.won_at  IS NULL THEN NEW.won_at  := now(); END IF;
  IF NEW.status = 'lost' AND NEW.lost_at IS NULL THEN NEW.lost_at := now(); END IF;
  IF NEW.status <> 'won'  THEN NEW.won_at  := NULL; END IF;
  IF NEW.status <> 'lost' THEN NEW.lost_at := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deals_before_write
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION deals_before_write();

CREATE OR REPLACE FUNCTION deals_after_write() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO deal_stage_history (deal_id, pipeline_id, from_stage_id, to_stage_id, changed_at)
    VALUES (NEW.id, NEW.pipeline_id, NULL, NEW.stage_id, NEW.stage_entered_at);
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    INSERT INTO deal_stage_history (deal_id, pipeline_id, from_stage_id, to_stage_id, changed_at)
    VALUES (NEW.id, NEW.pipeline_id, OLD.stage_id, NEW.stage_id, NEW.stage_entered_at);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deals_after_write
  AFTER INSERT OR UPDATE ON deals
  FOR EACH ROW EXECUTE FUNCTION deals_after_write();

-- Actividades: done_at coherente con done.
CREATE OR REPLACE FUNCTION activities_before_write() RETURNS trigger AS $$
BEGIN
  IF NEW.done AND NEW.done_at IS NULL THEN NEW.done_at := now(); END IF;
  IF NOT NEW.done THEN NEW.done_at := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activities_before_write
  BEFORE INSERT OR UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION activities_before_write();

-- ---------------------------------------------------------------------
-- Vistas de apoyo
-- ---------------------------------------------------------------------

-- Deals abiertos con días en la fase actual y si están parados.
CREATE VIEW open_deals_status AS
SELECT d.id, d.title, d.pipeline_id, d.stage_id, s.name AS stage_name,
       d.owner_id, d.organization_id, d.value, d.currency,
       floor(extract(epoch FROM now() - d.stage_entered_at) / 86400)::int AS days_in_stage,
       (s.rotten_after_days IS NOT NULL
          AND now() - d.stage_entered_at > make_interval(days => s.rotten_after_days)) AS is_rotten,
       s.required_activity_type,
       EXISTS (
         SELECT 1 FROM activities a
         WHERE a.deal_id = d.id AND NOT a.done AND a.due_at >= now()
           AND (s.required_activity_type IS NULL OR a.type = s.required_activity_type)
       ) AS has_upcoming_session
FROM deals d
JOIN stages s ON s.id = d.stage_id
WHERE d.status = 'open' AND d.deleted_at IS NULL;

COMMIT;
