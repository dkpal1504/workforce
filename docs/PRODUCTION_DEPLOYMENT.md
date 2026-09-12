# Production deployment

This deployment runs the React UI in an unprivileged Nginx container and the API
in a separate unprivileged Node.js container. PostgreSQL runs on a different
Linux machine. Only the web port is published by Docker.

## 1. Prepare PostgreSQL on the database server

Install PostgreSQL 15 or newer, enable TLS, and restrict port 5432 in the firewall
to the Docker host. As the PostgreSQL administrator, create the login and database:

```bash
sudo -u postgres psql \
  --set=app_user=workforce_app \
  --set=app_database=workforce \
  --set=app_password='A_LONG_RANDOM_PASSWORD' \
  --file=database/00-create-database.sql
```

Do not put the real password in shell history. In a real deployment, read it from
a protected secret file or your secret manager.

### Schema option A: Prisma migration (recommended)

The `migrate` container applies the complete baseline before the API starts.
Copy the repository to the Docker host and continue with step 2. The database
login needs schema-owner DDL rights when migrations run.

### Schema option B: DBA applies the complete SQL

`database/01-schema.sql` contains all tables, keys, indexes, foreign keys, and
PostgreSQL-specific integrity constraints. Run it against an empty database:

```bash
PGPASSWORD='A_LONG_RANDOM_PASSWORD' PGSSLMODE=require psql \
  --host=db.example.internal --username=workforce_app --dbname=workforce \
  --file=database/01-schema.sql
```

Then record the baseline before starting Compose, otherwise Prisma will try to
create the same tables:

```bash
cd apps/api
DATABASE_URL='postgresql://...' npx prisma migrate resolve \
  --applied 20260913000000_postgresql_baseline
```

## 2. Configure the Docker host

```bash
cp infra/docker/.env.production.example infra/docker/.env.production
chmod 600 infra/docker/.env.production
```

Edit every placeholder. Generate a JWT secret, for example:

```bash
openssl rand -base64 48
```

The password inside `DATABASE_URL` must be URL encoded. Keep `sslmode=require`
(or use `verify-full` with your PostgreSQL CA setup). Set `CORS_ORIGINS` to the
exact public HTTPS origin. Keep `BADGEVIEW_SYNC_ENABLED=false` unless this single
API instance can reach the source SQL Server and has the required read-only
credentials. Do not scale the API while in-process scheduled jobs are enabled.

## 3. Build and start

From the repository root:

```bash
docker compose --env-file infra/docker/.env.production \
  -f infra/docker/compose.production.yml build --pull
docker compose --env-file infra/docker/.env.production \
  -f infra/docker/compose.production.yml up -d
```

Open `http://DOCKER_HOST:8080` (or `WEB_PORT`). Put a TLS reverse proxy or load
balancer in front for HTTPS. Do not expose the API port or PostgreSQL publicly.

Check status and logs:

```bash
docker compose -f infra/docker/compose.production.yml ps
docker compose -f infra/docker/compose.production.yml logs migrate api web
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/api/health/ready
```

## Operations

- Apply later migrations with `docker compose ... run --rm migrate`, then restart
  the API.
- Back up with `pg_dump --format=custom workforce > workforce.dump` from a secure
  host. Test restores regularly.
- Run `prisma/seed.ts` only for a demo environment. It creates known demo users
  and passwords and must not be run in production.
- Rotate `JWT_SECRET` deliberately; rotation signs all users out.
- Monitor both `/healthz` and `/api/health/ready`.
