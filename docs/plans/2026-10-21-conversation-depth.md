# Conversation depth: structured delays, SLA, recovery, hindrances

**Status:** design for approval. Nothing coded.
**Surface:** Conversations (drawer), Reports, Project structure. No new navigation section.
**Rule kept throughout:** the Nocturne/Harbor tokens only, no new palette, and nothing added to the
drawer's frozen layout that cannot collapse.

---

## 1. What exists today, and why it does not cover the ask

Read from the code, not from memory:

| Today | Where | Why it does not answer the ask |
| --- | --- | --- |
| Message kinds `FOLLOW_UP / INSTRUCTION / ESCALATION / REPLY / DECISION / SYSTEM` | `job_order_messages.kind` | A delay is only prose. Nothing can be counted, so "40% of delays were material" is impossible without reading every thread. |
| Escalation clock `8h → HOD`, `24h → COO+PM` | `services/escalationClock.ts` | Fixed constants; no expected-response time per message; the steps write a **SYSTEM line only and never e-mail** (`postMessage` returns early for SYSTEM). |
| Sweep exists but is **OFF** | `services/conversationScheduler.ts` (`CONVERSATION_SCHEDULER_ENABLED`) | You asked for it off. Auto-reminder needs it on, so the plan introduces a *separate* switch (§4). |
| Commitments extracted from text (`dueOn`, `state`, `chasedAt`) | `job_order_commitments` | A promise is a sentence with a date. There is no revised finish date, no manpower plan, and no PM decision on it. |
| Hindrance: none | — | No per-WBS constraint with raised date, owner and closure date. |
| Delivery lines per recipient | `job_order_message_recipients` | Already the mechanism ladder steps need; today they are only created for human messages. |

The four asks are therefore one theme: **the conversation is already the record, but it holds no
structured facts.** Every addition below turns an existing sentence into a row that can be counted,
while the sentence stays exactly where it is.

---

## 2. Frozen decisions

| # | Decision | Who |
| --- | --- | --- |
| 1 | SLA sweep ON with its own switch: reminders/escalation write a SYSTEM line **and** e-mail the owner/HOD (COO+PM at the top rung). The old `CONVERSATION_SCHEDULER_ENABLED` stays off; a new `CONVERSATION_SLA_SWEEP` governs the ladder. | user |
| 2 | The eight reason categories are fixed codes, seeded: `MANPOWER, MATERIAL, DRAWING, PERMIT, EQUIPMENT, WEATHER, CLIENT_HOLD, REWORK`. Labels can change later; codes never do, so history stays countable. | user |
| 3 | Delay analytics live in **Reports** ("Delay insights") **and** as a compact breakdown inside the thread drawer. | user |
| 4 | PM/ADMIN accept or reject a recovery; acceptance records the manpower plan and updates the finish date. | user |
| 5 | A hindrance is closed by the person who raised it or a PM/ADMIN; Central Planning is read-only with export. | user |
| 6 | **ACCEPTED:** acceptance writes `job_orders.committed_finish_date` (a column the application owns) and leaves `planned_end_date` as the CLMS plan. Both are shown, with a warning when they diverge. Writing into `planned_end_date` would be silently undone by the next Job Order CSV upload. | user, 21 Oct |
| 7 | **ACCEPTED:** "Central Planning" **is the PM role** — no new role. PMs read the register and the delay insights over their portfolio; ADMIN and COO see everything. | user, 21 Oct |
| 8 | **RIDER:** reminders and any system-generated e-mail are **OFF by configuration** and stay off until explicitly enabled. Nothing the system sends on its own may fire while the flag is false; a person posting a message is the only thing that mails in P1. | user, 21 Oct |
| 9 | Reason chips are also offered to a PM posting on the owner's behalf (same fact, same code). A recovery may carry an optional WBS; the Job Order is required. | mine, pending any objection |

---

## 3. Data model (additive only, one migration per phase)

### 3.1 Reasons (P1)

```prisma
model DelayReason {
  code      String  @id                 // MANPOWER | MATERIAL | DRAWING | ...
  label     String
  sortOrder Int     @map("sort_order")
  active    Boolean @default(true)
  messages  JobOrderMessage[]
  hindrances WbsHindrance[]
  @@map("delay_reasons")
}
```

`JobOrderMessage.reasonCode String? @map("reason_code")` — nullable, set once, never edited (messages
are append-only; a wrong reason is corrected by a superseding message, and the SYSTEM line says so).

