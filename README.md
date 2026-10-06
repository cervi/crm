# CRM

CRM propio para sustituir Pipedrive y Apollo: empresas, contactos, leads, deals en varios pipelines, actividades, campos personalizados y una API para conectar formularios. En siguientes fases: automatizaciones, agentes de IA, secuencias de email e importación desde Pipedrive.

Tecnología: **Next.js 16 + TypeScript + PostgreSQL**, empaquetado con Docker para desplegarlo igual en AWS, en Vercel o en cualquier otro proveedor.

## Qué hace hoy

| Módulo | Funciones |
| --- | --- |
| **Navegación** | Menú lateral colapsado; buscador global de deals, contactos, empresas y leads (⌘K / Ctrl+K); botón «+» para crear; apariencia clara, oscura o según el sistema en el menú de usuario. |
| **Dashboards** | Dashboards personalizables con widgets: qué medir (deals, leads, actividades), métrica, agrupación (fase, origen, responsable, motivo, campos personalizados, semana, mes…), periodo y filtros; cifra con comparación, barras, línea o tabla. Editor con vista previa en directo. |
| **Deals** | Varios pipelines con su tablero o en lista; selector de pipeline y edición de sus fases; ordenar tarjetas; arrastrar entre fases; panel lateral del deal sin salir del tablero (anterior/siguiente, Esc, J/K); aviso de deals parados y sin sesión agendada; ficha con barra de fases, contactos del deal, actividades, notas, recorrido por fases e historial; ganar, perder (con motivo y tarea de seguimiento automática) y reabrir. |
| **Leads** | Listado con filtros por estado, origen y etapa (TOFU/MOFU/BOFU); alta manual; conversión a deal conservando el historial. |
| **Empresas y contactos** | Listados con búsqueda, fichas y formularios; contactos actuales y antiguos; cambio de empresa conservando el historial; consentimiento RGPD. |
| **Actividades** | Llamadas, demos, videollamadas, tareas…; resultado («no se presentó», etc.); bandeja de vencidas, hoy y próximas. |
| **Ajustes** | Pipelines y fases (orden, días para considerarse parado, sesión requerida), campos personalizados en las cuatro entidades y motivos de pérdida. |
| **API de entrada** | `POST /api/v1/leads` para formularios, webinars, Zapier o Make: deduplica contactos por email y empresas por dominio; las solicitudes de demo crean el deal. Documentación dentro de la app, en Ajustes → Conectar formularios. |
| **Historial** | Todo queda registrado como evento (quién, qué y cuándo): es el historial de cada ficha y será la base de las automatizaciones y de la auditoría de la IA. |

## Arrancar en local

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
BASIC_AUTH_USER=equipo BASIC_AUTH_PASSWORD='…' INBOUND_API_KEYS='…' docker compose up --build -d
```

Variables (ver `.env.example`):

| Variable | Para qué |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 13 o superior. |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` | Acceso a la aplicación. **Obligatorias en producción**: sin ellas la app no se sirve. Es una protección provisional hasta tener inicio de sesión por usuario. |
| `INBOUND_API_KEYS` | Claves de la API de entrada, separadas por comas (mínimo 16 caracteres). |
| `TZ` | Zona horaria de las fechas (por defecto `Europe/Madrid`). |

Las migraciones se aplican con `node scripts/db.mjs migrate` (el servicio `migrate` del docker-compose lo hace al arrancar).

## Pruebas

```bash
npm run check
```

Arranca una base de datos temporal y ejecuta, en orden:

1. Las migraciones, los datos de ejemplo y las 13 comprobaciones del modelo.
2. La comprobación de tipos y la compilación.
3. 76 pruebas de extremo a extremo contra la app arrancada: todas las pantallas, los 404, la protección de acceso, y la API de entrada con deduplicación y envíos simultáneos.
4. Si Playwright está instalado, 23 pruebas con navegador: formularios y sus errores, buscadores, arrastrar en el tablero, ganar/perder, campos personalizados, ajustes, leads y cambio de empresa.

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
- **events**: registro de todo lo que pasa (persona, IA, sistema o integración).
- **open_deals_status** (vista): días en la fase, si el deal está parado y si tiene la sesión requerida agendada.

Las tablas principales tienen `pipedrive_id` para que la importación desde Pipedrive se pueda relanzar sin duplicar datos.

## Pendiente

- [ ] Inicio de sesión por usuario (sustituye al usuario y contraseña común) y asignar las acciones a cada persona
- [ ] Importación desde Pipedrive
- [ ] Motor de automatizaciones («cuando pase X, haz Y») sobre el registro de eventos
- [ ] Agentes de IA configurables (modelo, clave y prompts) y bandeja de acciones
- [ ] Seguimiento automático de deals (sesiones por fase, ausencias, reagendar)
- [ ] Resumen automático para Customer Success al ganar un deal
- [ ] Secuencias de email, enriquecimiento y dashboards
