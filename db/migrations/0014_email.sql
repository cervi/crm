-- Correo completo: conversación por deal, plantillas, envío programado y
-- seguimiento de aperturas y clics.

CREATE TABLE email_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  subject     text NOT NULL DEFAULT '',
  body        text NOT NULL DEFAULT '',
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,   -- NULL: compartida con el equipo
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Cada correo con un contacto: los que salen del CRM (también los programados)
-- y los que llegan o se envían desde el buzón y se sincronizan.
CREATE TABLE emails (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  direction       text NOT NULL CHECK (direction IN ('out', 'in')),
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  deal_id         uuid REFERENCES deals(id) ON DELETE SET NULL,
  person_id       uuid REFERENCES persons(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,     -- buzón con el que sale o en el que entra
  from_email      text,
  to_email        text,
  to_name         text,
  subject         text NOT NULL DEFAULT '',
  body            text NOT NULL DEFAULT '',
  scheduled_at    timestamptz,
  sent_at         timestamptz,
  activity_id     uuid REFERENCES activities(id) ON DELETE SET NULL,
  external_ref    text,
  template_id     uuid REFERENCES email_templates(id) ON DELETE SET NULL,
  track           boolean NOT NULL DEFAULT false,
  token           text UNIQUE,                                     -- para el píxel y los enlaces
  open_count      integer NOT NULL DEFAULT 0,
  first_opened_at timestamptz,
  last_opened_at  timestamptz,
  click_count     integer NOT NULL DEFAULT 0,
  last_clicked_at timestamptz,
  error           text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX emails_external_ref_uq ON emails (external_ref) WHERE external_ref IS NOT NULL;
CREATE INDEX emails_deal_idx ON emails (deal_id, coalesce(sent_at, scheduled_at, created_at) DESC);
CREATE INDEX emails_person_idx ON emails (person_id, coalesce(sent_at, scheduled_at, created_at) DESC);
CREATE INDEX emails_due_idx ON emails (scheduled_at) WHERE status = 'scheduled';

CREATE TABLE email_clicks (
  id        bigserial PRIMARY KEY,
  email_id  uuid NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  url       text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_clicks_email_idx ON email_clicks (email_id);

-- Seguimiento de aperturas y clics: activado por defecto para los correos a contactos.
ALTER TABLE app_settings ADD COLUMN email_tracking boolean NOT NULL DEFAULT true;

-- Plantillas de ejemplo, compartidas.
INSERT INTO email_templates (name, subject, body) VALUES
  ('Seguimiento tras la demo', 'Siguientes pasos — {deal}',
   E'Hola {nombre},\n\nGracias por tu tiempo en la demo. Como comentamos, te resumo los siguientes pasos:\n\n- \n\n¿Te encaja que hablemos de nuevo esta semana? Estos son mis huecos:\n\n{huecos}\n\nUn saludo,\n{responsable}'),
  ('Retomar el contacto', '¿Seguimos con {deal}?',
   E'Hola {nombre},\n\nHace unos días que no hablamos y quería saber cómo lo veis por vuestra parte. Si te va bien, hablamos 20 minutos:\n\n{huecos}\n\nUn saludo,\n{responsable}'),
  ('Envío de propuesta', 'Propuesta para {empresa}',
   E'Hola {nombre},\n\nTe envío la propuesta que comentamos. Cualquier duda, me dices.\n\nUn saludo,\n{responsable}');