### 3.2 SLA (P2)

```prisma
model SlaPolicy {
  id            Int     @id @default(autoincrement())
  kind          String                     // ESCALATION | RECOVERY
  departmentId  Int?    @map("department_id")   // null = the default for everybody
  responseHours Int     @map("response_hours")
  remindHours   Int     @map("remind_hours")
  escalateHours Int     @map("escalate_hours")
  active        Boolean @default(true)
  @@unique([kind, departmentId])
}
```

Seeded: `ESCALATION 4 / 8 / 24`, `RECOVERY 24 / 48 / 72`. Department rows override the null row.

Two columns on `job_order_messages`:

- `responseDueAt DateTime?` — set at post time from the policy for that kind.
- `answersMessageId Int?` — set on the REPLY that first answers it: **SLA met** is then a fact, not a
  recalculation, and "average first response" is one grouped query.
- `ladderStep String?` — `REMIND_HOD | ESCALATE_COO` on the SYSTEM line the sweep writes. Ladder lines
  now queue recipients (HOD; then COO+PM) through the existing delivery path, which is what makes them
  e-mail instead of only appearing in-app.

### 3.3 Recovery (P3)

```prisma
model JobOrderRecovery {
  id                Int      @id @default(autoincrement())
  threadId          Int      @map("thread_id")
  messageId         Int      @map("message_id")
  jobOrderId        Int      @map("job_order_id")
  projectWbsId      Int?     @map("project_wbs_id")
  proposedByUserId  Int?     @map("proposed_by_user_id")
  proposedByEmail   String   @map("proposed_by_email")
  revisedFinishDate DateTime @map("revised_finish_date")
  manpowerPlanJson  String?  @map("manpower_plan_json")
  note              String?
  state             String   @default("PROPOSED")   // PROPOSED | ACCEPTED | REJECTED | SUPERSEDED
  decidedByUserId   Int?     @map("decided_by_user_id")
  decidedAt         DateTime? @map("decided_at")
  decisionNote      String?  @map("decision_note")
  appliedFrom       DateTime? @map("applied_from")
  appliedTo         DateTime? @map("applied_to")
  createdAt         DateTime @default(now()) @map("created_at")
  @@index([jobOrderId, state])
}
```

`manpowerPlanJson` is `[{ trade, headcount, hoursPerDay, fromDate, toDate }]` — recorded, not enforced.
A new proposal supersedes the open one; the old row keeps `SUPERSEDED`, so the negotiation is readable.

`job_orders.committed_finish_date DateTime?` per decision 6, plus `committed_set_at`,
`committed_recovery_id`.

### 3.4 Hindrances (P4)

```prisma
model WbsHindrance {
  id               Int      @id @default(autoincrement())
  projectWbsId     Int      @map("project_wbs_id")
  jobOrderId       Int?     @map("job_order_id")
  threadId         Int?     @map("thread_id")
  messageId        Int?     @map("message_id")
  category         String                    // a delay_reasons code, or OTHER
  description      String
  raisedByUserId   Int?     @map("raised_by_user_id")
  raisedByEmail    String   @map("raised_by_email")
  raisedAt         DateTime @default(now()) @map("raised_at")
  ownerUserId      Int?     @map("owner_user_id")
  ownerEmail       String?  @map("owner_email")
  targetDate       DateTime? @map("target_date")
  impactDays       Int?     @map("impact_days")
  state            String   @default("OPEN")  // OPEN | CLOSED | VOID
  closedByUserId   Int?     @map("closed_by_user_id")
  closedAt         DateTime? @map("closed_at")
  closureNote      String?  @map("closure_note")
  @@index([projectWbsId, state])
  @@index([state, raisedAt])
}
```

Ageing = `now - raisedAt` for OPEN rows. `impactDays` is stated by the raiser and never derived — a
guess dressed as a number is worse than no number.

---

## 4. The scheduler question, answered without breaking last week's decision

```
CONVERSATION_SCHEDULER_ENABLED   (existing)  still OFF — the old ladder stays dormant
CONVERSATION_REMINDERS_ENABLED   (new)       THE master switch. false/unset = the application
                                             never sends anything on its own: no reminder at 8h,
                                             no escalation at 24h, no chase. Person-posted mail
                                             is unaffected.
CONVERSATION_SLA_INTERVAL_MIN    (new)       default 15, read only when the master switch is true
```

