# Production go-live checklist — 10.5.1.178 (PostgreSQL) + 10.5.1.193 (Docker, Windows)

Follow the phases in order. Every step shows the command and what a correct result looks like;
if a step fails, jump to **Appendix A** (failure → fix) and continue from the same phase.
Nothing is skipped: phases 1-5 put the application on the machine, 6-8 create the people who use
it, 9-10 make it reachable and keep it running.

| # | Where | What | Time |
|---|---|---|---|
| 0 | both hosts | decide the five values and check access | 5 min |
| 1 | 10.5.1.178 (Linux) | create the role + database, allow the Docker host, verify the connection | 15 min |
| 2 | 10.5.1.193 (Windows) | get the code (fresh clone), swap in the PostgreSQL schema | 10 min |
| 3 | 10.5.1.193 | write `infra/docker/.env.production` | 10 min |
| 4 | 10.5.1.193 | build the images | 5-15 min (first build) |
| 5 | 10.5.1.193 | run migrations, start the stack, health checks | 5 min |
| 6 | browser | create the first Admin, log in, change the password, add a second Admin | 10 min |
| 7 | browser | onboard the PM team and the HODs | 15 min |
| 8 | browser / .env | optional: LabourWorks sync, clocked-hours job, SMTP | 10 min |
| 9 | 10.5.1.193 | open the web port to the users (+ optional TLS) | 5 min |
| 10 | 10.5.1.193 | day-2 operations: logs, backup, next release | 10 min |

---

## Phase 0 — Decide these five values first

| Value | Example for this deployment | Notes |
|---|---|---|
| Database password | `WorkforceDb2026Pass` | Use **letters and digits only**. It must be percent-encoded inside `DATABASE_URL`, and an unquoted `#` in an env file truncates the value — plain alphanumeric avoids both traps |
| JWT secret | generated in Phase 3 | at least 32 characters, one line, no quotes |
| Admin e-mail | `admin@swan.co.in` | the first login identifier |
| Shared first password | `password@SDHI` | what supervisors/employees log in with the first time; they must change it |
| Web port | `8099` | confirmed free on 10.5.1.193 (8080 is taken by the other application) |

Access you need: **Linux shell on 10.5.1.178** with `sudo -u postgres psql` working, and
**PowerShell on 10.5.1.193** with Docker Desktop running in **Linux containers** mode.

---

## Phase 1 — The database host, 10.5.1.178 (Linux)

### 1.1 Confirm PostgreSQL and your admin access

```bash
sudo -u postgres psql -tAc "select version(); show port; show listen_addresses;"
```
Expected: a PostgreSQL 15+ version string, port `5432`, and `listen_addresses` that is **not**
`localhost` (this server already answers on 5432 from the network). If `sudo -u postgres psql`
fails, ask your PostgreSQL administrator to run 1.3-1.5 for you.

Find the two configuration files (paths differ per distribution):

```bash
sudo -u postgres psql -tAc "show config_file; show hba_file;"
```

### 1.1b What an outside probe can and cannot tell you (verified 2026-09-22)

PostgreSQL on `10.5.1.178:5432` answers TCP, offers TLS, and a **password rule already covers LAN
hosts**: a connection attempt from a random user returns `FATAL: password authentication failed`,
never `no pg_hba.conf entry for host ...`. So step 1.5 is normally a no-op here - a broad rule such
as `host all all 10.5.1.0/24 scram-sha-256` must already be in force, because your other application
connects from this LAN. Add the explicit `workforce_app` line only if you also want it documented,
and remember that `pg_hba.conf` is first-match-wins: a line appended AFTER a broad rule is never
reached. Verify with 1.7 rather than assuming.

What a probe from outside can NOT tell you: whether the role or the database exists. PostgreSQL
returns the same `password authentication failed` for a missing role as for a wrong password (a
control probe with a name that certainly does not exist gives the identical message), so accounts
cannot be enumerated from outside. Check it ON the server, as 1.2 and 1.2b do.

### 1.2 Confirm this database does not exist yet (it must be a NEW, empty database)

```bash
sudo -u postgres psql -tAc "select datname from pg_database where datname='workforce';"
```
Expected: no rows. If it prints `workforce`, the database already exists — **stop** and decide
whether to reuse it (then skip 1.3-1.4) or pick another name (and use it in Phase 3).

### 1.3 Create the login (the application's own role, never the `postgres` superuser)

