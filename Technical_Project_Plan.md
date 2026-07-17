# Manpower & Timesheet App
*Technical Project Plan (Draft v0.1) — Python / Node.js / PostgreSQL*

## 1. Overview

This plan translates the BRD and wireframes already agreed (Select Team, Daily Timesheet Entry, Summary) into a buildable technical design — architecture, database schema, API surface, core business logic, and a sprint-level delivery plan.

> **Note on scope:** the wireframes designed so far (hourly grid entry, per-project tagging, approval chain, Summary reporting) are Phase 2-level detail. If Phase 1 is meant to ship in ~2 weeks as a lighter headcount-only build, that needs to be explicitly re-scoped as a subset of what's below — see Section 8.

---

## 2. Technical Architecture

### 2.1 Stack & Rationale

| Layer | Technology | Why |
|---|---|---|
| Frontend | React.js (mobile-first, responsive CSS) | Matches the mobile-friendly web app requirement; single codebase serves Supervisor, HOD, PM, HR, Finance views. |
| Backend API | Node.js (Express or Fastify) + TypeScript | Handles auth, business logic, and REST endpoints; good fit for the approval-workflow, I/O-heavy nature of this app. |
| Integration / Batch Jobs | Python (scripts + APScheduler) | CLMS attendance pull, SAP WBS/cost master sync, nightly duplicate-tagging validation, reminder triggers — Python is the stronger fit for ETL-style jobs and SAP interfacing (e.g. pyrfc, or file-based exchange in Phase 1). |
| Database | PostgreSQL 15+ | Relational integrity for approval chains and roster history; strong JSONB support for audit metadata; free, mature, on-prem friendly. |
| Scheduling | node-cron (in-app reminders) + Python APScheduler/cron (integration jobs) | Keeps app-level and data-integration jobs cleanly separated by owner. |
| Auth | JWT session auth; AD/SSO integration if available | To be confirmed with IT — see Open Decisions. |

### 2.2 High-Level Flow

```
React (Employee/Supervisor/HOD/PM/HR/Finance views)
        |  HTTPS / REST + JWT
        v
Node.js API (Express) — business logic, RBAC, approval workflow
        |
        v
PostgreSQL  <---- Python integration jobs (CLMS pull, SAP WBS/cost sync,
        ^          EOD duplicate-check, reminder triggers — scheduled)
        |
   Nightly backup / audit export
```

---

## 3. Database Design (PostgreSQL)

Core tables and purpose. Full DDL to be finalized during Sprint 0; key tables shown in more detail below given they carry the trickiest logic (roster fluidity, duplicate-tagging, approvals).

| Table | Purpose |
|---|---|
| `users` | App login accounts — role (Supervisor/HOD/PM/HR/Finance/Admin), linked employee record. |
| `departments` | Master list of departments. |
| `employees` | HR-owned master — EC no., name, department, designation, category (associate/contractor/on-roll). |
| `projects_wbs` | Valid project/WBS list, sourced from SAP (or fed manually in Phase 1). |
| `daily_team_selection` | Supervisor's team-for-the-day list (Select Team screen) — see 3.1. |
| `timesheet_entries` | Hour-level tagging records — see 3.2. |
| `approvals` | Approval chain records per entry/batch — Supervisor/HOD/PM sign-off. |
| `conflicts` | Duplicate-tagging conflicts flagged by EOD validation — see 3.3. |
| `manpower_requests` | Inter-department manpower request/fulfillment records. |
| `attendance_feed` | Daily attendance pulled from CLMS. |
| `cost_rates` | Average labour rate by category, effective-dated, sourced from CLMS. |
| `audit_log` | Append-only record of who changed what, when — every add/edit/remove/approve/reject. |

### 3.1 `daily_team_selection`

```sql
id              BIGSERIAL PRIMARY KEY
supervisor_id   FK -> users.id
employee_id     FK -> employees.id
work_date       DATE
source          ENUM('carried_over','added','removed')
created_at      TIMESTAMP
removed_at      TIMESTAMP NULL   -- set on Remove; row kept for audit, not deleted

UNIQUE (employee_id, work_date) WHERE removed_at IS NULL
  -- soft constraint only; real duplicate check happens via EOD job (3.3),
  -- since two supervisors are both allowed to add before validation runs
```

### 3.2 `timesheet_entries`

```sql
id              BIGSERIAL PRIMARY KEY
employee_id     FK -> employees.id
work_date       DATE
hour_slot       SMALLINT   -- 0=8AM ... 12=8PM
project_wbs_id  FK -> projects_wbs.id
tagged_by       FK -> users.id   -- supervisor of record for this entry
status          ENUM('draft','submitted','sup_approved','hod_approved',
                     'pm_approved','rejected')
remarks         TEXT
created_at, updated_at   TIMESTAMP
```

### 3.3 `conflicts`

```sql
id                 BIGSERIAL PRIMARY KEY
employee_id        FK -> employees.id
work_date          DATE
supervisor_id_1    FK -> users.id
supervisor_id_2    FK -> users.id
status             ENUM('open','resolved')
resolved_by        FK -> users.id NULL
resolved_at        TIMESTAMP NULL
detected_at        TIMESTAMP   -- set by nightly EOD job
```

---

## 4. API Design (Node.js REST)