The master switch is checked at the one place that could send unattended mail, not at each call site,
and its state is logged at startup (`reminders: off`) and shown as a chip in the Conversations header so
an operator can see why the ladder is quiet. P1 ships with it off and no ladder at all.

Why two switches rather than reusing one: the old sweep also chased commitments and cleaned orphan
uploads. Turning that on to get SLA would re-enable things you did not ask for. The new sweep does one
job, and it can be switched off again without a deploy.

A manual `POST /conversations/sla/sweep` (PM/ADMIN) runs the same code once — so a holiday weekend does
not leave the ladder unrun, and a first-day check does not require waiting 15 minutes.

Mail discipline: ladder lines e-mail **only** the role being escalated to, once per rung
(`ladderStep` makes it idempotent), never the author, and respect the existing per-thread mute and the
daily cap. A reminder that mails the whole thread every 15 minutes is how a feature gets muted forever.

---

## 5. API surface

| Method & path | Who | What |
| --- | --- | --- |
| `GET /api/conversations/reasons` | any conversation role | the eight codes with labels |
| `POST /api/job-orders/:id/conversation/messages` | as today | gains `reasonCode`, `recovery {revisedFinishDate, manpowerPlan, note}` |
| `GET /api/job-orders/:id/conversation/insights` | thread scope | this JO: top reasons, count, avg first response, open hindrances |
| `POST /api/conversations/recoveries/:id/decide` | PM, ADMIN | `{ decision: ACCEPT | REJECT, note }`; writes the DECISION message and, on accept, `committed_finish_date` |
| `GET /api/job-orders/:id/hindrances` | thread scope | open + closed for the JO's WBS nodes |
| `POST /api/job-orders/:id/hindrances` | thread scope | `{ projectWbsId, category, description, ownerEmail, targetDate, impactDays }` |
| `POST /api/hindrances/:id/close` | raiser, PM, ADMIN | `{ closureNote }`; SYSTEM line into the linked thread |
| `GET /api/reports/delay-insights` | PM (portfolio), HOD/DEPT_HEAD (scope), ADMIN, COO | `from, to, departmentId, sectionId, projectId, reasonCode` → counts, shares, avg age |
| `GET /api/reports/hindrances` | same + export | register with ageing; `?format=xlsx` reuses the report exporter |
| `POST /api/conversations/sla/sweep` | PM, ADMIN | run once, returns `{reminded, escalated}` |

Every aggregation is server-side and deterministic. The assistant may *narrate* an insight later; it
never computes one.

---

## 6. Permission matrix

| Action | Owner | PM | HOD / DEPT_HEAD | ADMIN | COO | Supervisor |
| --- | --- | --- | --- | --- | --- | --- |
| Pick a delay reason on a reply | yes | yes | no | yes | no | no |
| Propose a recovery | yes | yes | no | yes | no | no |
| Accept / reject a recovery | no | yes | no | yes | no | no |
| Raise a hindrance | yes | yes | yes (scope) | yes | yes | no |
| Close a hindrance | own | yes | no | yes | no | no |
| Delay insights | own JO | portfolio | scope | all | all | no |
| Run the SLA sweep | no | yes | no | yes | no | no |

HOD read access is the existing conversation scope, unchanged: the reason is visible to whoever can
already read the thread, and hiding it from the HOD would be the only new information asymmetry.

---

## 7. What makes this traceable (the part that decides whether it is trusted)

1. **The sentence stays.** A reason is stamped on the message that carries the explanation; deleting the
   prose is not possible, so the number always has a citation (`#7 · Material not available`).
2. **Every structured act writes a SYSTEM line**: reason set, recovery proposed, accepted, rejected,
   superseded, hindrance raised, hindrance closed — with who and when. The thread reads as a single
   chronology; nothing happens to a count that does not appear in the trail.
3. **Codes are append-only.** A wrong reason is corrected by a superseding message; the old row keeps
   its code, so reports can be read as "what was said at the time".
4. **Ladder rungs are idempotent** (`ladderStep`), so a sweep run twice cannot double-mail or
   double-count an escalation.
5. **Acceptance is reversible.** `appliedFrom` holds the previous committed date; un-accepting (a
   REJECTED after ACCEPTED, PM only) restores it and writes another SYSTEM line.

---

## 8. UI

