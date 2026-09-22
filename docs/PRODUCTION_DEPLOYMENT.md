# Production deployment

This deployment runs the React UI in an unprivileged Nginx container and the API
in a separate unprivileged Node.js container. PostgreSQL runs on a different
Linux machine. Only the web port is published by Docker.

## 0. THIS deployment: database on 10.5.1.178, Docker on Windows (10.5.1.193)

The two hosts and the ports chosen for them. Standard ports are already taken on this
network (8080 among them), so every published port is a non-standard one: change the
numbers in one place - `infra/docker/.env.production` - if they clash too.

| Host | What runs there | Port |
|---|---|---|
| `10.5.1.178` (Linux) | PostgreSQL 15+ | **5439** (not 5432) |
| `10.5.1.193` (Windows, Docker Desktop) | `web` (Nginx + SPA) | **8099** published -> UI at `http://10.5.1.193:8099` |
| `10.5.1.193` (Docker network only) | `api` (Node) | 4000, NOT published; Nginx proxies `/api/` to it |
| `10.5.1.193` (Docker network only) | `migrate` (Prisma, one-shot) | - |
| `10.5.1.106` (existing) | LabourWorks SQL Server (badge sync + clocked hours) | 1433, unchanged, read-only |

Nothing else is published. The API and PostgreSQL are never exposed to the LAN directly;
the only reachable endpoint is the web port on `10.5.1.193`.

### 0.1 Database host - 10.5.1.178 (Linux)

```bash
# --- 1. PostgreSQL listens on 5439 and accepts the Docker host ----------------
# Find the two files that matter (Debian/Ubuntu: /etc/postgresql/15/main/...;
# RHEL/SLES: /var/lib/pgsql/15/data/...).
sudo -u postgres psql -tAc "SHOW config_file; SHOW hba_file;"

# Edit postgresql.conf: uncomment/append these two lines.
listen_addresses = '*'
port = 5439

# Append ONE line to pg_hba.conf, scoped to the Docker host only. Never use a
# wider range and never 'trust': the app password must be checked.
#   host    workforce   workforce_app   10.5.1.193/32   scram-sha-256

sudo systemctl restart postgresql
sudo systemctl enable postgresql
```

```bash
# --- 2. Open the firewall only for the Docker host ---------------------------
# ufw:
sudo ufw allow from 10.5.1.193 to any port 5439 proto tcp
# firewalld instead:
sudo firewall-cmd --permanent   --add-rich-rule='rule family=ipv4 source address=10.5.1.193/32 port port=5439 protocol=tcp accept'
sudo firewall-cmd --reload
```

```bash
# --- 3. Create the login and the empty database ------------------------------
# Run from a copy of this repository. The password never goes into a file that is
# committed; read it from a protected secret file if you prefer.
cd /path/to/workforce
sudo -u postgres psql --set=app_password='THE_REAL_PASSWORD' -f database/00-create-database.sql
```

The database exists after this step and is EMPTY. The tables are created by the
`migrate` container in 0.3 (recommended), so do not run `01-schema.sql` as well.

### 0.1b Reusing a PostgreSQL instance that is already on the network

Another application on the Docker host already talks to a database on 5432. That does not
by itself force a new port here, because a PostgreSQL port is a **server-side listen port**, not
something each client reserves: any number of applications can connect to the same instance on the
same port, and a client needs no port of its own. Decide from the table:

| Situation | Port for this app | What to change |
|---|---|---|
| PostgreSQL already runs on `10.5.1.178` at 5432 and can host another database | **5432** | `DATABASE_URL` only. Add our role + database (0.1.3) and one `pg_hba` line for our role/database from `10.5.1.193/32`; no `postgresql.conf` edit and no firewall change if that host already accepts 5432 from the Docker host |
| We add a SECOND cluster to `10.5.1.178` (the 5432 one belongs to another team/product) | **5439** | everything in 0.1 (listen port, firewall, `pg_hba`) |
| The other application's database is on a different machine | **5432** normally | `DATABASE_URL`; nothing on that other machine is affected |
| The other application's 5432 is a container published *on* `10.5.1.193` (e.g. `5433:5432`) | irrelevant to us | our app connects OUTWARD to the database host; the production compose has **no postgres service**, so this stack binds no database port on the Windows host at all |

