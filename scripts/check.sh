#!/usr/bin/env bash
# Comprobación completa en local, sin Docker: base de datos de desarrollo
# temporal, migraciones + datos de ejemplo + comprobaciones del modelo,
# tipos, compilación y pruebas de extremo a extremo contra la app arrancada.
#
#   npm run check
set -euo pipefail
cd "$(dirname "$0")/.."

DB_PORT="${CHECK_DB_PORT:-55432}"
APP_PORT="${CHECK_APP_PORT:-3999}"
DATA_DIR="$(mktemp -d)"
export DATABASE_URL="postgres://crm:crm@127.0.0.1:${DB_PORT}/crm"
export INBOUND_API_KEYS="clave-de-pruebas-0123456789"
export TZ="${TZ:-Europe/Madrid}" NEXT_TELEMETRY_DISABLED=1
# Las pruebas lanzan el motor de automatizaciones a mano, no con el temporizador.
export AUTOMATIONS_INTERVAL_MINUTES=0 CRON_SECRET="secreto-de-pruebas-0123456789"
# Microsoft 365 y Google simulados (scripts/mock-providers.mjs) para correo, calendario y documentos.
MOCK_PORT="${CHECK_MOCK_PORT:-3998}"
export MS_CLIENT_ID="cliente-de-pruebas" MS_CLIENT_SECRET="secreto-cliente-de-pruebas" MS_TENANT_ID="inquilino-de-pruebas"
export MS_LOGIN_URL="http://127.0.0.1:${MOCK_PORT}" MS_GRAPH_URL="http://127.0.0.1:${MOCK_PORT}/v1.0" MOCK_URL="http://127.0.0.1:${MOCK_PORT}"
export GOOGLE_CLIENT_ID="cliente-google-de-pruebas" GOOGLE_CLIENT_SECRET="secreto-google-de-pruebas"
export PIPEDRIVE_API_URL="http://127.0.0.1:${MOCK_PORT}"
export GOOGLE_AUTH_URL="http://127.0.0.1:${MOCK_PORT}/o/oauth2/v2/auth" GOOGLE_TOKEN_URL="http://127.0.0.1:${MOCK_PORT}/token" GOOGLE_API_BASE="http://127.0.0.1:${MOCK_PORT}"
export TOKEN_ENCRYPTION_KEY="clave-de-cifrado-de-pruebas-0123456789abcdef"

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$DATA_DIR"; }
trap cleanup EXIT

echo "▸ Base de datos de desarrollo (puerto ${DB_PORT})"
DEV_DB_PORT="$DB_PORT" DEV_DB_DIR="$DATA_DIR" node scripts/dev-db.mjs > "$DATA_DIR.db.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 50); do grep -q "PostgreSQL de desarrollo" "$DATA_DIR.db.log" 2>/dev/null && break; sleep 0.2; done

echo "▸ Migraciones, datos de ejemplo y comprobaciones del modelo"
node scripts/db.mjs reset

echo "▸ Tipos"
# Los tipos que genera Next de una compilación anterior pueden apuntar a rutas que ya no existen.
rm -rf .next/types .next/dev/types
npx tsc --noEmit

echo "▸ Compilación"
npx next build > "$DATA_DIR.build.log" 2>&1 || { cat "$DATA_DIR.build.log"; exit 1; }

echo "▸ Pruebas de extremo a extremo"
MOCK_PORT="$MOCK_PORT" node scripts/mock-providers.mjs > "$DATA_DIR.mock.log" 2>&1 &
pids+=($!)
export APP_URL="http://127.0.0.1:${APP_PORT}"
# Igual que en producción: servidor "standalone" con sus ficheros estáticos.
cp -R .next/static .next/standalone/.next/ && cp -R public .next/standalone/
PORT="$APP_PORT" HOSTNAME=127.0.0.1 node .next/standalone/server.js > "$DATA_DIR.app.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 100); do curl -s -o /dev/null "http://127.0.0.1:${APP_PORT}/login" && break; sleep 0.2; done
BASE_URL="http://127.0.0.1:${APP_PORT}" node scripts/e2e.mjs || { echo "--- registro de la app:"; tail -40 "$DATA_DIR.app.log"; exit 1; }
if grep -qiE "error|unhandled" "$DATA_DIR.app.log"; then
  echo "--- avisos en el registro de la app:"; grep -iE "error|unhandled" "$DATA_DIR.app.log" | head -20
fi

# Pruebas con navegador, si Playwright está instalado (npm i -D playwright && npx playwright install chromium).
if node -e "require.resolve('playwright')" 2>/dev/null; then
  echo "▸ Pruebas con navegador"
  node scripts/db.mjs reset > /dev/null
  curl -s -X POST "http://127.0.0.1:${MOCK_PORT}/__reset" > /dev/null
  BASE_URL="http://127.0.0.1:${APP_PORT}" node scripts/ui-check.mjs
else
  echo "▸ (Pruebas con navegador omitidas: Playwright no está instalado)"
fi
