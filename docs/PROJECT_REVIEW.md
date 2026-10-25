# Project Review

The Review menu answers a different question from the Reports menu. Reports measure what happened; the review
freezes what happened at a point in time, points at the few Job Orders that need a decision, and keeps the
decisions so the next review starts from them.

It lives at **Review** in the rail (`/review`), not as a tab inside Reports.

---

## 1. Who sees what

Scope is resolved server-side, once per request, by `reportScopeFor` in `services/reportScope`. The screen never
receives a list it then filters — a row the actor may not see is never sent.

| Role | Sees |
|---|---|
| `PM`, `ADMIN`, `COO` | Every project in the organisation |
| `HOD`, `DEPT_HEAD` | Their own department's Job Orders **inside** each project. A project with none of their Job Orders answers 404, not 403 |
| `PROJECT_MANAGER` | Exactly the projects assigned to the account, and nothing else (fail closed) |
| `SUPERVISOR`, `EMPLOYEE` | Refused at the door (`viewProjectReview` capability absent) |

Two capabilities, both in `services/roleAccess`:

| Capability | Holds it |
|---|---|
| `viewProjectReview` | PM, ADMIN, COO, HOD, DEPT_HEAD, PROJECT_MANAGER |
| `runProjectReview` (freeze a snapshot) | PM, COO, ADMIN only |

An out-of-scope project id answers **404 `PROJECT_NOT_IN_SCOPE`**, not 403: an id the actor cannot see does not
exist for them. A freeze attempt by a viewer answers **403 `REVIEW_RUN_REQUIRED`**.

---

## 2. The screen

`/review` lists the projects in scope with their headline numbers, so a reviewer can pick the worst one.
`/review/:projectId` is the review itself, and `/review/:projectId/snapshot/:snapshotId` is the same screen
rendering a **frozen** payload with an amber banner.

Panels, in the order they appear:

1. **Pulse** — Job Orders, budget hours, booked hours, burn, delayed, at risk, no plan, open escalations, peak
   manpower, open/overdue actions. Every figure is over the review window, not all time.
2. **S-curve** — planned against actual, at project, WBS or Job Order level (see §3).
3. **Slowest Job Orders** — the top 10 by a named, printable score (see §4), each with its reasons in words.
4. **Manpower** — a weekly histogram with two series (see §6).
5. **Escalations by age** — open escalations bucketed by how long they have been open (see §5).
6. **Attendance grounding** — present man-days against booked man-days for the crews on this project (see §7).
7. **Readiness** — sentence-per-lever about why a number is missing, naming where to fix it.

The default window is the **last one month** (30 days ending today). "Last 12 weeks" is one click away. A rolling
window is labelled as a range (`25 Sept 2026 – 24 Oct 2026`); only an exact calendar month gets a month's name.

---

## 3. The S-curve, precisely

`CURVE_BASIS = "WBS_WEIGHTED_LINEAR_SPREAD"`, printed on the chart so a reader is never guessing what the line
means.

**Planned.** The planned line is **derived**, never imported as a baseline:

1. Each WBS node holds a weight (`project_wbs.planned_weight`). A node without a weight takes the average of the
   configured weights; a project with no weights at all gives every node an equal share. Shares are normalised
   by the weights actually present, so they always sum to 100%.
2. Each node's share of the project budget is split across its Job Orders **in proportion to their budgeted
   hours**. A node whose Job Orders carry no budget still holds its share — it is split **equally** across its
   scheduled Job Orders. (Dropping it silently deleted 5 of 9 nodes, ~4,900 hours, on a real project.)
3. Each Job Order's share is spread **linearly** across its own planned window.
4. A Job Order needs **both** a planned start and a planned end. A start with no end is not a plan, and it
   accrues nothing; it is counted in `coverage.jobOrdersUnscheduled`.

**Actual.** Booked hours per bucket, from timesheet entries in the booked statuses (the same definition the
dashboard uses). OT rows contribute their explicit `otHours`, a shift slot two hours, an hour slot one.

**Coverage.** The chart always states how much of the budget the plan can speak for: WBS nodes plotted against
WBS nodes present, Job Orders plotted against present, and `plannedInCurveHours` against the budget. An
unscheduled WBS is counted, never plotted as zero.

**Three levels.** A segmented control above the chart, not tabs: Project, WBS, Job Order. The level is a lens on
the same numbers and must not navigate away from the period, the pulse or the readiness. The WBS view carries a
per-node table (share, budget, planned to date, actual, variance, Job Orders planned/total), sorted
worst-variance-first. The Job Order view picks one Job Order and plots its own curve.