```bash
# 1.2b check the ROLE as well - a half-finished earlier attempt leaves a role behind
sudo -u postgres psql -tAc "select rolname from pg_roles where rolname='workforce_app';"

sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE workforce_app LOGIN PASSWORD 'WorkforceDb2026Pass';"
```
Expected: `CREATE ROLE`; verify with
`sudo -u postgres psql -tAc "select rolname from pg_roles where rolname='workforce_app';"` -> `workforce_app`.

### 1.4 Create the database, owned by that role

```bash
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE workforce OWNER workforce_app ENCODING 'UTF8' TEMPLATE template0;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "REVOKE ALL ON DATABASE workforce FROM PUBLIC;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "GRANT CONNECT, TEMPORARY ON DATABASE workforce TO workforce_app;"
```

If a step answers **already exists**, every line above is safe to re-run:

| Message | What to do |
|---|---|
| `role "workforce_app" already exists` | re-set its password instead: `sudo -u postgres psql -c "ALTER ROLE workforce_app LOGIN PASSWORD 'WorkforceDb2026Pass';"` |
| `database "workforce" already exists` | if it is EMPTY and you want a clean start: `sudo -u postgres psql -c "DROP DATABASE workforce;"` then re-run the `CREATE DATABASE` line. Never drop it once the application has written data - take a `pg_dump` first |
| `CREATE DATABASE cannot run inside a transaction block` | run that line on its own, exactly as written (do not combine it with other statements in one `-c`) |

Expected: `CREATE DATABASE`, `REVOKE`, `GRANT`. The database is EMPTY — the tables are created in
Phase 5 by the `migrate` container. **Never** run `database/01-schema.sql` as well: a hand-applied
baseline collides with the migrations (`column ... already exists`).

### 1.5 Allow the Docker host through `pg_hba.conf`

```bash
HBA="$(sudo -u postgres psql -tAc 'show hba_file')"
echo "host    workforce    workforce_app    10.5.1.193/32    scram-sha-256" | sudo tee -a "$HBA"
sudo systemctl reload postgresql
```
Expected: the line is appended and PostgreSQL reloads. Never use `trust`, and never a wider range
than the Docker host.

### 1.6 Open the firewall for that host only

```bash
# ufw:
sudo ufw allow from 10.5.1.193 to any port 5432 proto tcp
# firewalld instead:
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=10.5.1.193/32 port port=5432 protocol=tcp accept' && sudo firewall-cmd --reload
```

### 1.7 Verify the connection FROM the Docker host (phase 2 does the real check)

```powershell
Test-NetConnection 10.5.1.178 -Port 5432
```
Expected: `TcpTestSucceeded : True`.

---

## Phase 2 — The Docker host, 10.5.1.193 (Windows PowerShell)

### 2.1 Docker Desktop is up, Linux containers

```powershell
docker version --format '{{.Server.Os}} / {{.Server.Version}}'
docker compose version
```
Expected: `linux / 2x.x.x` and a `docker compose version 2.x` line. Docker Desktop must be running.

### 2.2 Get the release code

An old checkout already exists at `C:\Project\workforce`. For a first production deploy the cleanest
option is a **fresh clone** (no old local edits, guaranteed to match GitHub):

```powershell
cd C:\Project
git clone <repository-url> workforce-prod
cd C:\Project\workforce-prod
git checkout main
git log --oneline -1
```
Expected last line: `55fd925 feat(deploy): a one-shot first-admin script that runs inside the api image`
(or a newer commit — record the hash you deploy).

*Alternative: reuse `C:\Project\workforce`.* Only if you are sure it holds nothing you need:

```powershell
cd C:\Project\workforce
git status                    # look at what would be lost
git remote -v                 # must point at the same repository
git fetch --all
git checkout main
git reset --hard origin/main  # DESTROYS local edits in this folder
git log --oneline -1
```

### 2.3 Swap in the PostgreSQL schema (the image build refuses the SQLite one)

```powershell
cd C:\Project\workforce-prod
Copy-Item apps\api\prisma\schema.postgresql.prisma apps\api\prisma\schema.prisma -Force
Select-String -Path apps\api\prisma\schema.prisma -Pattern 'provider = "postgresql"'
```
Expected: one matching line. Without this the build stops with
`[build-gate] ... declares the 'sqlite' datasource provider`.

---

## Phase 3 — Write `infra/docker/.env.production`