Everything below reuses the drawer's existing parts: the collapsible message row (`+ | kind | who |
first words | time`), the dialog pattern for anything longer than a strip, and tokens only.

### 8.1 Composer — reason chips appear only when they mean something

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Reply as Sunil Babariya (Project Manager)                    [Kind: Reply ▾] │
│ ──────────────────────────────────────────────────────────────────────────── │
│  Why is it delayed?   (owner only, optional, never blocks sending)           │
│  [ manpower ] [ material ✓] [ drawing ] [ permit ] [ equipment ]             │
│  [ weather ] [ client hold ] [ rework ]                                      │
│ ──────────────────────────────────────────────────────────────────────────── │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ Material for M-4152 spools not received; vendor promise was 18 Oct.    │  │
│  │                                                                        │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│  [+ Attach] [⏱ Response expected within 4h]        [Propose recovery] [Send] │
└──────────────────────────────────────────────────────────────────────────────┘
```

Chosen chips are single-select (one reason per message; a second cause gets a second message, which is
the truth of the situation anyway). The chip row is hidden for kinds and authors it does not apply to,
so nothing grows for a supervisor's follow-up.

### 8.2 Message row — the reason and the clock sit on the collapsed line

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ +  REPLY   Rameshkumar Vaniya · Section HOD      "Material not received…"    │
│    [material]  overdue 31h   [no reply yet]              #7 · 19 Oct 14:20   │
└──────────────────────────────────────────────────────────────────────────────┘
   ↓ expanded
   Material for M-4152 spools not received; vendor promise was 18 Oct.
   Context  Burn 0% · Schedule DELAYED 6d · Qty 64%
   Delivery Sent to sunil.babariya@swan.co.in · reminded HOD at 8h · escalated COO+PM at 24h
```

SLA states on the chip: `answered in 6h` (green), `due in 2h` (amber), `overdue 31h` (red),
`no address on file` (grey, when the owner has no routable e-mail — the delivery line already says it).

### 8.3 Recovery card — proposed, accepted, rejected, stale

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ RECOVERY PROPOSED · #9 · Rameshkumar Vaniya (Section HOD)    19 Oct 14:20    │
│                                                                              │
│  Revised finish   12 Dec 2026        was 30 Nov 2026   (+12 days)            │
│  Manpower         Fitters 6 × 8h, from 22 Oct to 5 Dec                       │
│                   Riggers 2 × 8h, from 28 Oct to 5 Dec                        │
│  Note             Material lands 24 Oct; two shifts until 5 Dec.              │
│                                                                              │
│  [ Reject ]                                            [ Accept revision ]   │
└──────────────────────────────────────────────────────────────────────────────┘
 after accept:
┌──────────────────────────────────────────────────────────────────────────────┐
│ RECOVERY ACCEPTED · Sunil Babariya (PM) · 19 Oct 16:02                       │
│  Committed finish 12 Dec 2026   ·   Planned (CLMS) 30 Nov 2026   ·  +12 days │
│  Manpower recorded: 6 fitters, 2 riggers                                     │
└──────────────────────────────────────────────────────────────────────────────┘
 stale (a later upload moved the CLMS plan, not the commitment):
│  ⚠ The planned date changed on 21 Oct. The commitment of 12 Dec still stands.│
```

Rejected states show the PM's note; a superseded proposal stays visible but collapses to one line.

### 8.4 Hindrances, in the thread and on the structure

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Hindrances on this Job Order's WBS                              [+ Raise]    │
│ ──────────────────────────────────────────────────────────────────────────── │
│  OPEN    material   Vendor spools 3 weeks late         owner: R. Vaniya      │
│          WBS 1.4.2 · raised 14 Oct · 7 days open · impact 12 d               │
│  OPEN    permit     Hot-work permit pending            owner: Safety         │
│          WBS 1.4.3 · raised 18 Oct · 3 days open · impact 2 d                │
│  CLOSED  drawing    Isometric revision B               closed 16 Oct · 4 d   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 8.5 Reports → Delay insights

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Delay insights        [Quarter ▾]  [Dept ▾] [Section ▾] [Project ▾]  [⤓]    │
│ ──────────────────────────────────────────────────────────────────────────── │
│  Material is the largest cause this quarter: 41% of 68 reported delays,      │
│  and the slowest to close (avg 9 days open).                                 │
│                                                                              │
│  material      ████████████████████████  28   41%   avg open 9.0 d           │
│  manpower      ████████████              15   22%   avg open 4.1 d           │
│  drawing       ███████                    9   13%   avg open 6.2 d           │
│  permit        █████                      6    9%   avg open 2.8 d           │
│  equipment     ████                       5    7%   avg open 3.5 d           │
│  weather       ██                         3    4%   avg open 1.2 d           │
│  client hold   █                          2    3%   avg open 11.0 d          │
│  rework        █                          1    1%   avg open 5.0 d           │
│ ──────────────────────────────────────────────────────────────────────────── │
│  By department   |  By project   |  By owner            (tabs, same numbers) │
│  Hindrances: 34 open · 12 stale (>14 days) · median close 5 d     [Register]│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 8.6 States that must exist (not an afterthought)

