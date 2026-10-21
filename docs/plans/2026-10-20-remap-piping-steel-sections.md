# Remapping PIPING and STEEL to the new SEZ departments

**Status:** PIPING CONFIRMED (20-10-2026) — PIPING only, old Section stays active, STEEL deferred.
Nothing has been written to production.
**Date:** 20-10-2026
**Tool:** `apps/api/scripts/remap-section.mjs` (dry run by default; `--apply` to commit; `--rollback <id>` to undo one run)

---

## 1. What the screenshot maps

| Old | New | Decision |
|---|---|---|
| `Production - SEZ` / `PIPING` (`#16`) | `Production Outfitting - Piping - SEZ` / `OUTFITTING_PIPING` (`#46`) | **IN SCOPE — all data moves, the old Section stays active** |
| `Production - SEZ` / `STEEL` (`#41`) | `Production Outfitting - Steel - SEZ` / `OUTFITTING_STEEL` (`#47`) | **DEFERRED — not part of this change** |

Confirmed 20-10-2026: the old Department and the old `PIPING` section both **remain in service**. Nothing
is deactivated, so the `--deactivate-old-section` flag is not used. After the move, section `#16` is
empty and still selectable — that is intended.

Note the **Steel** department's full name ends in `- SEZ`, not `- SE` as the screenshot's column width
suggests. The script resolves names exactly and refuses an ambiguous match, so a truncated name is
reported, never guessed.

`Production - SEZ` itself survives: it still owns `ELECTRICAL`, `HEAVY_ENGINEERING` and
`HULL_AND_OUTFITTING`. This is a **split of two sections**, not the retirement of a department.

## 2. What actually stores a department and a section

Five tables carry the same organisational fact, which is why a handful of `UPDATE`s is the wrong
instrument:

| Table | Column | Meaning |
|---|---|---|
| `job_orders` | `department_id`, `section_id` | the live master — the Job Order's department today |
| `timesheet_entries` | `department_id`, `section_id` | **a snapshot taken when the hours were booked** |
| `employees` | `department_id` | the person's department |
| `employee_section_assignments` | `section_id`, `source` | the person's section; `SYNC` = CLMS wrote it, `MANUAL` = pinned |
| `users` / `user_scope_sections` | `department_id`, `section_id`, scope rows | the **HOD's approval scope** — what decides who approves |

`approvals.approver_id` is deliberately untouched: who signed a sheet stays who signed it. Hours,
projects and payroll are untouched — only the department/section attribution moves.

## 3. Counts on the restored production copy

These are from the local restore and are the shape of the change; **run the dry run against
production to get the real numbers before applying anything**.

| | PIPING → OUTFITTING_PIPING | STEEL → OUTFITTING_STEEL |
|---|---|---|
| Job Orders | 2 | 3 |
| Timesheet entries | 436 (48 HOD-approved, 388 PM-approved) | 240 (28 HOD-approved, 212 PM-approved) |
| Employees assigned | 8 (5 `SYNC`, 3 `MANUAL`) | 1 (`MANUAL`) |
| Accounts scoped to the section | 1 (the HOD) | 1 (the HOD) |
| Allocations / progress / delegations / overrides / cost centres | 0 | 0 |
| Already on the target section | 0 | 0 |

The target sections are **empty**, so nothing is being merged — the script refuses if they are not.

## 4. The decision this makes explicit

`TimesheetEntry.department_id / section_id` is a **frozen snapshot**, on purpose: the schema comment
says a later master-data remap must not move approved history, so that a report from August still reads
as the organisation looked in August.

Moving it anyway is what you asked for, and it is defensible here — the old sections are being retired,
and leaving 676 rows attributed to a section nobody can pick any more is worse than the loss of
historical fidelity. But it must be said plainly:

- **department and section totals change retroactively.** `Production - SEZ` loses 676 entries; the two
  new departments gain them. Any report or export already filed under the old split will no longer
  reconcile.
- **approval records do not change.** `approvals` still shows Rameshkumar Vaniya and Ankit Singh as the
  signatories.
- **payroll hours do not change.** They never depended on the section.

If you would rather keep history frozen, run the script with the entries step excluded — say so and I
will add `--skip-history`. My recommendation is to move them, because the old sections are going away.

## 5. The trap: CLMS will undo half of this

`employee_section_assignments.source` is `SYNC` for five of the eight Piping people, and the badge sync
rewrites those rows from CLMS on every run. **If CLMS still maps them to the old section, the next sync
puts them back** — the Job Orders and the history stay moved, and the people drift back, which is the
worst of both states.

Two honest remedies, in order of preference:

1. **Correct the mapping in CLMS.** It is the source of truth for those five; one correction there
   survives every future sync.
2. **Pin them** with an `employee_organisation_overrides` row (`department_id`, `section_id`, `reason`).
   That is the designed escape hatch: the sync reads the override and marks the assignment `MANUAL`
   instead of overwriting it. Use it for people CLMS cannot represent, not as a substitute for fixing
   CLMS.

The script prints the affected people by EC No and name at the end of a run, so nothing is hidden.

## 6. The other change nobody would think of