```powershell
cd C:\Project\workforce-prod
Copy-Item infra\docker\.env.production.example infra\docker\.env.production
# generate the JWT secret (48 characters)
$bytes = 1..48 | ForEach-Object { Get-Random -Maximum 256 }
[Convert]::ToBase64String([byte[]]$bytes)
notepad infra\docker\.env.production
```
Paste the generated secret into `JWT_SECRET`. These are the values to set for THIS deployment
(everything else can stay as the example says):

```
NODE_ENV=production
API_HOST=0.0.0.0
API_PORT=4000
DATABASE_URL=postgresql://workforce_app:WorkforceDb2026Pass@10.5.1.178:5432/workforce?schema=public&sslmode=require
JWT_SECRET=<the 48 characters you just generated>
CORS_ORIGINS=http://10.5.1.193:8099,https://workforce.swan.co.in   # every origin users type, comma-separated
TRUST_PROXY=true
AUTH_RATE_LIMIT_ENABLED=true
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX=10
MAX_DAILY_HOURS=8
MAX_OT_HOURS=12
SHIFTS=GENERAL:09:00-17:00
BOOTSTRAP_PASSWORD=password@SDHI
ADMIN_EMAIL=admin@swan.co.in
ADMIN_NAME=Platform Admin
WEB_PORT=8099
TZ=Asia/Kolkata
CREDENTIAL_DELIVERY_ENABLED=false
BADGEVIEW_SYNC_ENABLED=false
ATTENDANCE_HOURS_ENABLED=false
```
Notes: `sslmode=require` works because the server offers TLS (self-signed certificate).
`CORS_ORIGINS` must be exactly what the browser uses, or the API refuses to start.
`TZ=Asia/Kolkata` drives "today", the daily hour limits and the 09:00 / 21:00 job.
`CREDENTIAL_DELIVERY_ENABLED=false` is correct while `BOOTSTRAP_PASSWORD` is set: contract staff get
the shared password instead of an e-mail, so no SMTP is needed.

---

## Phase 4 — Build the images

```powershell
cd C:\Project\workforce-prod
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml build --pull
```
Expected, in order: `[build-gate] No hardcoded shared password in the source.` then the API/web
builds and `naming to docker.io/library/workforce-api:latest` / `workforce-web:latest` /
`workforce-migrate:latest`. The first build takes 5-15 minutes (npm ci for three targets).

---

## Phase 5 — Migrate, start, verify

```powershell
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml up -d
```
What happens: the `migrate` container applies **all 10 migrations** to the empty database and exits
0; then `api` starts; then `web`. Check it:

```powershell
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml ps
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml logs migrate | Select-String "successfully applied"
curl.exe -fsS http://127.0.0.1:8099/healthz
curl.exe -fsS http://127.0.0.1:8099/api/health/ready
```
Expected: `ps` shows `migrate` exited 0 and `api`/`web` `Up (healthy)`; the log line
`All migrations have been successfully applied.`; `{"ok":true}` for both health checks.
`/api/health/ready` answering at all is the proof that the API reached PostgreSQL.

---

## Phase 6 — The first Admin (nothing works before this)

A fresh database has no accounts, and the production stack never runs a seed.

```powershell
cd C:\Project\workforce-prod
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml run --rm api node apps/api/scripts/create-first-admin.mjs
```
Expected: `[first-admin] Created ADMIN #1 <admin@swan.co.in> (Platform Admin).`

Then, in a browser on the LAN:
1. Open `http://10.5.1.193:8099` and log in with `admin@swan.co.in` / `password@SDHI`.
2. The application **forces** you to set your own password (everything else answers 403 until you do).
3. Log in again with the new password. You land on **Approvals**.
4. Create a **second Admin**: *Employees → Register payroll employee* for that person (department,
   section, ecNo) → then *Role Assignment* → search them → set role **ADMIN**. The Role Assignment
   panel is ADMIN-only, so a second Admin is your safety net.

---

## Phase 7 — Onboard the PM team, then the HODs

**PM (2-3 people):**
1. *Employees → Register payroll employee* for each PM person (department + section + ecNo). They
   start on `password@SDHI` and must change it at their first login.
2. *Role Assignment* → search each account → role **PM**.
   Rules the screen enforces: the account must be active and **linked to an active Employee**; you
   cannot change your own role; a PM with pending approvals cannot be moved off PM.
   Several PMs are fully supported: PM is organisation-wide, so all of them see the same
   HOD-approved queue and whoever decides first is recorded as the approver.

**HODs (one per department/section that submits timesheets):**
1. *Employees → Register payroll employee* for each HOD (HODs are payroll staff, never contract workers).
2. Promote them in *HOD Registration & Department / Section Mapping*, choosing their Section (or
   Department-wide scope). Both PM and ADMIN can do this.

