# Runbook — one HOD over Yardservice EOU + SEZ (multi-Department scope)

> **If you are deploying `5743cf9` or later, read §13 first.** It lists the two things this document's
> step-by-step does not yet contain: one extra migration (`20261126130000_department_identity`) and one
> backfill script. Everything below that §13 does not contradict is still the procedure.

Release content: `user_scope_departments` (migration `20261119000000_user_scope_departments`),
grant-aware HOD scope in the API, and a `PUT /api/admin/users/:id/hod-scope` that accepts
`grants[]` **and no longer re-points the person's Employee**.

Second release (`5743cf9`): the grants can be written **from the UI**, and a Department now stores its
**plant** (`business_unit`) and **function** (`function_group`) so one function at two facilities is
visible as one function. See §13.

Target: production on **10.5.1.193** (Windows, Docker Desktop, checkout `C:\workforce`),
PostgreSQL on **10.5.1.178**, UI on `http://10.5.1.193:8099`. API and database are never published.

The change is **additive**: one new table, no column changes, no backfill. An account with no rows in
`user_scope_departments` behaves exactly as before, so the deploy is safe before any grant is written
and a rollback to the previous image is safe afterwards.

---

## 0. Preconditions

- [ ] The release is **committed** and merged into the branch production deploys from (`main`).
      Uncommitted files on the build host are not deployed — the image is built from the checkout.
- [ ] `Docker Desktop` running with **Linux containers**.
- [ ] You can reach the database host `10.5.1.178` (`Test-NetConnection 10.5.1.178 -Port 5432`).
- [ ] You have an **Admin login** for the UI (needed to write the grants through the API).

Set two variables in PowerShell so every command below is copy-paste:

```powershell
cd C:\workforce
$envFile = "infra\docker\.env.production"
function wfc { docker compose --env-file "infra\docker\.env.production" -f "infra\docker\compose.production.yml" $args }
```

A variable holding command arguments does not work in PowerShell (`$compose up -d` would try to run a
command literally named after the string), so the examples below use the `wfc` function defined above:
`wfc ps`, `wfc build --pull`, `wfc run --rm migrate`, ...

---

## 1. Take a backup (do not skip)

On the **database host** (`10.5.1.178`):

```bash
sudo -u postgres pg_dump --format=custom workforce > /var/backups/workforce-$(date +%Y%m%d-%H%M).dump
ls -lh /var/backups/workforce-*.dump | tail -3
```

Restore path if needed (into an empty database, never over the live one):

```bash
sudo -u postgres createdb workforce_restore
sudo -u postgres pg_restore --dbname=workforce_restore --no-owner /var/backups/workforce-<stamp>.dump
```

---

## 2. On the deployment host: pull and tag the revision

```powershell
cd C:\workforce
git checkout -- apps/api/prisma/schema.prisma                 # undo the local PostgreSQL swap
git checkout -- apps/api/src/services/defaultLoginCredentials.ts
git pull origin main
git checkout -- apps\api\prisma\schema.prisma                 # re-apply the production schema
git log --oneline -1
```

Tag the image with the commit, otherwise `build` and `up -d` both look successful while the old
container keeps serving the old code:

```powershell
$tag = git rev-parse --short HEAD
(Get-Content $envFile) -replace '^IMAGE_TAG=.*$', "IMAGE_TAG=$tag" | Set-Content $envFile
Select-String $envFile -Pattern '^IMAGE_TAG='
```

If `IMAGE_TAG` is not in the file yet, add it: `Add-Content $envFile "IMAGE_TAG=$tag"`.

The migration file must be present in the checkout before building — the `migrate` image copies
`apps/api/prisma` and nothing else:

```powershell
Test-Path apps\api\prisma\migrations\20261119000000_user_scope_departments\migration.sql
```

---

## 3. See which migrations will run

The `migrate` container applies **every pending migration**, not only this one. Check first:

```powershell
wfc run --rm migrate npx prisma migrate status --schema apps/api/prisma/schema.prisma
```

Expected: `Database schema is up to date!` plus exactly one pending migration
(`20261119000000_user_scope_departments`). If the list is longer, that is fine — but read it before
you run step 5, because they all apply together.

---

## 4. Build

```powershell
wfc build --pull
```

The build refuses a hardcoded bootstrap password; that is the only deliberate gate here.

---

## 5. Apply the migration

```powershell
wfc run --rm migrate
```

