-- Formularios web alojados en el CRM (página propia o incrustados en vuestra
-- web) y chat con IA que cualifica al visitante y crea el lead.
CREATE TABLE web_forms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,60}$'),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  title            text NOT NULL DEFAULT 'Hablemos',
  description      text,
  fields           jsonb NOT NULL DEFAULT '[{"key":"full_name","label":"Nombre","required":true},{"key":"email","label":"Email","required":true},{"key":"company","label":"Empresa","required":false},{"key":"message","label":"¿En qué podemos ayudarte?","required":false}]'::jsonb,
  source           text NOT NULL DEFAULT 'formulario web',
  source_detail    text,
  intent           text NOT NULL DEFAULT 'lead' CHECK (intent IN ('lead', 'demo_request')),
  funnel_stage     text CHECK (funnel_stage IN ('tofu', 'mofu', 'bofu')),
  tags             text[] NOT NULL DEFAULT '{}',
  success_message  text NOT NULL DEFAULT '¡Gracias! Te escribimos muy pronto.',
  redirect_url     text,
  chat_enabled     boolean NOT NULL DEFAULT false,
  chat_context     text,          -- qué vendéis y qué preguntar, para el chat con IA
  is_active        boolean NOT NULL DEFAULT true,
  submissions      integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
