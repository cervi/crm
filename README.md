# CRM

CRM propio para sustituir Pipedrive y Apollo: empresas, contactos, leads, deals en varios pipelines, actividades, campos personalizados, una API para conectar formularios y una IA que sigue los deals con la autonomía que tú le des. En siguientes fases: agentes externos (Grok Bot) por MCP, IA integrada para redactar y decidir, secuencias de email e importación desde Pipedrive.

Tecnología: **Next.js 16 + TypeScript + PostgreSQL**, empaquetado con Docker para desplegarlo igual en AWS, en Vercel o en cualquier otro proveedor.

## Qué hace hoy

| Módulo | Funciones |
| --- | --- |
| **Hoy** | La portada: el parte del día de todo el equipo o de cada persona. Incluye lo que hay que decidir, las reuniones y tareas de hoy, lo vencido, los deals que piden atención con su siguiente paso, lo que hizo la IA y las novedades, con un «enfoque del día» redactado por la IA. Cada mañana (hora y días configurables) llega también al correo de quien tenga su cuenta conectada. |
| **Navegación** | Menú lateral colapsado; buscador global de deals, contactos, empresas y leads (⌘K / Ctrl+K); botón «+» para crear; apariencia clara, oscura o según el sistema en el menú de usuario. |
| **Dashboards** | Dashboards personalizables con widgets: qué medir (deals, leads, actividades), métrica, agrupación (fase, origen, responsable, motivo, campos personalizados, semana, mes…), periodo y filtros; cifra con comparación, barras, línea o tabla. Editor con vista previa en directo. |
| **Deals** | Varios pipelines con su tablero o en lista; selector de pipeline y edición de sus fases; ordenar tarjetas; arrastrar entre fases; panel lateral del deal sin salir del tablero (anterior/siguiente, Esc, J/K); aviso de deals parados y sin sesión agendada; ficha con barra de fases, contactos del deal, actividades, notas, recorrido por fases e historial; ganar, perder (con motivo y tarea de seguimiento automática) y reabrir. |
| **Leads** | Listado con filtros por estado, origen y etapa (TOFU/MOFU/BOFU); alta manual; conversión a deal conservando el historial. |
| **Empresas y contactos** | Listados con búsqueda, fichas y formularios; contactos actuales y antiguos; cambio de empresa conservando el historial; consentimiento RGPD. |
| **Actividades** | Llamadas, demos, videollamadas, tareas…; resultado («no se presentó», etc.); bandeja de vencidas, hoy y próximas. |
| **Ajustes** | Pipelines y fases (orden, días para considerarse parado, sesión requerida), campos personalizados en las cuatro entidades y motivos de pérdida. |
| **API de entrada** | `POST /api/v1/leads` para formularios, webinars, Zapier o Make: deduplica contactos por email y empresas por dominio; las solicitudes de demo crean el deal. Documentación dentro de la app, en Ajustes → Conectar formularios. |
| **Tipos de actividad y reglas propias** | Los tipos de actividad se configuran en Ajustes (y cuáles son sesiones con el cliente). En «Tus reglas» se crean reglas del tipo «cuando una actividad de tal tipo se hace (con tal resultado) o no se hace a tiempo, la IA crea otra actividad, escribe al contacto, mueve el deal de fase o te pide una decisión», con la autonomía de siempre. |
| **Resúmenes automáticos** | Cada deal tiene arriba su resumen, sus riesgos y el siguiente paso recomendado con cuándo toca; al pasar el ratón, quién lo hará (tú, la IA sola o la IA con tu visto bueno), cómo y por qué (responder un correo pendiente, marcar cómo fue una reunión, completar lo vencido, agendar la sesión de la fase…). Tras cada reunión, la IA prepara el correo al cliente con el resumen, los próximos pasos y tus huecos (puedes pegar la transcripción), y propone pasar de fase si era la sesión que pedía la fase. El traspaso a Customer Success también lo redacta la IA y, además de la tarea, sale por correo al responsable de CS de la empresa (en su ficha) o a la dirección de CS por defecto (en la regla), con autonomía configurable: «Preguntar» para validarlo o «Sola» para que salga al ganar. |
| **Modelo de IA** | Proveedor (Anthropic, OpenAI, xAI/Grok u otro compatible), modelo, clave cifrada y prompts editables para cada resumen. Opcional: sin él, todo funciona con resúmenes por reglas; si el modelo falla, se vuelve a las reglas y el error se ve en Ajustes. |
| **IA con autonomía configurable** | Para cada tipo de acción (crear tareas, escribir notas, preparar correos, mover de fase, editar deals) y cada agente (el asistente del CRM o agentes externos), eliges: **No**, **Preguntar** (lo deja en la bandeja de decisiones) o **Sola** (lo hace y queda en el registro, con «Deshacer»). Reglas incluidas: fase sin su sesión agendada → tarea; deal parado → correo de seguimiento; «no se presentó» → correo para reagendar; deal muy parado → te pide decidir; deal ganado → tarea de traspaso a Customer Success con el resumen. Cada regla tiene sus días y plantillas, estadísticas de aprobación y sugerencias para subir o bajar su autonomía. Pausa general y «Revisar ahora». |
| **Correo, calendario y documentos** | Cada usuario puede conectar su cuenta de **Microsoft 365** (Outlook, calendario, OneDrive/SharePoint) o de **Google Workspace** (Gmail, Google Calendar, Drive). Los correos del CRM (los que escribes en la ficha del deal y los que propone o envía la IA) salen desde su correo y quedan en «Enviados». Los correos y reuniones con contactos del CRM se registran solos en sus deals (sin duplicar). La IA ofrece tus huecos libres (`{huecos}`) según tu horario, duración, margen y antelación; al programar una actividad puedes invitar al contacto desde tu calendario con Teams o Meet. En cada deal, «Documentos» enlaza presentaciones y propuestas buscándolas en tu Drive/OneDrive o pegando un enlace. Accesos cifrados en la base de datos. Todo es opcional: sin configurar nada, el CRM funciona igual. |
| **Exportar a CSV** | Botón «Exportar CSV» en deals (tablero y lista, con sus filtros), leads, empresas, contactos, actividades, historia de cada deal, registro de la IA y cada widget de los dashboards; exportación completa en Ajustes → Exportar datos. UTF-8 con BOM para Excel, separador configurable (punto y coma por defecto), campos personalizados como columnas y protección contra fórmulas. |
| **Historial** | Todo queda registrado como evento (quién, qué y cuándo): es el historial de cada ficha y será la base de las automatizaciones y de la auditoría de la IA. |

