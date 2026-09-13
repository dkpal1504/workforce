# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

FROM dependencies AS build
COPY apps/api apps/api
COPY apps/web apps/web
COPY packages/shared packages/shared
# Guard: the image must be built from the PostgreSQL schema. Local development
# switches apps/api/prisma/schema.prisma to `sqlite` (see
# apps/api/prisma/schema.postgresql.prisma); shipping that variant would generate a
# SQLite client and a SQLite datasource for a PostgreSQL deployment. Fail the build
# instead of deploying something that cannot work.
RUN set -eux; \
    schema="apps/api/prisma/schema.prisma"; \
    tr -d '\r' < "$schema" > /tmp/schema.check; \
    provider="$(sed -n '/^datasource/,/}/p' /tmp/schema.check | sed -n 's/.*provider *= *"\([a-z]*\)".*/\1/p')"; \
    echo "datasource provider in $schema: '${provider}'"; \
    if [ "$provider" != "postgresql" ]; then \
      printf '%s\n' \
        "ERROR: $schema declares the '${provider}' datasource provider." \
        "Production images must be built from the PostgreSQL schema." \
        "Restore it with:  cp apps/api/prisma/schema.postgresql.prisma apps/api/prisma/schema.prisma" \
        "(and set DATABASE_URL back to the PostgreSQL URL in .env)."; \
      exit 1; \
    fi
RUN npm run db:generate -w @workforce/api \
 && npm run build -w @workforce/shared \
 && npm run build -w @workforce/api \
 && npm run build -w @workforce/web

FROM dependencies AS migrate
ENV NODE_ENV=production
COPY apps/api/prisma apps/api/prisma
# The migration SQL under prisma/migrations is PostgreSQL dialect, so pin the
# datasource explicitly. This also overrides the sqlite provider used for local
# development, and makes the migrate step independent of the committed provider.
ENV DATABASE_PROVIDER=postgresql
RUN set -eux; \
    schema="apps/api/prisma/schema.prisma"; \
    tr -d '\r' < "$schema" > /tmp/schema.check; \
    sed -n '/^datasource/,/}/p' /tmp/schema.check | grep -q 'provider *= *"sqlite"' && \
      sed -i '/^datasource/,/}/s/provider *= *"sqlite"/provider = "postgresql"/' /tmp/schema.check || true; \
    provider="$(sed -n '/^datasource/,/}/p' /tmp/schema.check | sed -n 's/.*provider *= *"\([a-z]*\)".*/\1/p')"; \
    echo "migrate stage datasource provider: '${provider}'"; \
    [ "$provider" = "postgresql" ]; \
    cp /tmp/schema.check "$schema"
USER node
CMD ["npx", "prisma", "migrate", "deploy", "--schema", "apps/api/prisma/schema.prisma"]

FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000
WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]

FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