Expected tail: `Applying migration 20261119000000_user_scope_departments` then
`All migrations have been successfully applied.` If it fails, **stop** — the API is still on the old
image and still serving. Read `wfc logs migrate`.

---

## 6. Deploy the new code

`up -d` alone is a **no-op** when the containers are already running; the recreate is the lever:

```powershell
wfc up -d --force-recreate api web
wfc ps
```

Never `docker compose down` here: it drops the network and the `attachments` volume from the running
set, and the approval-cover/hod-scope work is unrelated to them.

---

## 7. Verify the deployment before touching any scope

```powershell
curl.exe -fsS http://127.0.0.1:8099/healthz
curl.exe -fsS http://127.0.0.1:8099/api/health/ready
```

`/api/health/ready` green = the API reaches PostgreSQL. Two more proofs, no `psql` needed on the
Windows host. **Quote these with single quotes in PowerShell** — the JavaScript contains `$`, which
PowerShell would otherwise expand inside a double-quoted string:

```powershell
wfc exec api node -e 'const{PrismaClient}=require("@prisma/client");const p=new PrismaClient();(async()=>{console.log("grant rows:",await p.userScopeDepartment.count());await p.$disconnect()})()'
```

Expected: `grant rows: 0`. **0 is correct at this point** — no account has a grant yet and every HOD
still behaves exactly as before. If this throws `Cannot read properties of undefined`, the migration
did not run: go back to step 5.

Then prove the new code, not just a healthy container. The `/api/auth/me` payload (and the login
response) now carries `hodScope` and `scopeDepartments`; the old image does not. Log in as an Admin
(step 9a) and check for those keys — if they are absent, the old container is still serving and
`--force-recreate` did not take.

---

## 8. Look up the production ids (they are NOT the dev ids)

Department ids 11/12 and user id 122 exist only on the development database. Read the real ones:

```powershell
wfc exec api node -e 'const{PrismaClient}=require("@prisma/client");const p=new PrismaClient();(async()=>{console.log(await p.department.findMany({where:{name:{contains:"Yardservice",mode:"insensitive"}},select:{id:true,name:true,active:true},orderBy:{name:"asc"}}));console.log(await p.user.findMany({where:{employee:{ecNo:"40030342"}},select:{id:true,name:true,role:true,departmentId:true,sectionId:true,scopeDepartments:{select:{departmentId:true}}}}));await p.$disconnect()})()'
```

Write down:

| Value | Meaning |
|---|---|
| `USER_ID` | the HOD's **user** id (not the employee id) |
| `EOU_DEPT` | id of `Yardservice - EOU` |
| `SEZ_DEPT` | id of `Yardservice - SEZ` |

If the user row returns **nothing**, or returns `role <> 'HOD'`, stop and do that first: the grant
endpoint answers `404 HOD account not found.` until the account is an HOD. Register him through
**Role Assignment** (or `POST /api/admin/hods`) on the EOU Department, then continue.

Check that the SEZ plant has no head of its own — the requirement is that it stays unallotted:

```powershell
wfc exec api node -e 'const{PrismaClient}=require("@prisma/client");const p=new PrismaClient();(async()=>{console.log(await p.userScopeDepartment.findMany({select:{userId:true,departmentId:true,user:{select:{name:true,role:true}}}}));await p.$disconnect()})()'
```

---

## 9. Write the grants — through the API (recommended)

The endpoint validates the Department/Section rules and writes an audit row. The old code path moved
the person's Employee onto the granted Department; this release does not, which is the whole point.

