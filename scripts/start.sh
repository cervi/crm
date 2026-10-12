#!/bin/sh
# Arranque en producción: aplica las migraciones pendientes y levanta el servidor.
set -e
node scripts/db.mjs migrate
exec node server.js
