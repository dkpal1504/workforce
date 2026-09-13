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

### Schema option B: DBA applies the baseline SQL

> **Only valid for a fresh database, and only applies the 2026-09-13 baseline.**
> `database/01-schema.sql` predates the later migrations — it has **no `users.section_id`**
> (HOD scope) and **no `hod_delegations`**. After running it you must still apply the
> later migrations (option C below), otherwise HOD scoping and approval cover will not
> work. Prefer option A.

`database/01-schema.sql` contains the baseline tables, keys, indexes, foreign keys and
PostgreSQL integrity constraints. Run it against an empty database:

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

### Schema option C: apply the remaining migrations to an existing database

The repository's migrations are the authoritative, reviewed DDL. Current history:

| Migration | Adds |
|---|---|
| `20260913000000_postgresql_baseline` | Baseline schema |
| `20260914000000_role_based_access` | `employee_allocation_approvals` |
| `20260915000000_hod_section_and_org_transfer` | `users.section_id` (HOD scope), `employee_organisation_overrides` |
| `20260916000000_hod_approval_delegation` | `hod_delegations` (HOD approval cover) |

Apply them with the `migrate` container (option A) or directly:

```bash
cd apps/api
DATABASE_URL='postgresql://...' npx prisma migrate deploy
```

The container runs the same command and must exit successfully before the API starts,
so a failed migration blocks the deploy instead of serving a half-migrated schema.

## 1b. Create the first administrator

A fresh database has **no accounts**, and every user-creating endpoint requires an
existing ADMIN or HR token — so a new deployment cannot be logged into at all until one
account exists. There is deliberately no bootstrap route or published default password
(the seed is blocked in production).

Create the first Admin deliberately, on the database host:

1. Generate a bcrypt hash of the password you will hand over:

   ```bash
   cd apps/api && node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 10))" 'YourFirstPassword'
   ```

2. Insert the account, then hand the password over and have it changed at first login:

   ```sql
   INSERT INTO users (email, password_hash, name, role, source, active, must_change_password,
                      token_version, created_at, updated_at)
   VALUES ('admin@yourdomain.example', '<hash from step 1>', 'Platform Admin', 'ADMIN',
           'MANUAL', true, true, 0, now(), now());
   ```

3. Log in, then create everyone else through the application (Employees → Register
   Payroll Employee / HOD Registration, Supervisors → register). Those accounts receive
   a one-time credential by e-mail, so configure `SMTP_*` and set
   `CREDENTIAL_DELIVERY_ENABLED=true` — otherwise new accounts have no usable password.

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

Also required, and easy to miss:

- **`AUTH_RATE_LIMIT_ENABLED` must not be `false`.** The API refuses to start in
  production with the login throttle disabled.
- **`DATABASE_URL` must be a PostgreSQL URL.** A `file:` (SQLite) URL is rejected in
  production, so a dev `.env` copied to the host will not silently work.
- **The schema provider must be `postgresql`.** Dev builds switch
  `apps/api/prisma/schema.prisma` to `sqlite`; production must ship the PostgreSQL
  variant. **The image build now enforces this:** the `build` stage reads the
  datasource provider and fails with an explicit error if it is not `postgresql`, so a
  dev-mode schema cannot produce a production image. If the build stops with
  `ERROR: apps/api/prisma/schema.prisma declares the 'sqlite' datasource provider`,
  restore it and rebuild:
  ```bash
  cp apps/api/prisma/schema.postgresql.prisma apps/api/prisma/schema.prisma
  ```
  The `migrate` stage is additionally pinned: it rewrites `sqlite` → `postgresql`
  before running `prisma migrate deploy`, because the SQL under `prisma/migrations`
  is PostgreSQL dialect regardless of what the committed schema says.
- **Configure `SMTP_*` and `CREDENTIAL_DELIVERY_ENABLED=true`** if you intend to
  onboard users from the UI. With delivery off, the credential queue only accumulates
  and no new Employee/HOD/Supervisor can log in.
- **`BADGEVIEW_DB_*`** (host, port, user, password, database, view, encryption) if the
  sync is enabled.

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

- **After this change (2026-09-13 CR#2 + HOD scope + approval cover), a running
  deployment needs a redeploy, not just a restart.** New code plus
  migration `20260916000000_hod_approval_delegation`:
  ```bash
  docker compose --env-file infra/docker/.env.production \
    -f infra/docker/compose.production.yml build --pull
  docker compose --env-file infra/docker/.env.production \
    -f infra/docker/compose.production.yml run --rm migrate
  docker compose --env-file infra/docker/.env.production \
    -f infra/docker/compose.production.yml up -d --force-recreate api web
  ```
  `up -d` alone is a no-op when the image tag has not changed and the containers are
  already running — pair `build` with `up -d --force-recreate`.
- Verify the deployed code, not just that the container is up:
  `curl -fsS http://127.0.0.1:8080/api/health/ready` then log in as an Admin and confirm
  **Approvals** shows the *HOD Approval Cover* panel and **Employees** shows *HOD
  Registration & Department / Section Mapping*.
- Apply later migrations with `docker compose ... run --rm migrate`, then restart the
  API. Never `prisma db push` in production and never edit applied migrations.
- Back up with `pg_dump --format=custom workforce > workforce.dump` from a secure
  host. Test restores regularly.
- Run `prisma/seed.ts` only for a demo environment. It is blocked when
  `NODE_ENV=production` and creates known demo users and passwords.
- Rotate `JWT_SECRET` deliberately; rotation signs all users out.
- Monitor both `/healthz` and `/api/health/ready`.
- Approval-cover and HOD-scope changes bump a user's `tokenVersion`, so affected users
  are signed out and must log in again — expected, not an outage.
