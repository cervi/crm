# Despliegue del CRM en Nailted Tools (Coolify)

Instrucciones para el agente que despliega. Siguen las reglas de Nailted Tools: solo subdominios de `tools.nailted.com`, no tocar recursos ajenos ni ajustes del servidor, secretos solo en las variables de Coolify y, si algo falla, parar y avisar.

> **Requisito previo.** Jose debe haber aprobado este despliegue.
> **Regla dura: NO SE ENVÍA NADA A NADIE.** La app se despliega siempre con `OUTBOUND_DISABLED=1`. No quitar esa variable sin permiso explícito de Jesús y de Jose.

## Qué es

- **App:** Next.js 16 (salida standalone) con `Dockerfile` en la raíz del repo.
  - Escucha en `0.0.0.0:$PORT`, que por defecto es 3000.
  - Al arrancar aplica las migraciones de la base de datos (`scripts/start.sh`).
  - Corre sin root.
- **Comprobación de salud:** `GET /api/v1/health` responde `{"ok":true,"db":true}`. No necesita sesión.
- **Datos:** todo vive en Postgres, incluidos los archivos adjuntos (bytea). La app no necesita volumen persistente; lo único que hay que proteger es la base de datos y sus copias.
- **Memoria:** unos 500 MB en marcha. Al compilar llega a unos 2 GB unos minutos (`NODE_OPTIONS=--max-old-space-size=2048` en la etapa de build).

## Pasos

1. **Proyecto y servidor.** Busca el uuid del proyecto «Nailted Tools» (`GET /projects`) y el del único servidor (`GET /servers`). Usa el entorno `production`.

2. **Base de datos.** Crea una PostgreSQL 16 en ese proyecto y entorno (`POST /databases/postgresql`):
   - nombre `crm-db`, sin acceso público;
   - activa la copia programada diaria;
   - apunta la URL interna, que será el `DATABASE_URL`.

3. **Aplicación.** Créala desde el repo privado mediante la GitHub App (`POST /applications/private-github-app`). Si la GitHub App no tiene acceso a `cervi/crm`, para y pide a Jose que se lo dé.

   | Campo | Valor |
   |---|---|
   | `name` | `crm` |
   | `git_repository` | `cervi/crm` |
   | `git_branch` | `main` |
   | `build_pack` | `dockerfile` |
   | `ports_exposes` | `3000` |
   | `domains` | `https://crm.tools.nailted.com` |
   | Health check (si se configura) | ruta `/api/v1/health`, puerto 3000 |

4. **Variables de entorno** (`POST /applications/{uuid}/envs`). Genera tú los secretos aleatorios, sin mostrarlos ni guardarlos fuera de Coolify.

   | Variable | Valor | Para qué |
   |---|---|---|
   | `DATABASE_URL` | URL interna de `crm-db` | Base de datos |
   | `APP_URL` | `https://crm.tools.nailted.com` | Enlaces y cookies seguras |
   | `OUTBOUND_DISABLED` | `1` | **Obligatoria.** Bloquea todo envío: correos, invitaciones de calendario y webhooks |
   | `SWITCHES_OFF` | `sequences,campaigns,automations,pipedrive_sync,web_enrichment,public_pages,inbound_api` | Módulos apagados y bloqueados al empezar |
   | `TOKEN_ENCRYPTION_KEY` | 48 caracteres aleatorios | Cifra las conexiones de correo. **No cambiarla nunca** después |
   | `SETUP_CODE` | 24 caracteres aleatorios | Código para crear el primer administrador. Pásaselo a Jesús por un canal privado |
   | `TZ` | `Europe/Madrid` | Zona horaria |
   | `DB_POOL_MAX` | `5` | El servidor es pequeño |
   | `AUTOMATIONS_INTERVAL_MINUTES` | `15` | Revisión periódica, casi toda apagada por `SWITCHES_OFF` |
   | `SEQUENCE_SEND_SECONDS` | `0` | Apaga el bucle de secuencias de cada minuto |

   Más adelante, solo si Jose lo aprueba:
   - `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`, para entrar con Google y leer correo y calendario. La URL de redirección autorizada en Google Cloud es `https://crm.tools.nailted.com/api/integrations/google/callback`.

   No hace falta definir:
   - `INBOUND_API_KEYS` ni `CRON_SECRET`: sin ellas, la API de entrada y el cron externo quedan cerrados.
   - Variables de IA: la clave de IA se mete desde la propia app (Ajustes → Modelo de IA).

5. **Desplegar** (`GET /deploy?uuid={uuid}`). Sigue el estado (`GET /deployments/{uuid}`) y los registros (`GET /applications/{uuid}/logs`). En el arranque deben aparecer `→ aplicando 00xx_…` y `✓ migraciones al día`.

6. **Comprobar:**
   - `curl -I https://crm.tools.nailted.com/login` responde 200.
   - `curl https://crm.tools.nailted.com/api/v1/health` responde `{"ok":true,"db":true}`.
   - Un 502 suele ser el puerto o la escucha en localhost; la imagen ya escucha en `0.0.0.0:3000`.

7. **Primer acceso** (lo hace Jesús): entrar en `https://crm.tools.nailted.com/setup` con el `SETUP_CODE` y crear su administrador. Después, en Ajustes → Interruptores debe aparecer «Modo sin envíos» y los tres módulos de salida como «Bloqueado por el servidor».

## Lo que NO se hace en este despliegue

- No importar datos de clientes (Pipedrive) hasta que Jose lo apruebe expresamente. Cuando lo apruebe, la importación la hace Jesús desde la app, y su token de Pipedrive solo se introduce en la pantalla.
- No quitar `OUTBOUND_DISABLED` ni encender módulos de `SWITCHES_OFF`.
- No exponer la base de datos ni tocar otros recursos, el proxy o los ajustes de Coolify.
- Si algo no está claro o falla, parar y avisar a Jesús y a Jose.

## Actualizaciones

Cada cambio en `main` se publica con un nuevo despliegue de la misma app. Las migraciones se aplican solas al arrancar. Para apagarlo todo de golpe, la app tiene una «parada general» en Ajustes → Interruptores; también se puede forzar desde el servidor con `SWITCHES_OFF=all`.
