# Finishing the PIPING move: job orders left on the old pair

**Symptom.** After `remap-section.mjs` reported success, a screen still shows Job Orders under
`Production - SEZ / PIPING`, or the new `Production Outfitting - Piping - SEZ / OUTFITTING_PIPING`
looks short.

**Why it happens.** `remap-section.mjs` moves every Job Order that stands on the old section at the
moment it runs, and then it refuses to run again — its precondition is *the destination must be empty*,
which is what stops two live sections being merged by accident. So anything that lands on the old pair
**after** that run cannot be fixed by re-running it. Two ordinary things do that:

1. **A Job Order CSV upload.** The upload resolves Department and Section from the columns of the file
   and *creates* what it does not find (`routes/jobOrderCsv.ts`). If the CSV still names the old pair,
   the orders are re-created under the old department — they look migrated in the file and missing in
   the app.
2. **A Job Order created by hand on the old pair**, because the old section was deliberately left
   active (the agreed scope: PIPING only, old section stays).

Either way the data is consistent; the row simply still points at the old pair.

## 1. Look before touching anything (read-only)

The production stack has no `postgres` service (the database is external) and the API image carries no
`psql`, so the report is a script that speaks to the same database the application does:

```powershell
dc exec api node apps/api/scripts/remap-report.mjs `
  --from-dept "Production - SEZ" --from-section PIPING `
  --to-dept "Production Outfitting - Piping - SEZ" --to-section OUTFITTING_PIPING
```

It writes nothing. On the restored copy it prints:

```
  JOB ORDERS — old pair, new pair, and rows with no section at all

     OLD PAIR        #135   M4152   Spools Fabrication   Production - SEZ   PIPING   156 entries  2026-09-26
     OLD PAIR        #229   M4152   Spool Fabrication    Production - SEZ   PIPING   280 entries  2026-09-26
     no section      #277   Np13    Idle                 Production - SEZ   (none)   536 entries  2026-09-28
     no section      #303   Np39    Maintenance          Production - SEZ   (none)   494 entries  2026-09-28

  TOTALS
  job orders on the old section                  2
  job orders on the new section                  0
  timesheet entries on the old section           436
  people assigned to the old section             8
```

Read it as three questions:

- anything with `sec_id = 16` → **that** is what did not move (the script below fixes it);
- `sec_id = 46` with `dept_id = 3` → a half-moved row; also fixed below;
- `sec_id` null but `dept_id = 3` → a Job Order with no section at all (e.g. "Idle", "Maintenance").
  It is **not** part of a section move; leave it, or give it a section deliberately.

The same report ends with the duplicate check, limited to the codes of these two sections:

```
  A CODE OF THIS SECTION THAT ALSO EXISTS ELSEWHERE (a later upload may have left a twin)

     M4152      x5  #135 Production - SEZ/PIPING  |  #164 Production - EOU/STEEL  |  #201 … |  #229 … |  #336 …
```

A code standing on the old pair **and** on the new section is the CSV signature: the upload could not
match the moved row (its uniqueness is scoped by project and organisation) and made a second one.

## 2. Move what is left

`apps/api/scripts/remap-leftovers.mjs` — Job Orders and their Timesheet Entries only. It does not touch
people, scopes or approvals; if those still need moving, that is `remap-section.mjs`, not this.

Dry run (default):

```powershell
dc exec api node apps/api/scripts/remap-leftovers.mjs `
  --from-dept "Production - SEZ" --from-section PIPING `
  --to-dept "Production Outfitting - Piping - SEZ" --to-section OUTFITTING_PIPING
```

It prints every order it would move with its entry count and creation date, then the before-counts of
both sections. Nothing is written.

Apply:

```powershell
dc exec api node apps/api/scripts/remap-leftovers.mjs `
  --from-dept "Production - SEZ" --from-section PIPING `
  --to-dept "Production Outfitting - Piping - SEZ" --to-section OUTFITTING_PIPING --apply
```

It prints `VERIFIED` only when the old section is empty **and** every moved row now names the new
department. The undo is an `audit_log` row (`SECTION_REMAP_LEFTOVERS`), written in the same transaction
as the move, so a rollback can always be found:

```powershell
dc exec api node apps/api/scripts/remap-leftovers.mjs --rollback <id>
```

## 3. Stop it happening again

If the cause was a CSV upload, moving the rows is only half the fix: the next upload of the same file
re-creates them. Correct the Department/Section columns in the source file (or re-export from CLMS
after the mapping changed) before the next upload. The upload is intentionally strict — it will not
guess that `PIPING` under a new department is the same section, because a section code is not unique:
`PIPING` exists under more than one department and a code match would pick the wrong one.

## Verify by id, never by code

`PIPING` is not a unique section code. A check written as `where s.code = 'PIPING'` reads another
department's work and makes a correct move look like a failed one.

| what | id |
| --- | --- |
| `Production - SEZ` | 3 |
| `Production - SEZ / PIPING` | 16 |
| `Production Outfitting - Piping - SEZ` | 27 |
| `Production Outfitting - Piping - SEZ / OUTFITTING_PIPING` | 46 |

(Ids are from the production restore of 2026-10-21. Confirm with `select id, code, department_id from
sections where code in ('PIPING','OUTFITTING_PIPING');` — then use the ids, not the codes.)

## Rehearsal on the restore (2026-10-21)

| step | result |
| --- | --- |
| remap-section dry run | 2 job orders, 436 entries, 8 people, 1 account scope |
| remap-section apply | job orders 16 → 0, section 46 → 2; entries 436 |
| emulated residue: one order back on the old pair with 280 entries | `on16=1, on46=1` |
| remap-leftovers dry run | 1 job order (#229, M4152 "Spool Fabrication", 280 entries, created 2026-09-26) |
| remap-leftovers apply | moved 1 + 280; `AFTER old section 0`, `destination 2`; verified by id |
| remap-leftovers rollback | order back on `dept 3 / sec 16` with its 280 entries; nothing else touched |
| remap-section rollback | restore returned to 2 / 436 / 8 people |