**Supervisors and contract employees** arrive from the LabourWorks sync (Phase 8) or by
registration; they log in with their **EC number** and `password@SDHI`, and must change it.

---

## Phase 8 — Optional integrations (do these after the core works)

**LabourWorks sync (supervisors, contract workers, departments, sections):**
1. Put the real read-only credentials in `infra/docker/.env.production`:
   `BADGEVIEW_DB_HOST=10.5.1.106`, `BADGEVIEW_DB_PORT=1433`, `BADGEVIEW_DB_USER=it`,
   `BADGEVIEW_DB_PASSWORD="..."` (QUOTE it if it contains `#`), `BADGEVIEW_DB_NAME=LabourWorks`,
   `BADGEVIEW_DB_VIEW=BadgeView`, `BADGEVIEW_DB_ENCRYPT=false`.
2. The yard's SQL Server firewall must allow **10.5.1.193** (container traffic is NAT'ed, so the
   source address SQL Server sees is the host's).
3. `BADGEVIEW_SYNC_ENABLED=true` then restart the API and run one sync from *Admin → Sync*
   (or wait for 06:00 / 18:00). The snapshot guards (`BADGEVIEW_SYNC_MIN_ROWS`/`_MIN_RATIO`) abort a
   suspiciously small feed instead of retiring the workforce.

**Clocked hours (in/out) from the attendance view:** the read-only login needs `SELECT` on
`dbo.Report_Attendance_Intermediate` as well. Then `ATTENDANCE_HOURS_ENABLED=true` starts the
09:00 / 21:00 job (and the Sunday sweep); the *Clocked Hours (In/Out)* screen previews and re-runs it
by hand at any time.

**SMTP / credential e-mails:** only needed if you leave `BOOTSTRAP_PASSWORD` empty. Then
`CREDENTIAL_DELIVERY_ENABLED=true` plus `SMTP_*` becomes mandatory, or new accounts have no usable password.

Apply any `.env.production` change with:
```powershell
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml up -d --force-recreate api
```

---

## Phase 9 — Make it reachable for the users