## Probarlo en local (un comando)

Requisito: Node.js 22 o superior.

```bash
npm install
npm run demo                  # http://localhost:3000 — Ctrl+C para parar
npm run demo -- --reset       # vuelve a los datos de ejemplo
npm run demo -- --ia-simulada # con una IA simulada ya configurada
```

Arranca la base de datos con datos de ejemplo, Microsoft 365 y Google simulados (se puede pulsar «Conectar» y enviar sin tocar cuentas reales) y la aplicación. Los datos se guardan en `.demo-data/`. Para resúmenes de verdad, pon tu clave en Ajustes → Modelo de IA.

## Arrancar en local (desarrollo)

Requisito: Node.js 22 o superior. No hace falta Docker ni instalar PostgreSQL.

```bash
npm install
cp .env.example .env
npm run db:dev          # terminal 1: PostgreSQL de desarrollo (PGlite), déjala abierta
npm run db:migrate      # terminal 2
npm run db:seed         # datos de ejemplo (opcional)
npm run dev             # http://localhost:3000
```

`npm run db:dev` arranca un PostgreSQL que corre dentro de Node (PGlite) y guarda los datos en `.pgdata/`. Es solo para desarrollo; en producción se usa un PostgreSQL normal.

## Producción

```bash
SETUP_CODE='…' INBOUND_API_KEYS='…' docker compose up --build -d
```

Variables (ver `.env.example`):