| State | Where | What it says |
| --- | --- | --- |
| No reasons yet | drawer mini-panel | "No delay reasons recorded. They appear when the owner replies and picks one." |
| No data in period | Reports | "Nothing reported in this quarter" + the previous quarter's count, so a zero is not mistaken for a bug. |
| No permission | Reports | The section is absent for SUPERVISOR rather than showing zeros. |
| Owner has no address | message chip | `no address on file` — links to the Employees tab where the address is set. |
| Proposal stale | recovery card | the warning in 8.3, never silently overwritten. |
| Sweep off | Conversations header | a small `SLA reminders off` chip with a tooltip, so a quiet ladder is visible as a choice. |

### 8.7 Mock

`docs/plans/mocks/conversation-depth.html` — the same panels in Nocturne tokens, numbered 1–7 to match
this section.

---

## 9. Innovations worth considering (effort → benefit)

| # | Idea | Effort | Benefit |
| --- | --- | --- | --- |
| 1 | **Reason chips on the collapsed row** (not only inside the text) | S | Delays become scannable without opening a thread; the analytics get fed for free. |
| 2 | **"Answers" link instead of recomputing SLA** (`answersMessageId`) | S | First-response time becomes exact and one query; no night-long job to recompute. |
| 3 | **Ladder rungs that e-mail** through the existing delivery path | S | The 8h/24h promise finally leaves the app, and idempotency comes from one column. |
| 4 | **Committed vs Planned shown side by side** | S | Survives a CLMS re-upload; the audit question "what did we promise?" has one answer. |
| 5 | **Stale-commitment warning** when the plan changes after acceptance | S | Turns a silent overwrite into a visible disagreement. |
| 6 | **Hindrance ageing buckets + stale flag (>14 days)** | S | Central Planning's actual question is "what has been open too long", not "what exists". |
| 7 | **One-line deterministic narrative** above the report ("Material is the largest cause… 41% of 68") | S | Readable in five seconds; no model in the path. |
| 8 | **Reason → WBS rollup** (which WBS node eats the delays) | M | Points at the drawing/vendor that is actually costing the project. |
| 9 | **Recovery compliance** (was the committed date met?) | M | The only way to know if the negotiation is honest. |
| 10 | **Assistant narrates the insights** (off by default) | M | Nice-to-have; explicitly not in the critical path. |

Cheapest high-value set: 1, 2, 3, 4, 6, 7.

---

## 10. Phases — each one shippable on its own

**P1 — Reasons become data.** At the end: an owner replying can pick one of eight causes; the drawer
shows this Job Order's top three causes; Reports → Delay insights shows the quarterly spread by cause.
No scheduler, no new mail, no schema risk to existing rows.

**P2 — The clock becomes visible and does something.** At the end: every escalation shows "due in 4h /
overdue 31h"; the SLA sweep (its own switch) reminds the HOD at 8h and escalates to COO+PM at 24h, in
the thread and by e-mail; ageing buckets are on the Reports section; a PM can run the sweep by hand.

**P3 — Recovery becomes a decision.** At the end: an owner proposes a revised finish date and manpower
plan, the PM accepts or rejects with a note, and the Job Order shows Committed next to Planned, with a
warning when the plan later moves.

**P4 — Hindrances get a register.** At the end: a constraint can be raised against a WBS node (from the
thread or the structure), with owner and target date; the raiser or a PM closes it with a note; Central
Planning filters the register by department/section/project and exports it; reasons and hindrances
report together.

---

## 11. Risks and how the design absorbs them