**Weights are edited on Master Data → WBS → Planned weights**, which asks for **percentages** and shows the share
each weight will produce, computed by the same function the curve uses (`normaliseWeightShares`, in
`packages/shared`, so the preview cannot drift from the server). The percentages do not have to add up to 100 —
they are relative, and the dialog prints the total and what an unweighted node will take. Two helpers do the
arithmetic a planner should not have to: **Split by budgeted hours** (each node's share of the budgeted hours)
and **Equal split**. A blank box — or a typed `0` — means "no opinion": that node takes the **average** of the
percentages that were entered. It never means "no share", because a node silently dropped from the plan while
still listed on screen is exactly the kind of quiet a review exists to prevent.

---

## 4. The slow ranking

A named score, not a vibe. Weights are `SLOW_WEIGHTS` in `services/reviewRanking`, printed on screen:

| Component | Weight per unit |
|---|---:|
| Days past the planned end, or projected to land past it — whichever is worse | 1.0 |
| Percentage points by which the calendar has run ahead of the work | 0.5 |
| Days since the last booking on a Job Order that should be running | 0.5 |
| Open, unanswered escalation on this Job Order | 2.0 |
| Days the oldest unapproved hours have been waiting | 1.0 |
| Percentage points of quantity still to do (only when a quantity budget exists) | 0.3 |

A Job Order with neither a plan nor a booking is **NOT MEASURABLE** — counted separately and never ranked as
though it were fine. Ratios that cannot be computed contribute 0, not NaN; a NaN would silently sort to the top.

---

## 5. Escalations by age

An escalation is **open** when its thread is `OPEN` and no later message that is not itself an escalation
follows it. Acknowledgement is not an answer: a message that only acknowledges leaves the escalation open. Age
is measured from the escalation message's `createdAt`. Buckets: 0–2, 3–7, 8–14, 15–30, over 30 days, with
inclusive lower bounds (exactly 3 days is "3–7").

---

## 6. Manpower

Two series that are **never summed**: CONTRACT hours (timesheet) and PAYROLL hours (`employee_allocations`).
They count the same day from two directions, and adding them would double the yard. Each bucket states its own
distinct head count; an empty bucket says `hasData: false` rather than drawing a zero.

---

## 7. Attendance grounding

When the attendance settlement has run for the window, the review states present man-days against booked
man-days for the crews who appear on this project, and the days paid for that no project was charged. When the
settlement has not run it is **null with a reason**, never zero — zero would read as a finding.

---

## 8. Snapshots — frozen means frozen

A snapshot serialises the review payload **once**, hashes it, and stores it. Reading a snapshot makes exactly
**one** database call, on `report_snapshot`; it never re-reads a live table. That is what makes October's pack
still say October after a Job Order is deleted in November.

| Field | Meaning |
|---|---|
| `kind` | `WEEKLY` or `MONTHLY`; a monthly pack is its own capture, never a re-aggregation of weeks |
| `revision` | 1, 2, 3… One period can hold several revisions of the same kind |
| `provisional` | `true` when the period had not ended at capture. A provisional snapshot is **replaced**; a final one is only ever **appended** |
| `captureTrigger` | `SCHEDULED`, `ON_DEMAND`, `PACK` |
| `contentHash` | SHA-256 over canonical JSON: keys sorted recursively, `Date` serialised as ISO, floats normalised to twelve significant digits (jsonb stores JSON numbers as `numeric` and would not round-trip the last bit) |
| `payloadBytes` | Size, so a runaway payload is visible without parsing it |

Re-capturing a period whose **numbers have not changed** returns the existing revision and writes nothing.
`dataFingerprint` ignores `generatedAt`, `frozen` and the snapshot back-reference — the payload describes how it
is stored, the fingerprint describes what it says.

A tampered payload is refused with **`SNAPSHOT_CORRUPT`** rather than rendered. A snapshot the actor cannot see
answers 404 `SNAPSHOT_NOT_FOUND`.

Scheduled captures: `REVIEW_SNAPSHOT_WEEKLY_CRON` (default `30 0 * * 1`, the week that just ended) and
`REVIEW_SNAPSHOT_MONTHLY_CRON` (default `30 1 1 * *`, the calendar month that just ended), both gated by
`REVIEW_SNAPSHOT_ENABLED` (default **false**). One failing project never costs the others their capture.

---

## 9. Actions

`review_session` and `review_item` exist; the register, the WBS-by-WBS walk and publishing a decision into the
Job Order conversation are **not built yet**. The `actionsOpen` / `actionsOverdue` figures on every screen are
structurally zero until they are. Overdue is always derived from the due date, never stored.

---

## 10. API

| Method | Path | Capability |
|---|---|---|
| GET | `/api/review/projects` | `viewProjectReview` (scoped) |
| GET | `/api/review/projects/:id/dashboard?kind=&from=&to=` | `viewProjectReview` (scoped) |
| GET | `/api/review/projects/:id/curve?jobOrderId=` | `viewProjectReview` (scoped) |
| GET | `/api/review/projects/:id/trend` | `viewProjectReview` (scoped) |
| POST | `/api/review/projects/:id/snapshots` | `runProjectReview` |
| GET | `/api/review/projects/:id/snapshots` | `viewProjectReview` (scoped) |
| GET | `/api/review/snapshots/:id` | `viewProjectReview` (scoped) |
| GET | `/api/master-data/projects/:id/wbs-weights` | any authenticated reader |
| PUT | `/api/master-data/projects/:id/wbs-weights` | `ADMIN`, `PM` (audited) |

`PUT …/wbs-weights` takes `{ weights: [{ wbsId, plannedWeight }] }`, refuses a WBS row that belongs to another
project, refuses a duplicate row, and refuses every-weight-zero with `ALL_WEIGHTS_ZERO` (a plan that plots
nothing while every screen says "planned" is worse than a refusal).

---

## 11. Environment

| Variable | Default | Meaning |
|---|---|---|
| `REVIEW_SNAPSHOT_ENABLED` | `false` | Starts the weekly and monthly capture scheduler |
| `REVIEW_SNAPSHOT_WEEKLY_CRON` | `30 0 * * 1` | Monday 00:30, the week that just ended |
| `REVIEW_SNAPSHOT_MONTHLY_CRON` | `30 1 1 * *` | 1st at 01:30, the calendar month that just ended |
| `TZ` | `UTC` | Timezone the cron expressions are read in |

The API image copies `apps/api/scripts`, so the operator wrappers run inside the container:

```
node apps/api/scripts/review-snapshot-once.mjs --kind MONTHLY
node apps/api/scripts/review-snapshot-once.mjs --kind WEEKLY --from 2026-10-12 --to 2026-10-18
```

---

## 12. Deploying (production, PowerShell on the Docker host)

Preconditions: `git pull` lands the branch, and the two migrations (`20261023000000_work_calendar_and_attendance_settlement`,
`20261024000000_project_review`) run through the `migrate` service. Never `docker compose down`.

```powershell
cd C:\Project\workforce
git pull --ff-only origin main

# Review is switched on deliberately; snapshots stay off until one manual run succeeds.
Add-Content .\infra\docker\.env.production "REVIEW_SNAPSHOT_ENABLED=false"

docker compose -f infra\docker\compose.production.yml --env-file infra\docker\.env.production build migrate api web
docker compose -f infra\docker\compose.production.yml --env-file infra\docker\.env.production up -d --force-recreate migrate
docker compose -f infra\docker\compose.production.yml --env-file infra\docker\.env.production up -d --force-recreate api web

# one manual freeze, then read it back
docker compose -f infra\docker\compose.production.yml --env-file infra\docker\.env.production exec api node apps/api/scripts/review-snapshot-once.mjs --kind MONTHLY

# only after that succeeds
(Get-Content .\infra\docker\.env.production) -replace 'REVIEW_SNAPSHOT_ENABLED=false','REVIEW_SNAPSHOT_ENABLED=true' | Set-Content .\infra\docker\.env.production
docker compose -f infra\docker\compose.production.yml --env-file infra\docker\.env.production up -d --force-recreate api
```

Rollback: set `REVIEW_SNAPSHOT_ENABLED=false` and recreate `api`. A snapshot already captured stays readable —
that is the point of a frozen payload — and no report reads it unless asked.

---

## 13. What makes a number blank (and why that is honest)

| Symptom | Cause | Lever |
|---|---|---|
| Planned line flat at 0 | No Job Order has both planned dates | Master Data → Job orders → schedule |
| `NOT MEASURABLE` rows | Neither plan nor booking | Same, plus the budget below |
| Burn blank on a Job Order | No budgeted hours | Master Data → Job orders → budget |
| Attendance panel absent | Settlement has not run for the window | `ATTENDANCE_SETTLEMENT_ENABLED` and the 06:00 cron |
| Actions 0 | The action register is not built (§9) | — |
| Idle cost 0 | No cost rates configured | Cost rate master |

Every one of these is stated on the Readiness panel in words, naming the lever. A missing number that is
explained is information; a missing number that is silent is a rumour.

---

## 14. Tests that pin the contract

`apps/api/src/services`:

| File | Pins |
|---|---|
| `reviewCurve.test.ts` | weights (equal, configured, mixed), spread requires both ends, a zero-budget node keeps its share, an unscheduled node is counted |
| `reviewRanking.test.ts` | the score's weights, NOT MEASURABLE separated, no NaN from a ratio that cannot be computed |
| `reviewEscalations.test.ts` | open means unanswered, inclusive bucket bounds |
| `reviewManpower.test.ts` | two series, never summed |
| `reviewActions.test.ts` | overdue derived, carry-forward as a copy chain |
| `reviewPayload.test.ts` | one assembly, definitions printed from the same constants |
| `reviewSnapshot.test.ts` | canonical JSON, Date as ISO, float round-trip, idempotent re-capture |
| `reviewSnapshotPeriod.test.ts` | Monday-to-Sunday weeks, month boundaries, both February shapes |
| `masterDataRules.test.ts` | weight parsing: blank / 0 / positive, refusals |
| `roleAccess.test.ts` | both capabilities per role, including the COO's single write-shaped one |

Web: `reviewChart.test.ts` pins the SVG arithmetic (scale, ticks, paths, bars, domains).

---

## 15. Demo data (dev only)

`apps/api/scripts/demo-review-seed.mjs` and `demo-review-clear.mjs` fill the two projects with the most Job
Orders with planned windows, weekly progress, booked shifts, allocations and aged escalations, every row marked
for removal. They refuse to run with `NODE_ENV=production` or against a non-local `DATABASE_URL`.
See the `workforce-timesheet-app` skill, `references/review-demo-data.md`.
