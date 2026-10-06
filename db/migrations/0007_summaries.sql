-- =====================================================================
-- 0007_summaries.sql — Resúmenes automáticos y modelo de IA configurable
--
--   ai_settings   Proveedor, modelo, clave (cifrada) y prompts de la IA.
--                 Sin configurar, los resúmenes se hacen con reglas.
--   deal_briefs   Último resumen de cada deal hecho por la IA (caché: se
--                 rehace cuando cambia algo en el deal o cambia el día).
--   digest_log    Partes del día enviados (uno por persona y día).
--   Reglas nuevas: resumen tras una reunión y pasar de fase tras la sesión.
-- =====================================================================

BEGIN;

CREATE TABLE ai_settings (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  provider    text NOT NULL DEFAULT 'none' CHECK (provider IN ('none', 'anthropic', 'openai', 'xai', 'compatible')),
  base_url    text,
  model       text,
  api_key     text,                 -- cifrada con TOKEN_ENCRYPTION_KEY
  prompts     jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error  text,
  last_ok_at  timestamptz,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_settings DEFAULT VALUES;

CREATE TABLE deal_briefs (
  deal_id      uuid PRIMARY KEY REFERENCES deals(id) ON DELETE CASCADE,
  basis        text NOT NULL,       -- qué versión del deal resume (último evento y día)
  content      jsonb NOT NULL,      -- { resumen, siguiente_paso, riesgos[] }
  generated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE automation_settings
  ADD COLUMN digest_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN digest_hour    integer NOT NULL DEFAULT 8 CHECK (digest_hour BETWEEN 0 AND 23),
  ADD COLUMN digest_days    integer[] NOT NULL DEFAULT ARRAY[1, 2, 3, 4, 5];

CREATE TABLE digest_log (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      date NOT NULL,
  sent_to  text NOT NULL,
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

-- Enfoque del día redactado por la IA (uno por persona —o equipo— y día).
CREATE TABLE digest_focus (
  owner_key    text NOT NULL,       -- id del usuario o «all»
  day          date NOT NULL,
  focus        text NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_key, day)
);

INSERT INTO automation_rules (key, name, description, autonomy, allowed_autonomy, params, position) VALUES
  ('meeting_recap',
   'Tras una reunión: resumen y próximos pasos',
   'Cuando una demo, llamada o reunión de un deal se marca como celebrada, prepara el correo al contacto con el resumen, los próximos pasos y tus huecos para la siguiente sesión. Con la IA configurada, lo redacta a partir de tus notas o de la transcripción.',
   'ask', ARRAY['off', 'ask', 'auto'],
   '{"subject": "Resumen de nuestra {sesion}: {deal}", "body": "Hola {nombre},\n\nGracias por tu tiempo. Te dejo un resumen de lo que hablamos:\n\n{resumen}\n\nPróximos pasos:\n{proximos_pasos}\n\nPara seguir, te propongo estos huecos:\n{huecos}\n\nUn saludo,\n{responsable}"}', 6),
  ('advance_after_session',
   'Sesión de la fase celebrada: pasar de fase',
   'Cuando se celebra la sesión que pide la fase (por ejemplo, la demo en «Demo solicitada»), propone mover el deal a la fase siguiente.',
   'ask', ARRAY['off', 'ask', 'auto'],
   '{}', 7);

COMMIT;