**The new departments have no HOD at all.** The two HODs concerned — Rameshkumar Vaniya (Piping) and
Harpal Khaniya (Steel) — are themselves sitting on the old sections. Until they move, a sheet routed to
`OUTFITTING_PIPING` has no approver, no department-wide head and no portfolio owner. The script moves
them (department, `section_id` mirror and `user_scope_sections`) as part of the same transaction, which
is why the five tables are moved together rather than one at a time.

Also worth confirming after the move:

- the two **supervisors** on the old Piping section (Bikas Behera, Vishal Bambhaniya) end up in the new
  department — a supervisor can only draw labour from sections of *his own* department, so one left
  behind sees an empty team pool;
- the old sections are **deactivated** once the screen looks right, so they stop appearing in pickers
  (never deleted — history and audit rows still reference them);
- no **`EmployeeOrganisationOverride`** still points at the old section (0 today, but check on production).

## 7. The run, in order

Every command runs inside the api container, which already has the database connection and Prisma.
`--apply` is what writes; without it nothing changes.

**a. Dry run — read the numbers, and check they match your expectation**

Run **PIPING only**. STEEL is a separate decision and nothing below touches it.

```powershell
dc exec api node apps/api/scripts/remap-section.mjs `
  --old-dept "Production - SEZ" --old-section PIPING `
  --new-dept "Production Outfitting - Piping - SEZ" --new-section OUTFITTING_PIPING
```

On the restored copy that prints:

```
job orders on the old section              2
  timesheet entries HOD_APPROVED           48
  timesheet entries PM_APPROVED            388
timesheet entries (total)                  436
employees assigned to the old section      8
  of which their assignment came from SYNC 5
accounts scoped to the old section         1
job orders already on the new section      0
timesheet entries already on the new section 0
```

Production will differ — read the numbers, do not assume them.

**b. Apply — PIPING only**

```powershell
dc exec api node apps/api/scripts/remap-section.mjs `
  --old-dept "Production - SEZ" --old-section PIPING `
  --new-dept "Production Outfitting - Piping - SEZ" --new-section OUTFITTING_PIPING --apply
```

Read the `LEFT BEHIND ON THE OLD SECTION` block: all four counts must be **0**. If any is not, stop and
investigate before going further.

**c. Do NOT deactivate anything.** The confirmed decision is that `Production - SEZ` and the `PIPING`
section stay in service. Section `#16` will be empty and still selectable, which is intended. The
`--deactivate-old-section` flag exists but is not used here.

**d. Undo one run** — by the audit row it wrote, which names the exact rows it moved

```powershell
dc exec api node apps/api/scripts/remap-section.mjs --rollback <auditId> --apply
```

The audit id is the newest `SECTION_REMAP` row:

```sql
select id, created_at, metadata from audit_log where action='SECTION_REMAP' order by id desc;
```

Rollback moves back **only the ids that run moved**. It deliberately does not "move everything on the
new section back", because people who joined the new section afterwards from CLMS would be dragged with
it — that is a second change, not an undo.

## 8. Verify

**In the API** (any of these can be run from the container):

```powershell
dc exec api node -e "const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();(async()=>{console.log('old piping rows', await p.timesheetEntry.count({where:{sectionId:16}}));console.log('new piping rows', await p.timesheetEntry.count({where:{sectionId:46}}));console.log('hod scope', await p.userScopeSection.findMany({where:{userId:74},select:{sectionId:true}}));await p.\$disconnect()})()"
```

**Verify by section ID, never by section code.** `PIPING` is not unique: this data also has a
`PIPING` section under `Production - EOU` with 10 job orders of its own. A check written as
`where s.code = 'PIPING'` reports that section and reads as a failed remap. The old section is id **16**,
the new one **46**:

```sql
select
  (select count(*) from job_orders                where section_id = 16) as old_jobs,
  (select count(*) from timesheet_entries         where section_id = 16) as old_entries,
  (select count(*) from employee_section_assignments where section_id = 16) as old_people,
  (select count(*) from timesheet_entries         where section_id = 46) as new_entries;
```

Expected after the run: `0 | 0 | 0 | 436` (plus whatever arrived on 46 from CLMS).

**In the product:**

1. Sign in as Rameshkumar Vaniya (HOD, Piping) — the **Approvals** queue should now be the new
   department's, and the old one should show nothing.
2. **Summary** for a date inside the moved history: the hours now appear under
   `Production Outfitting - Piping - SEZ`.
3. **Portfolio** as a Project Manager, **Job work**: the two Piping Job Orders carry the new department
   and section.
4. **Project master** → the section picker no longer offers `PIPING` / `STEEL` once deactivated.

## 9. What this plan does NOT touch

- `approvals` — who signed what.
- `timesheet_entries.project_id`, `project_wbs_id`, `job_order_id` — the work stays the same work.
- payroll figures, hours, employees' pay data.
- `ELECTRICAL`, `HEAVY_ENGINEERING`, `HULL_AND_OUTFITTING` — they stay in `Production - SEZ`.
- Any Job Order carrying no section: the two such rows in `Production - SEZ` are left alone and named in
  the dry run if they exist.