| Screen / Area | Key Endpoints |
|---|---|
| Auth | `POST /auth/login` |
| Select Team | `GET /teams/pool?department_id&date` • `GET /teams/today?supervisor_id&date` • `POST /teams/today` • `DELETE /teams/today/:employeeId` |
| Timesheet Entry | `GET /timesheet?date&supervisor_id` • `POST /timesheet/entry` • `PUT /timesheet/entry/:id` • `POST /timesheet/submit` |
| Approvals | `GET /approvals/pending?role&approverId` • `POST /approvals/:id/approve` • `POST /approvals/:id/reject` |
| Conflicts | `GET /conflicts?date` • `POST /conflicts/:id/resolve` |
| Summary | `GET /summary?frequency&projectIds[]&groupBy&view` |
| Manpower Requests | `GET /requests` • `POST /requests` • `POST /requests/:id/assign` • `POST /requests/:id/reject` |
| Admin / Master Data | CRUD on `/admin/projects-wbs`, `/admin/users`, `/admin/departments` |

---

## 5. Key Business Logic

### 5.1 Daily Roster Default

```
On Select Team screen load for (supervisor, date):
  if daily_team_selection has rows for (supervisor, date): return them
  else: copy prior working day's active rows as 'carried_over',
        supervisor edits (add/remove) from there
```

### 5.2 EOD Duplicate-Tagging Validation (nightly Python job)

```
For each work_date being closed:
  group timesheet_entries by employee_id
  where tagged_by has more than one distinct supervisor_id
    -> create/verify a row in `conflicts`
    -> block those employees' entries from progressing to HOD approval
    -> notify both supervisors involved
  entries for employees with no conflict proceed to approval normally
```

### 5.3 Approval State Machine

```
draft -> submitted -> (Phase 2: sup_approved ->) hod_approved -> pm_approved -> sent to Finance/HR
any state -> rejected -> back to draft (employee/supervisor refills; resubmits)
```

### 5.4 Cost Calculation (Phase 1)

`cost = hours × cost_rates.rate_per_hour` (by employee category, effective-dated). No per-employee actual wage — matches the BRD's Out of Scope on individual cost rates.

---

## 6. Non-Functional Requirements

- Role-based access control — every endpoint checks the caller's role against the action.
- Full audit trail — every add/edit/remove/approve/reject writes to `audit_log`; nothing is hard-deleted.
- Mobile-responsive UI, tested on common Android browsers used at site.
- Nightly PostgreSQL backup; `audit_log` retained indefinitely (or per company data retention policy — to confirm).
- Target load: low-to-moderate concurrency (tens of supervisors submitting around shift end) — no high-scale infra needed.

---

## 7. Delivery Plan — Sprint Breakdown

Assumes a small team (see Section 9) and the full Phase 2-level scope shown in the wireframes. Total ~12–13 weeks — consistent with the BRD's existing Phase 2 estimate.

| Sprint | Duration | Scope |
|---|---|---|
| Sprint 0 — Setup | 1 week | Repo, CI/CD, dev/staging environments, DB schema v1, auth scaffolding. |
| Sprint 1 | 2 weeks | Master data (employees, departments, projects/WBS) — manual feed. Select Team screen + roster default logic. |
| Sprint 2 | 2 weeks | Timesheet Entry screen — hourly grid, project/WBS tagging, draft/submit. |
| Sprint 3 | 2 weeks | Approval workflow (Supervisor/HOD/PM), EOD duplicate-tagging job, reminders/escalations. |
| Sprint 4 | 2 weeks | Summary screen — grouping, hours/cost views, Finance/HR export. |
| Sprint 5 | 2 weeks | CLMS attendance pull + SAP WBS/cost sync (Python jobs) — or remain manual-feed if integration is deferred. |
| Sprint 6 | 1–2 weeks | UAT, bug-fixing, deployment, training. |

---

## 8. Phase 1 Re-Scoping — Needs a Decision

The BRD's original Phase 1 ("2 weeks") assumed a much lighter headcount-per-project build. What's been designed since (Select Team, hourly grid, EOD conflict logic) is Phase 2-level detail. Two honest options:

- **Option A:** Treat Sections 1–7 above as the real, single build (~12–13 weeks) and retire the "2-week Phase 1" framing in the BRD/PPT.
- **Option B:** Build a genuinely reduced Phase 1 — Select Team + a simple daily headcount count per project (no hourly grid, no per-hour tagging) — deliverable in ~2 weeks, with the hourly grid added in Phase 2 (Sprints 2–6 above).

**Recommend deciding this before Sprint 0 starts, since it changes what Sprint 1–2 actually build.**

---

## 9. Team & Roles

| Role | Allocation |
|---|---|
| Node.js Backend Developer | Full-time |
| React Frontend Developer | Full-time (or combined as one full-stack JS developer) |
| Python Integration Developer | Part-time — ramps up for Sprint 5 (CLMS/SAP sync) |
| QA / Tester | Part-time through build, full-time Sprint 6 |
| DBA support | Shared / part-time, for schema review and backup setup |
| Product Owner / BA | You — requirements, UAT sign-off, stakeholder liaison |

---

## 10. Open Technical Decisions

- Hosting: on-prem server/VM vs. cloud — confirm with IT.
- Auth: standalone login vs. integration with existing AD/SSO.
- Reminder channel: email vs. SMS/WhatsApp — shop-floor supervisors may not check email regularly.
- Connectivity at site: is offline/low-connectivity support needed for the mobile entry screen?
- Device provisioning: company-provided devices vs. supervisors' own phones (BYOD).
- Data retention policy for `audit_log` and historical timesheet data.

---

## 11. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| CLMS/SAP integration delayed by vendor | Manual-feed fallback (already scoped) keeps the app usable independent of integration timing. |
| Roster fluidity causes frequent duplicate-tagging conflicts | EOD validation + clear resolution flow (Section 5.2); monitor conflict volume post-launch and revisit if high. |
| Low adoption at site (connectivity, device access) | Confirm device/connectivity assumptions early (Section 10) before UI is finalized. |
| Phase 1/2 scope ambiguity | Resolve per Section 8 before Sprint 0. |
