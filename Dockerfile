# Imagen de producción de la app Next.js (salida "standalone").
# Escucha en 0.0.0.0:$PORT (3000 por defecto) y aplica las migraciones al arrancar.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# El servidor de producción es pequeño: que la compilación no se coma toda la memoria.
ENV NODE_OPTIONS=--max-old-space-size=2048
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    TZ=Europe/Madrid
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Migraciones al arrancar (scripts/start.sh): el script, las migraciones y su cliente de Postgres.
COPY --from=build --chown=node:node /app/db/migrations ./db/migrations
COPY --from=build --chown=node:node /app/scripts/db.mjs /app/scripts/password.mjs /app/scripts/start.sh ./scripts/
COPY --from=deps --chown=node:node /app/node_modules/postgres ./node_modules/postgres
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/v1/health" >/dev/null || exit 1
CMD ["sh", "scripts/start.sh"]