Whichever row applies, three things stay separate:

- **Role and database, never a shared login.** `database/00-create-database.sql` creates
  `workforce_app` and a database of its own, and revokes `PUBLIC`. A `pg_hba` rule is matched per
  database + role, so an existing rule for the other application does not cover ours: add
  `host  workforce  workforce_app  10.5.1.193/32  scram-sha-256`.
- **Published host ports on `10.5.1.193`.** This is the only thing that can genuinely collide with
  the other stack, and the only port we publish is the web port (`WEB_PORT`, 8099). If that number
  is taken, pick another and change that one line. The API and the database are never published.
- **Failure domain (a policy choice, not a technical one).** Sharing the instance is fine and simple;
  giving Workforce its own cluster (or its own host) is worth it only if the two products must not
  share backup windows, connection limits or a restart. If they must not, use the 5439 row above.

So: reuse 5432 when the existing instance can host the database, and use 5439 only when a second
cluster has to live on a host that already serves 5432.

### 0.2 TLS between the two hosts (decide once)

The connection string carries `sslmode`. Pick one and put it in
`infra/docker/.env.production`:

| Situation | `sslmode` | Comment |
|---|---|---|
| PostgreSQL has no TLS configured (common on a fresh install) | `prefer` | Encrypts when the server offers it, falls back to plaintext. Acceptable inside this LAN; the password still travels inside the tunnel or the LAN. |
| TLS enabled with a self-signed certificate | `require` | Encrypts. Does not verify the host name/certificate (so it cannot detect a substituted server). |
| TLS enabled with your own CA | `verify-full` | Encrypts and verifies. The CA file must be mounted into the containers, e.g. add `- ./certs/ca.crt:/etc/ssl/certs/pg-ca.crt:ro` and `&sslrootcert=/etc/ssl/certs/pg-ca.crt` to the URL. |

The API refuses to start against PostgreSQL when `DATABASE_URL` is a `file:` (SQLite)
URL, so a stray dev value fails fast instead of writing to a local file.

### 0.3 Docker host - 10.5.1.193 (Windows, PowerShell)

Docker Desktop must be running with **Linux containers**. Run these in PowerShell
(each command on one line - PowerShell line continuation needs a backtick, so the
examples avoid it).

```powershell
# 1. Get a copy of the branch onto the host, e.g.:
cd C:git clone <repository-url> workforce
cd C:\workforce
git checkout main          # or the release tag/branch you deploy from
```

```powershell
# 2. PRODUCTION SCHEMA. The repository's schema.prisma is the SQLite variant used for
#    local development, and the image build FAILS on purpose if it is not swapped.
Copy-Item appspi\prisma\schema.postgresql.prisma appspi\prisma\schema.prisma -Force

# 3. Create the environment file and edit it (see section 2 for every value).
Copy-Item infra\docker\.env.production.example infra\docker\.env.production
notepad infra\docker\.env.production
```

Minimum edits in `infra\docker\.env.production`:

```
DATABASE_URL=postgresql://workforce_app:URL_ENCODED_PASSWORD@10.5.1.178:5439/workforce?schema=public&sslmode=prefer
JWT_SECRET=<48 random bytes, one line, no quotes>
CORS_ORIGINS=http://10.5.1.193:8099
WEB_PORT=8099
TZ=Asia/Kolkata
```

- URL encode the password: `@` -> `%40`, `#` -> `%23`, `:` -> `%3A`, `/` -> `%2F`.
- `CORS_ORIGINS` must be the exact origin the browser uses. With no TLS it is
  `http://10.5.1.193:8099`; behind a TLS proxy use the `https://` name instead.
- `TZ=Asia/Kolkata` is not cosmetic: the timesheet's "today", the daily hour limits and
  the 09:00 / 21:00 attendance job all use the container's local clock.

```powershell
# 4. Build, migrate, start. The migrate container runs first and must succeed.
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml build --pull
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml up -d
```

```powershell
# 5. Verify - from the host, not from inside a container.
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml ps
curl.exe -fsS http://127.0.0.1:8099/healthz
curl.exe -fsS http://127.0.0.1:8099/api/health/ready
Start-Process http://10.5.1.193:8099
```

`/api/health/ready` answers only when the API can reach PostgreSQL, so a green answer is
the end-to-end proof of the connection. If it fails, read
`docker compose ... logs migrate api` - section 0.4 lists the failures that actually
happen here.

