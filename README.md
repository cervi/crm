# CRM

CRM propio para sustituir Pipedrive y Apollo: empresas, contactos, deals en varios pipelines, campos personalizados y, en siguientes fases, automatizaciones, agentes de IA y secuencias de email.

Tecnología: **Next.js + TypeScript + PostgreSQL**, empaquetado con Docker para poder desplegarlo igual en AWS, en Vercel o en cualquier otro proveedor.

## Arrancar en local

Requisitos: Docker y Node.js 22.

```bash
docker compose up -d db migrate       # base de datos + migraciones
DATABASE_URL=postgres://crm:crm@localhost:5432/crm ./scripts/db.sh seed   # datos de ejemplo (opcional)
cp .env.example .env
npm install
npm run dev                            # http://localhost:3000
```

Todo con Docker (sin Node en local): `docker compose up --build`.

## Base de datos

Las migraciones son SQL puro en `db/migrations/` y se aplican con `scripts/db.sh` (solo necesita `psql`).

| Comando | Qué hace |
| --- | --- |
| `./scripts/db.sh migrate` | Aplica las migraciones pendientes |
| `./scripts/db.sh seed` | Carga los datos de ejemplo (solo desarrollo) |
| `./scripts/db.sh test` | Ejecuta las comprobaciones del modelo (`db/tests`) |
| `./scripts/db.sh reset` | Borra todo, migra, carga ejemplos y comprueba (solo desarrollo) |

### Modelo de datos

- **organizations** (empresas): deduplicadas por dominio.
- **persons** (contactos): varios emails y teléfonos; el email es único y sirve para deduplicar. Consentimiento y baja para RGPD.
- **person_organizations**: relación contacto–empresa con historial. Quien deja una empresa pasa a `former` y conserva todo; puede tener una relación `current` con su nueva empresa.
- **leads**: contactos que aún no son oportunidad, con origen (`source`, `source_detail`) y etapa TOFU/MOFU/BOFU. Al convertirse apuntan a su deal (`converted_deal_id`) y el deal a su lead (`lead_id`), sin perder historial.
- **pipelines** y **stages**: varios pipelines, cada uno con sus fases. Cada fase define cuándo un deal se considera parado (`rotten_after_days`) y qué sesión debe celebrarse en ella (`required_activity_type`).
- **deals**: varios por empresa, cada uno con su pipeline, fase, estado (`open`/`won`/`lost`), importe, productos y contactos asociados (`deal_participants`). La base de datos garantiza que la fase pertenece al pipeline del deal.
- **deal_stage_history**: cada cambio de fase, para medir tiempos de conversión. Lo rellena un trigger.
- **lost_reasons**: motivos de pérdida con días de seguimiento (`followup_days`).
- **activities**: llamadas, demos, videollamadas, tareas… con resultado (`held`, `no_show`…), transcripción y resumen.
- **notes**, **tags** (con tablas de unión por entidad) y **products**.
- **custom_field_definitions**: campos personalizados por entidad; los valores se guardan en la columna `custom` (jsonb) de cada entidad.
- **events**: registro de todo lo que pasa (quién, qué, cuándo; persona, IA o sistema). Es el historial, la auditoría de la IA y la fuente del futuro motor de automatizaciones.
- **open_deals_status** (vista): deals abiertos con días en la fase, si están parados y si tienen la sesión requerida agendada.

Las tablas principales tienen `pipedrive_id` para que la importación desde Pipedrive se pueda relanzar sin duplicar datos.

## Estado

- [x] Modelo de datos con migración, datos de ejemplo y 13 comprobaciones automáticas
- [x] Esqueleto de la app: conexión a la base de datos y tablero de deals por pipeline (solo lectura)
- [ ] Fichas y formularios de empresas, contactos y deals
- [ ] Arrastrar deals entre fases, ganar/perder
- [ ] Configuración de pipelines y campos personalizados
- [ ] Entrada de leads (API para formularios) y deduplicación
- [ ] Importación desde Pipedrive