| Risk | Response |
| --- | --- |
| Ladder mail becomes noise and gets muted | one mail per rung, never the author, mute + cap respected, sweep switch, `SLA reminders off` chip so silence is visible. |
| Wrong SLA defaults annoy owners | policies are rows, not constants; defaults 4/8/24 for escalation, 24/48/72 for recovery; department override without a deploy. |
| Reason picked casually, analytics become junk | reasons are optional and single-select, the sentence stays, and the report shows `n` so a thin sample is visible. |
| CLMS upload overwrites a committed date | decision 6: commitment lives in its own column; stale warning when the plan moves. |
| Duplicate hindrances for the same cause | the raise form shows open hindrances on that WBS first, and an explicit "this is the same one" links to it instead of creating a second. |
| Report slow on years of history | counts come from indexed columns on messages/hindrances, not from scanning timesheet entries; period filter is mandatory with a quarter default. |
| "Central Planning" assumed to be a role | decision 7: it is a scope, not a role; a new role is a separate change. |

---

## 12. Acceptance criteria

- A reply with `material` is stored with `reason_code = MATERIAL`, and the sentence is unchanged and
  uneditable except by a revision that keeps `bodyRevision`.
- `GET /reports/delay-insights?from&to` returns shares that sum to 100% (±rounding) and an `n`; the
  numbers equal a direct SQL count for the same filter (asserted in a test against fixtures).
- An escalation with no reply at 8h produces exactly one `REMIND_HOD` SYSTEM line and one e-mail to the
  HOD; running the sweep again produces none.
- A reply at 6h sets `answers_message_id` and the chip reads `answered in 6h`.
- Accepting a recovery writes `committed_finish_date`, keeps `planned_end_date`, writes a DECISION
  message, and the card shows both dates; rejecting after accepting restores the previous value.
- Closing a hindrance is refused for anyone who is neither the raiser nor PM/ADMIN (403, tested).
- Every one of the seven states in §8.6 renders (probe, screenshot).
- Migration is additive; `prisma migrate deploy` on a production copy with existing threads changes no
  row in `job_order_messages` beyond the three new nullable columns.

---

## 13. To freeze this I need

1. **Decision 6** — commitment in its own column (`committed_finish_date`), leaving `planned_end_date`
   to CLMS. Yes / no.
2. **Decision 7** — Central Planning uses existing department/section scope; no new role. Yes / no.
3. Whether the **owner's reason chip** should also be offered to the PM posting on the owner's behalf
   (my recommendation: yes, it is the same fact).
4. Whether **recovery proposals need a WBS** or are Job-Order level only (my recommendation: optional
   WBS, Job Order required).

Everything else is in this document and does not need another round.


---

## 14. Delivered

### P1 — reasons became data (`3b7c760`)

`delay_reasons` (eight codes, seeded), `job_order_messages.reason_code`, chips in the composer for the
owner/PM/ADMIN, a cause chip on the collapsed row, a per-Job-Order strip in the drawer, and
Reports → Delay insights with a calendar period, a deterministic sentence and relative bars.
`CONVERSATION_REMINDERS_ENABLED` exists from this point, default OFF, and the drawer shows it.

### P2 — the clock became visible and does something (`this commit`)

`sla_policies` (ESCALATION 4/8/24, RECOVERY 24/48/72, department override), `response_due_at` and
`answers_message_id` on the message, `ladder_step` on the rung. A reply records WHICH message it answers,
so "responded in 6h" is one column and the median is one query. The sweep walks the ladder, writes the
rung as a SYSTEM line, and mails the role it escalates to through the existing delivery path; the manual
`POST /conversations/sla/sweep` refuses with 409 while reminders are off. Reports gained the Response
time half: median, share inside target (each message against ITS OWN target), four ageing buckets and
the 24h count.

**Two bugs the rehearsal caught, both worth remembering:**

1. `where: { ladderStep: { not: "ESCALATE_COO" } }` is SQL `<> 'ESCALATE_COO'`, which is NULL — and so not
   true — for every message whose rung had never been taken. The first rung was unreachable and the sweep
   reported `reminded: 0` on a nine-hour-old escalation. Written out as
   `OR: [{ ladderStep: null }, { ladderStep: { not: "ESCALATE_COO" } }]`.
2. The rung was recorded on the SYSTEM line only, so the source message still looked untouched and the
   next sweep took the same rung again — two "reminded" lines one second apart. The guard now lives on the
   source message; the line keeps its own copy for display.

Measured end to end on the restored copy: a 9-hour-old escalation → `reminded: 1` then `0` on a second
run, one REMIND_HOD line, recipients `NO_ADDRESS` where the HOD still has an `@employee.local` login; at
26 hours → `escalated: 1` then `0`, one ESCALATE_COO line, the PM's real address QUEUED. With reminders
off the endpoint answers 409 and the Reports button is disabled and reads `reminders OFF`.