### 0.4 The five failures that happen in this topology

| Symptom | Cause | Fix |
|---|---|---|
| `ERROR: apps/api/prisma/schema.prisma declares the 'sqlite' datasource provider` during `build` | step 0.3.2 was skipped | run the `Copy-Item`, then build again |
| `no pg_hba.conf entry for host "10.5.1.193"` | the `host workforce workforce_app 10.5.1.193/32 scram-sha-256` line is missing (or the Docker host's outbound IP differs) | add the line for the real source address, `sudo systemctl reload postgresql` |
| `connect ECONNREFUSED 10.5.1.178:5439` | `listen_addresses` still `localhost`, PostgreSQL not restarted, or the firewall blocks 5439 | the two settings in 0.1.1 and the rule in 0.1.2 |
| `server does not support SSL connections` | `sslmode=require` against a server without TLS | use `sslmode=prefer` (table in 0.2) or enable TLS on the server |
| `password authentication failed` | the password in the URL is not URL encoded, or it is not the one set in 0.1.3 | re-encode it; re-run `00-create-database.sql` with the right password |
| Migration stops on `column ... already exists` | someone applied `01-schema.sql` by hand first | drop and recreate the empty database, then let `migrate` run (never edit an applied migration) |

Check the network path from the Docker host before blaming the app (PowerShell):

```powershell
Test-NetConnection 10.5.1.178 -Port 5439
docker run --rm -e PGPASSWORD=THE_REAL_PASSWORD postgres:15-alpine psql "postgresql://workforce_app@10.5.1.178:5439/workforce?sslmode=prefer" -tAc "select version(), current_database();"
```

The second command runs from a container on the same bridge network as the app, so it
proves exactly the path the API will use.

### 0.4b Preflight that was actually run for this topology (2026-09-22)

Two checks stand behind the steps above, both re-runnable before touching 10.5.1.178.

**1. The whole migration chain was applied to an EMPTY PostgreSQL 16 cluster** (throwaway
`initdb`/`pg_ctl`, no Docker, no sudo), which is exactly what the `migrate` container does on a
fresh database. Result: **all 10 migrations applied cleanly -> 31 tables**, and the clocked-hours
columns arrived with the intended shape:

| column | type | nullable | default |
|---|---|---|---|
| `in_out_hours` | double precision | yes | - |
| `in_out_source` | text | yes | - |
| `in_out_checked_at` | timestamp(3) | yes | - |
| `in_out_attempts` | integer | no | `0` |

Six behaviour tests were run against that database, and all six behaved as expected:

- the **first-Admin `INSERT`** printed in section 1b succeeds on the migrated schema (it also proves
  every `NOT NULL` column *without* a database default is fillable by plain SQL - the Prisma
  `@updatedAt` columns have none);
- a new `timesheet_days` row defaults to `in_out_attempts = 0` with NULL hours and NULL source;
- a fetched figure stores with `in_out_source = 'LABOURWORKS'`; a manual one with `'MANUAL'`;
- a **second** `timesheet_days` row for the same employee, work date and tagger is refused
  (the `(employee_id, work_date, tagged_by)` unique index is real), and an orphan `employee_id` is
  refused by the foreign key.

The test seed used for this was appended to a temporary copy of the chain and is **not** part of any
migration. To repeat the check, apply `apps/api/prisma/migrations/*/migration.sql` in filename order
to a scratch database with `psql -v ON_ERROR_STOP=1`.

**2. Every production setting the code reads is present in
`infra/docker/.env.production.example`.** All 36 `process.env` names the API reads (and the two the
compose file interpolates, `WEB_PORT` and `IMAGE_TAG`) are listed there with a default or a
placeholder, so an operator cannot miss one - including `BADGEVIEW_*`, `ATTENDANCE_*`,
`MAX_OT_HOURS` and `CREDENTIAL_DELIVERY_BATCH_SIZE`. Keep it that way: a new env var must appear in
that file in the same change.

### 0.5 LabourWorks from inside the container (badge sync + clocked hours)

The containers reach `10.5.1.106:1433` through the Windows host's network stack. Two
things to arrange:

- The SQL Server firewall must allow the Docker host's address. Container traffic is
  NAT'ed, so the source address SQL Server sees is the host's, not the container's.
- The read-only login needs `SELECT` on `dbo.BadgeView` (badge sync) **and** on
  `dbo.Report_Attendance_Intermediate` (clocked hours).

Test it from the running API container (PowerShell):

```powershell
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml exec api node -e "const sql=require('mssql');(async()=>{const p=await new sql.ConnectionPool({server:process.env.BADGEVIEW_DB_HOST,port:Number(process.env.BADGEVIEW_DB_PORT||1433),user:process.env.BADGEVIEW_DB_USER,password:process.env.BADGEVIEW_DB_PASSWORD,database:process.env.BADGEVIEW_DB_NAME,options:{encrypt:false,trustServerCertificate:true,readOnlyIntent:true}}).connect();const r=await p.request().query('SELECT TOP 1 IDNo, ManHours FROM dbo.Report_Attendance_Intermediate ORDER BY [Date] DESC');console.log('OK',r.recordset);await p.close()})().catch(e=>{console.error('FAIL',e.message);process.exit(1)})"
```

Then, once the clocked-hours job should run unattended, set in
`infra\docker\.env.production`:

```
ATTENDANCE_HOURS_ENABLED=true
ATTENDANCE_HOURS_CRON=0 9,21 * * *
```

## 1. Prepare PostgreSQL on the database server

Install PostgreSQL 15 or newer and restrict its port (5439 in this deployment - see
section 0) in the firewall to the Docker host. As the PostgreSQL administrator, create
the login and database:

```bash
sudo -u postgres psql \
  --set=app_user=workforce_app \
  --set=app_database=workforce \
  --set=app_password='A_LONG_RANDOM_PASSWORD' \
  --file=database/00-create-database.sql
```

Do not put the real password in shell history. In a real deployment, read it from
a protected secret file or your secret manager.

### Point the API at that server

The API reaches PostgreSQL only through `DATABASE_URL`. There is **no database
container in production**: `infra/docker/compose.production.yml` starts `migrate`,
`api` and `web` only. (`infra/docker/docker-compose.yml`, which does run a local
PostgreSQL container, is the **development** stack and is not used in production.)

For a database server at `10.5.1.178` listening on 5439, `infra/docker/.env.production`
carries (section 0.2 explains the `sslmode` choice):

```
DATABASE_URL=postgresql://workforce_app:URL_ENCODED_PASSWORD@10.5.1.178:5439/workforce?schema=public&sslmode=prefer
```

- URL encode the password (`@` becomes `%40`). Use `sslmode=verify-full` with your
  CA when the server presents a certificate you can verify.
- Allow the PostgreSQL port from the Docker host to `10.5.1.178` in the firewall, and grant
  `workforce_app` `CONNECT` on `workforce`. The containers need no other route to
  the database.
- The `migrate` container applies the schema over that same URL, so the two must
  match. After changing `DATABASE_URL`, run the migrate step again (section 3)
  before restarting the API.
- Nothing else in the stack needs editing for an external database: no published
  port, no volume and no service is added.

### Schema option A: Prisma migration (recommended)

The `migrate` container applies the complete baseline before the API starts.
Copy the repository to the Docker host and continue with step 2. The database
login needs schema-owner DDL rights when migrations run.

### Schema option B: DBA applies the baseline SQL

> **Only valid for a fresh database, and only applies the 2026-09-13 baseline.**
> `database/01-schema.sql` predates the later migrations — it has **no `users.section_id`**
> (HOD scope), **no `hod_delegations`** and **none of the Project / WBS / Job Order master
> data** (no `project_wbs.project_id`, no `uom`, no `networks`, no `networks.wbs_id`, no
> `job_order_budget_revisions`, no `job_order_progress`, no attribution snapshot columns).
> After running it you must still apply the later migrations (option C below), otherwise
> HOD scoping, approval cover and the Job Order screens will not work. Prefer option A.

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
| `20260918000001_job_order_progress_remarks` | `job_order_progress_remarks` — every quantity remark kept as its own row (stage, author, role, time), with the remarks that already existed backfilled. |
| `20260918000002_job_order_wbs_project_fk` | Composite foreign key on `job_orders (project_wbs_id, project_id)` → `project_wbs (id, project_id)` with the supporting unique index, so a Job Order's Project must be the Project that owns its WBS. Declared in the Prisma schema (`projectWbsOfProject`), so `migrate dev` will not drop it. |
| `20260918000003_network_wbs_scope` | `networks.wbs_id` — a Network belongs to one WBS element of its project, not to the whole project. Each existing Network is backfilled onto the **first** WBS row of its project (lowest sort order, then lowest WBS code, and the pick is not limited to active WBS rows) and the column is made NOT NULL. Apply it through `prisma migrate deploy`, which wraps the migration in one transaction: with a bare `psql -f` the added column survives the failed guard and a re-run stops on `column "wbs_id" already exists`. The migration **stops and names the Network codes** when a Network's project has no WBS row at all: add a WBS row to that project (or delete the Network) and re-run. `(project_id, code)` uniqueness is unchanged. See `docs/MASTER_DATA_PROJECT_WBS_JOB_ORDER.md`. |
| `20260921000000_timesheet_in_out_hours` | `timesheet_days.in_out_hours` (DOUBLE PRECISION, nullable) - the hours each contract worker actually clocked in and out, read from LabourWorks. Nullable with **no backfill by design**: the value comes from an external system and is absent until it is fetched. Reset to NULL by every submit. |
| `20260922000000_timesheet_in_out_pending_state` | `timesheet_days.in_out_source` (null / LABOURWORKS / MANUAL), `in_out_checked_at`, `in_out_attempts` - the pending-state columns that let a late regularization be seen ("still 0 after N checks") and let an Admin's manual figure survive every refresh. |
| `20260918000000_project_wbs_job_order_master` | Project → WBS → Job Order master data: renames `projects_wbs` to `project_wbs` and links it to its Project, adds `uom` and `networks`, adds `uom_id` / `network_id` / `budgeted_quantity` / `section_id` to `job_orders` and limits its status to active / inactive, adds `job_order_budget_revisions` and `job_order_progress`, and adds the attribution snapshot columns to `timesheet_entries` and `employee_allocations`. It backfills everything it makes required, so it runs against a populated database. See `docs/MASTER_DATA_PROJECT_WBS_JOB_ORDER.md`. |

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
- **`BADGEVIEW_SYNC_ACTIVE_ONLY`** controls whether terminated workers are imported. It
  defaults to `true`, which means only active workers are fetched: a terminated worker never
  gets an `Employee` row or a login. Leave it at `true` unless you specifically want the
  inactive rows back, and note that a worker who leaves is still retired by the absence
  sweep either way.
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

Open `http://DOCKER_HOST:8099` (the `WEB_PORT` in `infra/docker/.env.production`). Put a
TLS reverse proxy or load balancer in front for HTTPS. Do not expose the API port or
PostgreSQL publicly.

Check status and logs:

```bash
docker compose -f infra/docker/compose.production.yml ps
docker compose -f infra/docker/compose.production.yml logs migrate api web
curl.exe -fsS http://127.0.0.1:8099/healthz
curl.exe -fsS http://127.0.0.1:8099/api/health/ready
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
  `curl.exe -fsS http://127.0.0.1:8099/api/health/ready` then log in as an Admin and confirm
  **Approvals** shows the *HOD Approval Cover* panel and **Employees** shows *HOD
  Registration & Department / Section Mapping*.
- Apply later migrations with `docker compose ... run --rm migrate`, then restart the
  API. Never `prisma db push` in production and never edit applied migrations.
- Back up with `pg_dump --format=custom workforce > workforce.dump` from a secure
  host. Test restores regularly.
- **Never run a seed against production.** `prisma/seed.ts` (`npm run db:seed`) is the
  minimal bootstrap: four office accounts — ADMIN, PM, HR and FINANCE — with the known
  `DEV_SEED_PASSWORD` and **no business data**. `prisma/seed-demo.ts`
  (`npm run db:seed:demo`) is the full demonstration set. Both are blocked when
  `NODE_ENV=production`, and both create accounts with a known password, so a deployment
  creates its first Admin by hand (step 1b) and adds its masters through the screens.
- Rotate `JWT_SECRET` deliberately; rotation signs all users out.
- Monitor both `/healthz` and `/api/health/ready`.
- Approval-cover and HOD-scope changes bump a user's `tokenVersion`, so affected users
  are signed out and must log in again — expected, not an outage.