```powershell
# Windows firewall: allow the LAN to reach the web port
New-NetFirewallRule -DisplayName "Workforce web 8099" -Direction Inbound -Protocol TCP -LocalPort 8099 -Action Allow
```
Users then open **`http://10.5.1.193:8099`**. Nothing else is published: the API and PostgreSQL stay
inside. For HTTPS, put a TLS reverse proxy in front and point it at `http://127.0.0.1:8099`; then set
`CORS_ORIGINS` to the HTTPS address and re-create the api container (Phase 8's command).

---

## Phase 10 — Day-2 operations

```powershell
cd C:\Project\workforce-prod
# status, logs, health
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml ps
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml logs --tail 100 api
# backup the database (run on the database host)
sudo -u postgres pg_dump --format=custom workforce > /backup/workforce-$(date +%F).dump
```
- **A later release:** restore the schema swap, pull, re-apply it, rebuild, migrate, recreate:
  ```powershell
  git checkout -- apps/api/prisma/schema.prisma
  git pull origin main
  Copy-Item apps\api\prisma\schema.postgresql.prisma apps\api\prisma\schema.prisma -Force
  docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml build --pull
  docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml run --rm migrate
  docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml up -d --force-recreate api web
  ```
- **Never** run `prisma db push` or a seed against production, and never edit an applied migration.
- Monitor `/healthz` (web) and `/api/health/ready` (API + database).
- Rotation notes: changing `JWT_SECRET` signs everyone out; changing `BOOTSTRAP_PASSWORD` affects only
  accounts provisioned afterwards.

---

## Appendix A — failure → fix

| Symptom | Cause | Fix |
|---|---|---|
| `[build-gate] Refusing to build: ... datasource provider` | Phase 2.3 skipped | run the `Copy-Item`, build again |
| `[build-gate] Refusing to build: a shared first password is hardcoded in the source.` | someone put a password literal back into the source | remove it; the password belongs in `.env.production` |
| build stops on `npm ci` with a network error | Docker Desktop has no proxy/DNS | check Docker Desktop's network settings, retry with `--pull` |
| `no pg_hba.conf entry for host "10.5.1.193"` | Phase 1.5 missing (or the source address differs) | add the line for the real address, `sudo systemctl reload postgresql` |
| `connect ECONNREFUSED 10.5.1.178:5432` | firewall, `listen_addresses`, or the wrong host | Phase 1.2/1.6, then `Test-NetConnection` |
| `server does not support SSL connections` | `sslmode=require` against a server without TLS | use `sslmode=prefer` |
| `password authentication failed for user "workforce_app"` | wrong password, or a value that got truncated by an unquoted `#`, or special characters not percent-encoded | Phase 0 password rule; quote env values |
| Login (or any save) answers **500 Internal server error** while the pages load fine | the browser's origin is missing from `CORS_ORIGINS`: browsers send an `Origin` header on POST/PUT/DELETE even for same-origin calls, so the API refused the request. Fix the list (comma-separated, no trailing slash) and re-create the api container: `docker compose ... up -d --force-recreate api`. Since 2026-09-23 a same-origin call is always allowed and a foreign origin answers `403 ORIGIN_NOT_ALLOWED` with a warning in the log instead of a 500 |
| `CORS_ORIGINS must contain exact, valid origins in production.` | `*` or a placeholder origin | put the exact `http://10.5.1.193:8099` |
| `JWT_SECRET must be a non-placeholder secret of at least 32 characters` | the example value was kept | generate and paste a real one |
| `SQLite is not permitted in production.` | a dev `.env` was copied | `DATABASE_URL` must be the `postgresql://` URL |
| `prisma:warn Prisma failed to detect the libssl/openssl version` followed by `Error: Can't write to /app/node_modules/@prisma/engines` | the slim Node base image has no `openssl` CLI, so Prisma could not detect OpenSSL, fell back to the `openssl-1.1.x` engine and tried to download it as an unprivileged user | fixed in the image (the `openssl` package is installed in the build/migrate/api stages, and the engine directories are chowned to `node`). Pull the fix, then rebuild: `git checkout -- apps/api/prisma/schema.prisma; git pull origin main; Copy-Item apps\api\prisma\schema.postgresql.prisma apps\api\prisma\schema.prisma -Force; docker compose ... build --pull` |
| a stale migration folder in the working tree breaks `migrate deploy` (for example `20260826115630_init` from an older checkout) | `prisma migrate deploy` applies EVERY folder under `prisma/migrations`, in filename order, and the `migrate` image is built from that folder | delete the untracked folder(s), confirm `git status --short` shows only the schema swap, then rebuild the migrate image: `docker compose ... build migrate` |
| `migrate` exits non-zero with `column ... already exists` | `01-schema.sql` was applied by hand | drop the database (`DROP DATABASE workforce;` then Phase 1.4) and let `migrate` run |
| web is up but the pages are blank | the API is unhealthy behind nginx | `docker compose ... logs api`, then `/api/health/ready` |
| `Login failed for user 'it'` (sync) | unquoted `#` in `BADGEVIEW_DB_PASSWORD` | quote the value: `BADGEVIEW_DB_PASSWORD="Swan!@#..."` |
| `/api/health/ready` is 503 right after `up -d` | the api container is still starting | wait 15 s and re-run; then read `logs api` |

## Appendix B — the whole sequence, condensed

```bash
# ---- 10.5.1.178 (Linux) ----
sudo -u postgres psql -tAc "select version(); show port;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE workforce_app LOGIN PASSWORD 'WorkforceDb2026Pass';"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE workforce OWNER workforce_app ENCODING 'UTF8' TEMPLATE template0;"
HBA="$(sudo -u postgres psql -tAc 'show hba_file')"; echo "host    workforce    workforce_app    10.5.1.193/32    scram-sha-256" | sudo tee -a "$HBA"; sudo systemctl reload postgresql
sudo ufw allow from 10.5.1.193 to any port 5432 proto tcp
```
```powershell
# ---- 10.5.1.193 (Windows PowerShell) ----
cd C:\Project; git clone <repository-url> workforce-prod; cd workforce-prod; git checkout main
Copy-Item apps\api\prisma\schema.postgresql.prisma apps\api\prisma\schema.prisma -Force
Copy-Item infra\docker\.env.production.example infra\docker\.env.production; notepad infra\docker\.env.production
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml build --pull
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml up -d
curl.exe -fsS http://127.0.0.1:8099/api/health/ready
docker compose --env-file infra/docker/.env.production -f infra/docker/compose.production.yml run --rm api node apps/api/scripts/create-first-admin.mjs
New-NetFirewallRule -DisplayName "Workforce web 8099" -Direction Inbound -Protocol TCP -LocalPort 8099 -Action Allow
```
