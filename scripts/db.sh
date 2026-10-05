#!/usr/bin/env bash
# Utilidades de base de datos sin dependencias (solo psql).
#
#   ./scripts/db.sh migrate   Aplica las migraciones pendientes de db/migrations
#   ./scripts/db.sh seed      Carga los datos de ejemplo (solo desarrollo)
#   ./scripts/db.sh test      Ejecuta las comprobaciones del modelo
#   ./scripts/db.sh reset     Borra todo y vuelve a migrar + seed + test (solo desarrollo)
#
# Usa DATABASE_URL (por defecto, la base de datos del docker-compose).
set -euo pipefail

cd "$(dirname "$0")/.."
DATABASE_URL="${DATABASE_URL:-postgres://crm:crm@localhost:5432/crm}"
PSQL=(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -X)

migrate() {
  "${PSQL[@]}" -c "SET client_min_messages = warning; CREATE TABLE IF NOT EXISTS schema_migrations (
                     version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
  for f in db/migrations/*.sql; do
    v="$(basename "$f" .sql)"
    applied="$("${PSQL[@]}" -tAc "SELECT 1 FROM schema_migrations WHERE version = '$v'")"
    if [[ -z "$applied" ]]; then
      echo "→ aplicando $v"
      "${PSQL[@]}" -f "$f"
      "${PSQL[@]}" -c "INSERT INTO schema_migrations (version) VALUES ('$v')"
    fi
  done
  echo "✓ migraciones al día"
}

seed() { "${PSQL[@]}" -f db/seed/demo.sql && echo "✓ datos de ejemplo cargados"; }

test_db() {
  out="$("${PSQL[@]}" -f db/tests/core_test.sql 2>&1)" || { echo "$out" | grep -E "FALLO|ERROR"; exit 1; }
  echo "$out" | grep -o "OK  · .*"
  echo "✓ $(echo "$out" | grep -c 'OK  ·') comprobaciones superadas"
}

reset() {
  "${PSQL[@]}" -c "SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
  migrate && seed && test_db
}

case "${1:-}" in
  migrate) migrate ;;
  seed)    seed ;;
  test)    test_db ;;
  reset)   reset ;;
  *) echo "uso: $0 {migrate|seed|test|reset}"; exit 2 ;;
esac