| Variable | Para qué |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 13 o superior. |
| `SETUP_CODE` | Código para crear el primer administrador en `/setup` (solo se pide en producción y solo mientras nadie tenga contraseña). Después, el resto del equipo se da de alta en Ajustes → Usuarios y permisos. También se puede crear un usuario desde la terminal: `node scripts/db.mjs user EMAIL CONTRASEÑA admin`. |
| `ALLOW_PRIVATE_WEBHOOKS` | Opcional. Con `1`, los webhooks de las automatizaciones pueden apuntar a direcciones internas o `http://` (por defecto, en producción solo `https://` públicas). |
| `INBOUND_API_KEYS` | Claves de la API de entrada, separadas por comas (mínimo 16 caracteres). |
| `TZ` | Zona horaria de las fechas (por defecto `Europe/Madrid`). |
| `AUTOMATIONS_INTERVAL_MINUTES` | Cada cuántos minutos revisa la IA los deals (15 por defecto; `0` lo desactiva). |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT_ID` | Opcional. App registrada en Microsoft Entra para conectar Microsoft 365 (pasos en Ajustes → Correo, calendario y documentos). |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Opcional. Credenciales OAuth de Google Cloud para conectar Google Workspace (mismos pasos en Ajustes). |
| `APP_URL` | Dirección pública del CRM; los proveedores vuelven a `APP_URL/api/integrations/<microsoft|google>/callback`. |
| `TOKEN_ENCRYPTION_KEY` | Clave aleatoria (32+ caracteres) con la que se cifran los accesos guardados. Si se cambia, hay que volver a conectar las cuentas. |
| `CRON_SECRET` | Para alojamientos sin procesos permanentes (Vercel): un cron llama a `POST /api/v1/automations/run` con `Authorization: Bearer <CRON_SECRET>`. |

Las migraciones se aplican con `node scripts/db.mjs migrate` (el servicio `migrate` del docker-compose lo hace al arrancar).

## Pruebas

```bash
npm run check
```

Arranca una base de datos temporal y ejecuta, en orden:

1. Las migraciones, los datos de ejemplo y las 13 comprobaciones del modelo.
2. La comprobación de tipos y la compilación.
3. 139 pruebas de extremo a extremo contra la app arrancada: todas las pantallas, los 404, la protección de acceso, la API de entrada con deduplicación y envíos simultáneos, el motor de automatizaciones (reglas, permisos como techo, caducidad, pausa) y el correo, calendario y documentos contra Microsoft 365 y Google simulados (`scripts/mock-providers.mjs`): conexión OAuth con PKCE, huecos libres, sincronización sin duplicados, envío automático (también con acentos por Gmail), búsqueda en Drive, renovación y revocación del acceso.
4. Si Playwright está instalado, 47 pruebas con navegador: formularios y sus errores, buscadores, arrastrar en el tablero, ganar/perder, campos personalizados, ajustes, leads, cambio de empresa, y la bandeja de la IA (aprobar un correo editado, descartar, deshacer, autonomía y pausa) y las cuentas conectadas (conectar Microsoft 365 y Google, preferencias, escribir con tus huecos, enviar una propuesta, enlazar documentos e invitar desde el calendario).

## Base de datos

SQL puro en `db/migrations/`, aplicado con `scripts/db.mjs` (`npm run db:migrate | db:seed | db:test | db:reset`).

- **organizations**: empresas, deduplicadas por dominio.
- **persons**: contactos, con varios emails y teléfonos. El email es único y sirve para deduplicar. Incluyen consentimiento y baja para el RGPD.
- **person_organizations**: relación contacto–empresa con historial (`current` / `former`).
- **leads**: origen (`source`, `source_detail`) y etapa TOFU/MOFU/BOFU. Al convertirse, el lead apunta a su deal y el deal a su lead.
- **pipelines** y **stages**: cada fase define cuándo un deal está parado (`rotten_after_days`) y qué sesión toca (`required_activity_type`).
- **deals**: varios por empresa, cada uno con su pipeline, fase, estado, importe, productos y contactos (`deal_participants`). La base de datos garantiza que la fase pertenece al pipeline del deal.
- **deal_stage_history**: cada cambio de fase (lo rellena un trigger), para medir tiempos de conversión.
- **lost_reasons**: motivos de pérdida con días de seguimiento.
- **activities** y **notes**. Las actividades guardan el resultado, la transcripción y el resumen.
- **tags**, **products**.
- **custom_field_definitions**: definiciones de campos personalizados. Los valores se guardan en la columna `custom` (jsonb) de cada entidad.
- **events**: registro de todo lo que pasa (persona, IA, sistema o integración). Las reglas que se disparan con un evento lo leen de aquí.
- **ai_permissions**: autonomía máxima por agente y tipo de acción.
- **automation_rules**: reglas, su autonomía y sus parámetros.
- **ai_settings**, **deal_briefs**, **digest_focus**, **digest_log**: modelo de IA, resúmenes de deals en caché, enfoque del día y partes enviados.
- **mailbox_connections**: cuenta conectada de cada usuario (Microsoft 365 o Google), con los accesos cifrados y sus preferencias de huecos.
- **deal_documents**: documentos enlazados a cada deal (Drive, OneDrive o enlace).
- **automation_actions**: cada propuesta o acción de la IA; es a la vez la bandeja de decisiones y el registro, con lo necesario para deshacer.
- **open_deals_status** (vista): días en la fase, si el deal está parado y si tiene la sesión requerida agendada.

Las tablas principales tienen `pipedrive_id` para que la importación desde Pipedrive se pueda relanzar sin duplicar datos.

## Pendiente

- [ ] Inicio de sesión por usuario (sustituye al usuario y contraseña común) y asignar las acciones a cada persona
- [ ] Importación desde Pipedrive
- [x] Motor de automatizaciones con autonomía configurable, bandeja de decisiones y registro con deshacer
- [x] Seguimiento automático de deals (sesiones por fase, ausencias, deals parados)
- [x] Traspaso a Customer Success al ganar un deal (resumen con plantilla)
- [ ] Conexión de agentes externos (Grok Bot…) por MCP, con los mismos permisos
- [x] IA integrada configurable (proveedor, modelo, clave y prompts) para resúmenes, parte del día y seguimiento tras reuniones
- [ ] Agente de IA que decide (proponer acciones libres más allá de las reglas)
- [x] Correo, calendario y documentos de Microsoft 365 y Google Workspace (opcional)
- [ ] Secuencias de email y enriquecimiento