**9a. Get an Admin token** (use the Admin's real login; the token is a session, no secret is printed):

```powershell
$login = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8099/api/auth/login" -ContentType "application/json" -Body '{"email":"<admin email>","password":"<admin password>"}'
$hdr = @{ Authorization = "Bearer $($login.token)" }
$login.user.role
```

**9b. Assign both plants to one account:**

```powershell
$body = @{ grants = @(
    @{ departmentId = <EOU_DEPT>; sectionIds = @() },
    @{ departmentId = <SEZ_DEPT>; sectionIds = @() }
) } | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:8099/api/admin/users/<USER_ID>/hod-scope" `
  -Headers $hdr -ContentType "application/json" -Body $body
```

`sectionIds = @()` (empty) means **every Section of that Department, including Sections the nightly
BadgeView sync creates later** — that is what the requirement asks for. Expected answer:

```
user        : @{id=…; departmentId=<EOU_DEPT>; sectionId=}
grants      : {@{departmentId=<EOU_DEPT>; sectionIds={}}, @{departmentId=<SEZ_DEPT>; sectionIds={}}}
description : Yardservice - EOU (all Sections); Yardservice - SEZ (all Sections)
```

Two refusals you may hit, both correct:

| Answer | Meaning / fix |
|---|---|
| `409 OPEN_TIMESHEETS` | he has SUBMITTED or HOD_APPROVED **My Hours** days. Clear/approve them, then repeat. |
| `400 SCOPE_DEPARTMENT_OVERLAP` / `SECTION_NOT_IN_GRANTED_DEPARTMENT` | the two grants name the same Department, or a `sectionIds` entry belongs to a Department you did not grant. |

### 9c. Fallback only if no Admin login is available (SQL, no validation, no audit row)

Run on the **database host**, then sign the account out by bumping `token_version`:

```bash
sudo -u postgres psql -d workforce -c \
"insert into user_scope_departments (user_id, department_id) values (<USER_ID>, <EOU_DEPT>), (<USER_ID>, <SEZ_DEPT>) on conflict do nothing;
 update users set department_id = <EOU_DEPT>, section_id = null, token_version = token_version + 1 where id = <USER_ID>;"
```

Do not touch `employees` — his Employee master stays on his home plant.

---

## 10. Verify in production

**10a. The scope the API will actually apply** (same shape the middleware hydrates). Log in **as him**
in the UI (he is signed out by the `tokenVersion` bump) and read `/api/auth/me`, or run the
read-only diagnostic baked into the API image:

```powershell
wfc exec api node apps/api/scripts/hod-scope-report.mjs 40030342
```

Expected, in order:

- `AUTHORITY (grants): Department <EOU_DEPT> (all Sections); Department <SEZ_DEPT> (all Sections)`
- `MULTI-DEPARTMENT: this account heads 2 Departments.`
- every Section of both plants showing `in scope: yes`
- the employee count = both plants' headcount, not one

**10b. Nothing moved the person:**

```powershell
wfc exec api node -e 'const{PrismaClient}=require("@prisma/client");const p=new PrismaClient();(async()=>{console.log(await p.employee.findFirst({where:{ecNo:"40030342"},select:{ecNo:true,departmentId:true,sectionAssignment:{select:{section:{select:{id:true,name:true,departmentId:true}}}}}}));await p.$disconnect()})()'
```

Must still be his **home** plant and his own Section.

**10c. In the application, as him:** Approvals lists sheets from Supervisors of **both** plants; the
Employee list and the operations report cover both; My Hours approvals cover both. As an **Admin**:
Role Assignment shows him with both Departments.

---

## 11. Rollback

The table is additive and the old image ignores it, so a rollback is a redeploy of the previous tag:

```powershell
(Get-Content $envFile) -replace '^IMAGE_TAG=.*$', "IMAGE_TAG=<previous tag>" | Set-Content $envFile
wfc up -d --force-recreate api web
```

Do **not** drop `user_scope_departments` and do **not** re-point his Employee: the old image reads
`users.department_id` only (still his home plant) and ignores the grants, which is exactly the
pre-release behaviour.

The migration cannot be "rolled back" by Prisma — `20261119000000_user_scope_departments` stays in
`_prisma_migrations` and the table stays empty-but-present. That is intentional and harmless.

---

## 12. Notes for the people who use it

- The `tokenVersion` bump **signs him out once**. He must log in again for the UI to show both
  Departments; approvals are already correct server-side before he does.
- **Do not merge the two Departments.** The nightly BadgeView sync recreates `Department` rows by
  name (`services/badgeViewSync.ts`), so a merge is undone the same night, and Section names collide
  across plants on `@@unique([departmentId, name])`.
- The reporting rollup ("several Departments shown as one") is a **separate** structure
  (`department_groups`) that grants no approval rights and is not part of this release.
- There is no reporting rollup in the UI yet for *setting* a second Department by hand outside the
  screen: use **Employees → HOD list → Map scope** or **Role Assignment → Approval scope** (both now
  write the full grant set). The API below remains the scriptable path, and it is what §9 uses.

---

## 13. Release `5743cf9` — the scope is set from the UI, and a Department knows its plant and function

Two differences from the procedure above, both small:

1. **One more migration**: `20261126130000_department_identity` — `ALTER TABLE departments ADD COLUMN
   business_unit TEXT`, `ADD COLUMN function_group TEXT`, one index. Nullable and additive: no row is
   rewritten, no `UPDATE` runs, nothing is dropped. The API selects those two columns, so **this
   migration must be applied before the new API image serves** — the old image is unaffected, so
   applying it first is safe and reversing the app afterwards is safe too (the columns stay, harmless).
2. **One backfill script** to fill the columns for the Departments that already exist. It is idempotent
   and takes `--dry-run`.

Ordering that keeps the site up: backup → pull → tag → `migrate status` → **migrate** → build →
`up -d --force-recreate api web` → health → **backfill --dry-run** → **backfill** → UI check.

```powershell
cd C:\workforce
$envFile = "infra\docker\.env.production"
function wfc { docker compose --env-file "infra\docker\.env.production" -f "infra\docker\compose.production.yml" $args }

git checkout -- apps/api/prisma/schema.prisma
git checkout -- apps/api/src/services/defaultLoginCredentials.ts
git pull origin main
git checkout -- apps\api\prisma\schema.prisma
git log --oneline -1                       # expect 5743cf9 (or later)

$tag = git rev-parse --short HEAD
(Get-Content $envFile) -replace '^IMAGE_TAG=.*$', "IMAGE_TAG=$tag" | Set-Content $envFile

Test-Path apps\api\prisma\migrations\20261126130000_department_identity\migration.sql   # must be True

wfc build --pull                                        # builds migrate + api + web for the new tag
wfc run --rm migrate npx prisma migrate status --schema apps\api\prisma\schema.prisma    # exactly 1 pending
wfc run --rm migrate                                                                    # applies it
wfc up -d --force-recreate api web
wfc ps
curl.exe -fsS http://127.0.0.1:8099/healthz
curl.exe -fsS http://127.0.0.1:8099/api/health/ready
```

`build` comes before `migrate` on purpose: the `migrate` service runs the image `workforce-migrate:<tag>`,
so the tag has to exist before that image can be run. `api` also declares
`depends_on: migrate: service_completed_successfully`, so `up -d` repeats the migrate step — it prints
`No pending migrations to apply` and is a no-op the second time.

Prove the columns exist and are still empty (expected `0` before the backfill):

```powershell
wfc exec api node -e 'const{PrismaClient}=require("@prisma/client");const p=new PrismaClient();(async()=>{console.log("departments:",await p.department.count(),"with plant:",await p.department.count({where:{businessUnit:{not:null}}}));await p.$disconnect()})()'
```

**Backfill — dry run first, and read it.** It prints every Department whose plant/function it would set
or correct, and how many functions end up with both plants:

```powershell
wfc exec api node apps/api/scripts/backfill-department-identity.mjs --dry-run
```

Then write it, and re-run the dry run: it must report `to write: 0` / `unchanged: 30` (that is the
idempotence check — the first run prints `to write: <departments>`):

```powershell
wfc exec api node apps/api/scripts/backfill-department-identity.mjs
wfc exec api node apps/api/scripts/backfill-department-identity.mjs --dry-run
```

Check the split is what the yard means (one line per function, both plants listed):

```powershell
wfc exec api node -e 'const{PrismaClient}=require("@prisma/client");const p=new PrismaClient();(async()=>{const d=await p.department.findMany({select:{name:true,businessUnit:true,functionGroup:true},orderBy:[{functionGroup:"asc"},{businessUnit:"asc"}]});console.table(d);await p.$disconnect()})()'
```

Two things to look at in that table: a Department with **no** plant suffix must have
`businessUnit = null` (it is not part of a plant split), and `functionGroup` must never swallow the
plant (`Yardservice`, not `Yardservice - EOU`). If one row is wrong, correct it in
**Organisation → Organisation** (the *Plant* and *Function* fields are editable in the row's dialog)
rather than re-running SQL.

**Then set the scope from the UI, no curl:**

1. **Role Assignment** → pick the person → role `HOD` → the *Approval scope* panel lists every
   Department grouped by **function**, with the plants side by side (EOU before SEZ).
2. Tick `Yardservice - EOU` **and** `Yardservice - SEZ`, leave both on **Whole Department**.
3. Read the sentence under the panel — it must name both plants — then **Apply**. He is signed out once
   (`tokenVersion` bump), which is expected.
4. The same panel is reachable afterwards from **Employees → HOD list → Map scope**; it reopens with
   both plants ticked, so a later save cannot silently narrow him to one.

Verify exactly as in §10 (the `hod-scope-report` script and the Employee-record check are unchanged).

**Rollback** is §11: revert `IMAGE_TAG`, `up -d --force-recreate api web`. The two columns stay and the
old image ignores them.

