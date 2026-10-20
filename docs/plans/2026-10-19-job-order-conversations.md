# Job Order Conversations — Project Manager ↔ Job Order Owner

**Status:** design for approval. No application code has been written.
**Ask:** freeze the UI in §7, then implement in the phases of §13.

---

## 1. What this is

A conversation attached to a **Job Order** — not to a person, not to a project. Every Job Order gets one
thread that collects follow-ups, instructions, escalations, replies and decisions, from the Project
Manager and from whoever holds the job (Section Head, HOD, Project Planning, COO), with every message
emailed to the people who need it and a one-click way to answer from that email.

It is a **record**, not a chat room: messages are append-only, every message carries a snapshot of the
Job Order's operational state at that moment, and the thread is part of the Job Order's dossier.

## 2. Who takes part

Confirmed with you: **COO, ADMIN, Project Planning (the `PM` role), Section Head (`HOD` with a section
scope), HOD (department-wide), the `DEPT_HEAD`, and the Project Manager assigned to the project.** The
Job Order's named **owner** is who a message is *addressed to* and who is emailed — it is not a gate on
who may speak.

| Role | Reads threads | Posts | Starts a thread | Scope of what they can see |
|---|---|---|---|---|
| `PROJECT_MANAGER` | yes | yes | yes | Job Orders of the **projects assigned to them** |
| `PM` (Project Planning) | yes | yes | yes | every Job Order (the planning team's existing reach) |
| `HOD` (section or department shape) | yes | yes | yes | Job Orders whose **department + section set** is theirs (`hodScopeMatchesSet`) |
| `DEPT_HEAD` | yes | yes | yes | own department |
| `COO` | yes | **yes** | yes | every Job Order |
| `ADMIN` | yes | yes | yes | every Job Order |
| `SUPERVISOR`, `EMPLOYEE`, `HR`, `FINANCE` | no | no | no | refused at the router |

Two rules that keep this consistent with the rest of the app:

- **COO posting is deliberate and does not break its read-only promise.** A message changes no
  operational record — no approval, no budget, no master data. A *Decision* message that proposes a
  change is still only a proposal (see §4.3) and is accepted by a role that already holds that right.
- **Scope is computed server-side from the existing helpers** (`reportScopeFor`, `hodScopeMatchesSet`,
  `project_manager_assignments`). Never from the request: a thread id in a URL must not widen anything.

**The owner.** Today a Job Order has a department and a section but no named person. This design adds
`JobOrder.ownerUserId` (nullable) with an explicit rule:

1. the explicitly assigned owner, else
2. the `HOD` users whose scope covers the Job Order's department + section, else
3. the department-wide `HOD` of that department, else
4. nobody — and the UI says so ("No owner — assign one on Project Master") instead of pretending.

Ownership is set on **Project Master → Job Orders** (one picker per row, audited, with history of who
changed it), and a "no owner" Job Order is a visible exception on the dashboard.

## 3. The object: one thread per Job Order

- `JobOrderThread` — one per Job Order, created the first time someone writes. Fields: status
  `OPEN | RESOLVED`, opened by, opened at, resolved by/at, last message at, message count, last author.
- **Resolving is not deleting.** A resolved thread stays readable and reopens with the next message.
- **No hard delete anywhere.** Editing a message produces a *revision* and a system line
  ("edited by X at 14:32"); the original stays.
- Every message carries a per-thread **sequence number** (`#1`, `#2`, …) so a conversation can be
  quoted unambiguously — "per #7" beats "the one about the grating".

## 4. What can be said

### 4.1 Message kinds (frozen vocabulary)

| Kind | Who picks it | Purpose | Email |
|---|---|---|---|
| **Follow-up** | anyone | "where is this?", status chase | recipient immediately |
| **Instruction** | PM, Planning, HOD, Admin | a direction to the holder | recipient immediately |
| **Escalation** | anyone | this needs a decision now — starts the clock (§5.4) | recipient + their HOD + COO after the first clock |
| **Reply** | anyone (including no-login) | an answer in the conversation | the other participants, batched (§5.3) |
| **Decision** | PM, Planning, Admin | a recorded outcome; may carry a proposed change (§4.3) | all participants |
| **System** | the application | "assigned to X", "resolved", "reopened", "escalated to HOD" | none by default |

### 4.2 The context stamp (the first innovation)

Every message freezes the Job Order's operational state **at the moment it was written**:

```
#7  Instruction · A. Manager (Project Manager) · 18-10-2026 14:32
    Burn 82% (AMBER) · Schedule DELAYED by 6d · Qty 64% · Budget rev 3 in force
```

Shown as a one-line strip under the header, collapsed by default, expandable to the full snapshot
(budget/actual hours, plan start/end, progress, band, unapproved hours). Why it matters: the
conversation becomes self-documenting. Nobody can later claim "at that time it was on plan", and a
decision is read in the context that produced it. It costs nothing — the report already computes these
facts; we store the numbers, not a live reference.

### 4.3 Decision messages that carry a change (the second innovation)

A `DECISION` message may carry **one proposed change**, chosen from the operations the app already has:

- revise the budget hours/quantity (`JobOrderBudgetRevision`),
- set or move the planned window (`plannedStartDate/EndDate`),
- change the Job Order's status (active/inactive).

The message is a proposal until a role that already holds that right accepts it (PM/Admin for master
data). Accepting **writes the existing change** with `linkedMessageId`, and posts a System line. The
thread then *is* the audit trail for the change, instead of a parallel e-mail trail that nobody can
reconcile. Rejecting keeps the refusal reason in the thread.

## 5. The email side

### 5.1 Addresses — a real gap this feature forces us to close

`Employee` stores no e-mail; `User.email` is a **login handle**, and for someone imported without an
address it is `<ecno>@employee.local` — not routable. So:

- Add `User.notificationEmail` (nullable) — "where Workforce writes to this person".
- Populate it from the CSV `email` column when it is a real address, from Employee Registration, and
  from Role Assignment (an Admin can set it on the account row).
- **Never** silently fall back to `itsupport.shipyard@swan.co.in`; a participant without an address is
  shown with a "no address — set one" chip on the thread, and the compose dialog warns before sending
  that the owner cannot be emailed (message still posts in-app).
- A one-screen admin view: *participants without an address*, so this is fixed once, not per thread.

### 5.2 The message

- From: `Workforce <workforce@…>` (`NOTIFY_FROM`), Reply-To: the author's `notificationEmail` when it
  exists (so a plain "Reply" reaches a human), plus `Message-ID` / `In-Reply-To` / `References` so mail
  clients thread correctly, and `X-Workforce-JO` / `X-Workforce-Thread` headers for tracing.
- Subject: `[JO 1900000107 · Pipe Spool Installation] Follow-up — <first 60 chars>`; replies are
  `Re: [JO …] …` using the stored subject.
- Body: the new message, the context stamp, the last 3 messages as history, and **two buttons**:
  **Reply** and (on an escalation) **Acknowledge**.
- Plain-text alternative alongside HTML. No tracking pixels, no remote images.

### 5.3 Who is emailed, and how often

- The **owner** (or the addressed participant) immediately, for Follow-up / Instruction / Escalation.
- Other participants: a **reply** goes to everyone in the thread except the author, batched — one mail
  per thread per 10 minutes ("3 new replies in JO 1900000107"), so a fast exchange does not become 12
  e-mails. `MUTE` per participant stops the batched mail but keeps in-app unread.
- Nothing is emailed to the author, and never to an address that has been marked bounced.

### 5.4 The escalation clock (the third innovation)

An `ESCALATION` starts a visible clock, and every step is a System message in the thread:

| After | Action |
|---|---|
| 0h | owner emailed with **Acknowledge** and **Reply** |
| 8h (configurable) without a reply or acknowledgement | reminder to the owner + their **HOD** |
| 24h | **COO** and the Project Manager are told it is unanswered |
| on acknowledge | clock stops, system line "#4 acknowledged by …" |

The dashboard gets one number: **oldest unanswered escalation**, in hours. That is the figure a COO
actually asks for.

### 5.5 The link — no login required

`GET /thread/<token>` renders a **public reply page**: the thread history (read-only), the context
stamp, and a reply box. The token is:

- 32 random bytes, stored **hashed**, single thread + recipient email, 30-day expiry, revocable;
- bound to the recipient's address; the page states plainly **"You are replying as
  r.patil@swan.co.in"** so nobody wonders who they are;
- rate-limited, no attachments in v1, reply length capped, and every post records
  `source = MAGIC_LINK` with the IP hash — visible in the thread as "replied from e-mail";
- **not a session**: it cannot read another thread, cannot change any record, and expires.

Risk accepted and stated: whoever controls the mailbox can post as that address. That is the same model
issue trackers use, and it is why the link is scoped and revocable rather than a login.

## 6. The in-app side

- **Entry points.** A speech-bubble button with an unread count on every Job Order row: Project Master →
  Job Order tab, the portfolio "Job work" / "Project structure" registers, Job Order Progress, and the
  Job Order Summary. Clicking opens the **thread drawer**.
- **The drawer** (right side, 560px, or full-screen sheet on a phone) — §7.1.
- **`/messages`** — "Conversations": my threads, unread, escalations, resolved; filters by project, Job
  Order, kind, state. This is where a PM starts the day.
- **Header bell** with an unread count, polling every 60s (no websockets in this app; a poll is honest
  and survives proxies). Opening a thread marks it read.
- **The pop-up you asked for:** when the poll finds a new message in a thread you take part in, a toast
  appears bottom-right — "Project Manager asked a follow-up on 1900000107" with **Reply**, which opens
  the drawer with the composer focused. Escalations get a persistent banner until acknowledged, not a
  toast that disappears.

## 7. The UI — FROZEN (19-10-2026)

Answered by you, recorded here as the build contract; everything below is drawn to match.

| # | Decision |
|---|---|
| 1 | **Drawer on the right**, as drawn. It is **collapsible**, and its header carries an **expand** control that promotes the conversation to a full page (`/job-orders/:id/conversation`). The drawer state (open/collapsed/expanded) is remembered per user. |
| 2 | The composer **always states who you are and your role** — "Reply as A. Manager (Project Manager)" — even when it matches the reader's. In a six-role thread, ambiguity about the author is the defect this prevents. |
| 3 | **A nav item, "Conversations", under Operations**, carrying the unread count, *plus* the header bell. Rationale in §7.7. |
| 4 | **One e-mail per message** (no batching). Replies included. The per-thread mute stays as the only volume control. |
| 5 | The no-login page shows the **whole history of that Job Order's thread** — the trail is the point. It carries the "You are replying as …" line, and the token can only ever expose the one thread. |
| 6 | The escalation **banner persists until acknowledged** (or until the thread is resolved). No dismiss-for-an-hour. |
| 7 | `User.notificationEmail` is **approved** — the one new personal field; captured on Role Assignment / Employee Registration / CSV, with "no address" surfaces. |

Numbers below are for referring to a change ("change 14").

### 7.1 Thread drawer

```
┌──────────────────────────────────────────────────────────────────────────────┐ 1
│ 1900000107 · Pipe Spool Installation                                  [×]    │ 2
│ CSR.013 MV AINA · WBS H030.002 · Network N-1042 · Hull / Fabrication          │ 3
│ Owner  R. Patil (Section Head)   ● Open · 7 messages · last 2h ago            │ 4
├──────────────────────────────────────────────────────────────────────────────┤
│ [All] [Follow-ups 3] [Escalations 1] [Decisions 1]          [Resolve thread] │ 5
├──────────────────────────────────────────────────────────────────────────────┤
│ #7  Instruction · A. Manager · PM · 18-10-2026 14:32            [⋯]          │ 6
│     Burn 82% AMBER · Schedule DELAYED 6d · Qty 64% · Budget rev 3      ⌄      │ 7
│     Please re-sequence the remaining spool fit-ups; the grating is        │ 8
│     holding the deck. Confirm a plan by Thursday.                            │
│     ▸ emailed to r.patil · delivered 14:32                          │ 9
├──────────────────────────────────────────────────────────────────────────────┤
│ #6  Reply · R. Patil · Section Head · 18-10-2026 11:05                       │10
│     Two fitters are on the grating; spools resume Friday.                    │
│     ▸ replied from e-mail                                            │11
├──────────────────────────────────────────────────────────────────────────────┤
│ #5  Escalation · S. Rao · HOD · 17-10-2026 09:12 · acknowledged 09:40        │12
│ #4  System · assigned to R. Patil · 17-10-2026 09:10                         │13
├──────────────────────────────────────────────────────────────────────────────┤
│ Reply as A. Manager (Project Manager)          Kind [Reply ▾]                 │14
│ ┌──────────────────────────────────────────────────────────────────────────┐ │15
│ │ Write a follow-up, instruction or decision…                              │ │16
│ └──────────────────────────────────────────────────────────────────────────┘ │17
│ [Attach · later]  [ ] Email the owner now            [Send reply]            │18
├──────────────────────────────────────────────────────────────────────────────┤
│ Participants: R. Patil (owner) · S. Rao · Planning · + Add participant        │19
└──────────────────────────────────────────────────────────────────────────────┘
```

Notes on the numbered items:
1. Drawer overlays the page (the row stays visible); ESC closes; the URL gains `?thread=<id>` so a
   thread is linkable and survives a refresh.
2. Job Order identity — the same `code · name` used everywhere else in the app.
3. Structure line: project · WBS · Network · Department / Section. This is what makes it *traceable*
   to a place in the hierarchy.
4. Owner + state line. "No owner" appears in warning colour with a link to Project Master.
5. Filters as chips with counts (not a dropdown — one click to the escalations).
6. Author block: sequence, kind, name, role, timestamp; `⋯` = edit (creates a revision) / copy link.
7. The context stamp, collapsed; `⌄` expands to the full snapshot.
8. Body — plain text with line breaks, URLs auto-linked. No rich text in v1.
9. Delivery truth: "emailed to r.patil · delivered 14:32" or "not emailed — no address" (in the warning
   colour). Never a bare "sent".
10. Newest first, one by one down the list.
11. Source badge when the message came from the e-mail link or the no-login page.
12. Escalation shows its clock outcome inline.
13. System lines are visually quieter, never hidden.
14. Composer identity is stated, because in a thread with six roles it matters who you are.
15. Kind selector: Reply is the default; Instruction/Escalation/Decision appear only for roles that may
    use them.
16. On choosing **Decision**, a "proposed change" row appears (budget / planned window / status) with
    the same fields as Project Master, and a "requires approval by …" line.
17. `Ctrl+Enter` sends; the send button is disabled while empty.
18. "Email the owner now" is ticked by default and unavailable when there is no address (with the
    reason on hover).
19. Participants with the owner marked; adding one asks for a role or a person.

### 7.2 Conversations list (`/messages`)

```
Conversations                                        [Unread 4] [Escalations 2]
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● 1900000107 · Pipe Spool Installation        Escalation · 8h unanswered      │
│   R. Patil asked for a re-sequence plan               CSR.013 · Hull/Fab       │
├──────────────────────────────────────────────────────────────────────────────┤
│   1900000204 · Block Transfer                 Reply · A. Manager 2h ago       │
│   "Spools resume Friday"                              CSR.012 · Hull/Fab       │
└──────────────────────────────────────────────────────────────────────────────┘
```

Row shows: unread dot, Job Order, last kind + age, snippet, project · department. Escalations sort
first, then unread, then by last message.

### 7.3 The e-mail

```
Subject: [JO 1900000107 · Pipe Spool Installation] Follow-up — re-sequence spools
From: Workforce <workforce@…>        Reply-To: a.manager@swan.co.in

A. Manager (Project Manager) asked a follow-up on 1900000107:

  Please re-sequence the remaining spool fit-ups; the grating is holding the deck.
  Confirm a plan by Thursday.

  Burn 82% AMBER · Schedule DELAYED 6d · Qty 64% · Budget rev 3
  CSR.013 MV AINA · WBS H030.002 · Network N-1042

  [ Reply ]        [ Acknowledge ]   (Acknowledge on escalations only)

  Earlier in this thread
  ─ #6 R. Patil, 18-10-2026 11:05 — Two fitters are on the grating; spools resume Friday.
  ─ #5 S. Rao, 17-10-2026 09:12 — Escalation: the grating is holding the deck.

You are receiving this because you are the owner of this Job Order.
```

### 7.4 The public reply page (no login)

```
┌──────────────────────────────────────────────────────────────┐
│  SWAN logo      Workforce · Job Order conversation            │
│  1900000107 · Pipe Spool Installation                         │
│  You are replying as r.patil@swan.co.in  (not you? ask for a  │
│  new link)                                                    │
├──────────────────────────────────────────────────────────────┤
│  #7 Instruction · A. Manager · 18-10-2026 14:32               │
│  …body… · context stamp                                       │
│  #6 Reply · R. Patil · 18-10-2026 11:05  …                    │
├──────────────────────────────────────────────────────────────┤
│  Your reply                                                   │
│  ┌────────────────────────────────────────────────────────┐   │
│  │                                                        │   │
│  └────────────────────────────────────────────────────────┘   │
│  [ ] Also e-mail me a copy          [Send reply]              │
└──────────────────────────────────────────────────────────────┘
```

Same page shows a success state ("Reply posted — it is visible to the Project Manager"), the thread
refreshed, and a "Reply" box that stays open for a second answer. Token errors are stated plainly:
"this link expired on 18-11-2026 — ask the Project Manager for a new one".

### 7.5 Bell + toast

- Bell: `🔔 4` in the header; panel lists the newest 8 with Job Order + snippet; "See all" → `/messages`.
- Toast (bottom-right, 8s, dismissible): "**Project Manager** asked a follow-up on **1900000107**" with
  **Reply** and **Later**. Only for threads you participate in. An escalation raises a **banner** that
  stays until acknowledged.

### 7.7 Why "Conversations" belongs in the nav (my recommendation for Q3)

The bell is a **notification**; the nav item is a **place of work**. A Project Manager's day starts
with "what is waiting on me", and that is a list, not a popup: the nav entry is linkable, bookmarkable,
survives a reload, and shows the count even after the bell panel has been closed. The bell stays for
the transient case (a reply arrives while you are on another screen). Two entry points, one list, no
second inbox — the bell's "See all" opens the same page.

Placement: **Operations**, under Portfolio dashboard and Reports, labelled **Conversations** with the
unread count as a pill. For a phone the nav rail is a drawer already, so the same item appears there and
the bell remains in the header.

### 7.6 Job Order row indicator

A speech-bubble icon + count on the row, with three states: grey (no thread), blue (open, read), amber
dot (unread), red dot (open escalation). Tooltip carries the last message one-liner.

## 8. Data model (new tables, all additive)

```prisma
model JobOrderThread {
  id             Int      @id @default(autoincrement())
  jobOrderId     Int      @unique
  jobOrder       JobOrder @relation(fields: [jobOrderId], references: [id], onDelete: Cascade)
  status         String   @default("OPEN")      // OPEN | RESOLVED
  openedById     Int?
  openedAt       DateTime @default(now())
  resolvedById   Int?
  resolvedAt     DateTime?
  lastMessageAt  DateTime @default(now())
  lastMessageById Int?
  messageCount   Int      @default(0)           // denormalised for the list + badge
  @@index([status, lastMessageAt])
}

model JobOrderMessage {
  id           Int      @id @default(autoincrement())
  threadId     Int
  seq          Int                              // per-thread, monotonic; the quotable number
  kind         String                           // FOLLOW_UP | INSTRUCTION | ESCALATION | REPLY | DECISION | SYSTEM
  authorUserId Int?                             // null when posted from a magic link
  authorEmail  String                           // always: who spoke, even without an account
  authorName   String
  authorRole   String
  source       String   @default("APP")         // APP | MAGIC_LINK | SYSTEM
  body         String
  bodyRevision Int      @default(1)
  editedAt     DateTime?
  editedById   Int?
  replyToId    Int?                             // the message this answers
  contextJson  String?                          // the frozen Job Order snapshot (§4.2)
  proposalJson String?                          // the proposed change on a DECISION (§4.3)
  escalationDueAt DateTime?                     // the clock (§5.4)
  acknowledgedAt  DateTime?
  ipHash       String?
  createdAt    DateTime @default(now())
  @@unique([threadId, seq])
  @@index([threadId, createdAt])
}

model JobOrderThreadParticipant { id, threadId, userId?, email, roleAtJoin, addedById, addedAt, mutedAt?, lastReadAt? }
model JobOrderMessageRecipient   { id, messageId, email, userId?, state, sentAt, error?, }   // per-recipient delivery truth
model JobOrderReplyToken         { id, tokenHash @unique, threadId, email, userId?, createdById, expiresAt, revokedAt?, useCount, lastUsedAt }
```

Plus on `JobOrder`: `ownerUserId Int?`, `ownerAssignedById Int?`, `ownerAssignedAt DateTime?`, and on
`User`: `notificationEmail String?`.

Migration is additive (new tables + nullable columns), so it can ship the same way as the last release.

## 9. API surface

```
GET    /api/threads                      my conversations (scoped, paged)
GET    /api/job-orders/:id/thread        the thread + messages (scoped)
POST   /api/job-orders/:id/thread/messages   { kind, body, replyToId?, proposal?, emailOwner }
POST   /api/threads/:id/resolve | /reopen
POST   /api/threads/:id/participants     { userId | email, role }
POST   /api/threads/:id/read             mark read to now
GET    /api/threads/unread-count         the bell
POST   /api/messages/:id/acknowledge     (also from a magic link)
GET    /thread/:token                    public reply page (no auth)
POST   /thread/:token/reply              public reply (no auth, rate-limited)
GET    /api/job-orders/:id/messages.xlsx   the thread as a workbook (optional, P2)
```

Gates: `requireRoles("PROJECT_MANAGER","PM","HOD","DEPT_HEAD","COO","ADMIN")` **and** a per-Job-Order
scope check through the existing helpers. The public routes never touch a session.

## 10. Traceability rules (the point of the feature)

1. Append-only: no delete; edit = revision + system line; the original is retained.
2. `seq` per thread makes a message quotable forever.
3. Every message carries the operational snapshot — decisions are read in context.
4. Every recipient has a delivery record (queued / sent / failed / no address), shown on the message.
5. Every escalation records its clock outcome, acknowledged or escalated.
6. A **Decision** links to the change it produced (`linkedMessageId` on the revision / JO update).
7. The thread exports to PDF/XLSX for the Job Order dossier and the weekly review.
8. Retention: messages are never pruned; indexes keep the drawer fast at 10k messages.

## 11. Innovative additions (beyond the brief)

| # | Idea | Why it is worth it | Cost |
|---|---|---|---|
| 1 | **Context stamp** on every message | ends "it was on plan when we spoke" | S |
| 2 | **Decisions that carry the change** | the thread becomes the approval trail, not a parallel inbox | M |
| 3 | **Escalation clock with an ACK link** | nothing rots silently; COO gets one number | M |
| 4 | **"Ask for a plan by Thursday"** — a follow-up can carry a due date, shown as a promise and chased | turns chat into a commitment register | S |
| 5 | **Thread health on the dashboard** — open threads, oldest unanswered, escalations by project | makes communication measurable | S |
| 6 | **Reply-by-email** (P2): a per-thread address `jo-1900000107@…`, parsed inbound | people live in Outlook | L |
| 7 | **Digest** ("3 threads need you") at 08:00 for anyone with unread | one mail, not twenty | S |
| 8 | **Copy thread link** into WhatsApp/Outlook for a no-login reader? No — token page needs an address-bound token; instead a "read-only share link" is a separate, expiring artefact | avoids leaking a thread | M |
| 9 | **Mention a role** (`@HOD`) that pulls in the next person up the ladder | escalation without hunting for a name | S |

## 12. The assistant — where AI earns its place, and where it must not

You asked whether an AI agent can add value here. It can, but only if it is bolted to the facts this
app already computes and never allowed to speak for anyone. The rules first, because they decide the
design:

1. **Facts first, prose second.** Every number the assistant uses is the number the report and the
   context stamp already show. It reformats and explains; it never estimates, never invents.
2. **It drafts; a human sends.** Generated text lands in the composer labelled *Draft — review before
   sending*. No autonomous replies, no auto-approvals, no auto-rescheduling.
3. **Off unless configured, never in the critical path.** `ASSISTANT_ENABLED=false` by default. With no
   endpoint the panels say "assistant unavailable" and every feature still works by hand. Sending a
   message never waits on a model.
4. **Your data stays yours.** Point it at an on-prem endpoint (Ollama / vLLM / an internal gateway) by
   `ASSISTANT_BASE_URL`. If a cloud endpoint is ever used, only that thread's text and that Job Order's
   facts leave the building, e-mail addresses are redacted by default, and it is a switch, not a default.
5. **Authorship is recorded.** A message sent from a draft stores `assistedBy` (model, draft id). A
   reader — or an auditor — can always tell a machine-written draft from a typed one.

### 12.1 The six things it does (ranked by value, not by novelty)

| | Feature | What the stakeholder gets | Effort |
|---|---|---|---|
| **A1** | **Standing brief per Job Order** — "Bottleneck card" | Every JO row and drawer opens with: *what is happening* (schedule band, days late, qty outstanding vs plan elapsed, burn vs qty, days since last booking, unapproved hours, open escalations), *what it costs*, and **"Action for <role>: …"**. Deterministic scoring, model only polishes the sentence. | S–M |
| **A2** | **Draft the message** | In the composer: "Draft with assistant" produces a follow-up / instruction / escalation in the yard's tone, using the brief and the last few messages — with the ask and a proposed deadline. The PM edits and sends. | M |
| **A3** | **"Where this stands"** | A 3-bullet summary pinned at the top of a long thread, regenerated on demand (cached per message count). This is what makes a 40-message thread usable for a COO or a new PM. | S |
| **A4** | **Commitment register** | Every reply is scanned for a promise with a date — "spools resume Friday", "plan by Thursday" — and filed as a `JobOrderCommitment` tied to that message: owner, due date, OPEN / KEPT / MISSED. The system chases it on the day, and the dashboard shows **promises overdue**. *This is the single biggest step towards "absolute clarity on follow-ups"* — it turns prose into a ledger. Deterministic date parsing first, model assist second, and a human can always say "not a promise". | M |
| **A5** | **Bottleneck tags** | One tap on a follow-up or escalation: Material · Drawing · Manpower · Equipment · Access · Weather · Other. Aggregated per project and month. Deliberately **not** generative — structure beats prose — with the model only *suggesting* the likely tag for a human to confirm. | S |
| **A6** | **"What needs me today"** | `/messages` ordered by a computed urgency score (escalation age, Job Order criticality, promises overdue), each row carrying a one-line reason. The score is deterministic and unit-tested; the model only writes the sentence. | S–M |
| **A7** | *(P4, only if wanted)* | Semantic search over threads ("what did we agree about gratings on CSR.013?") and reply-by-email — the **IMAP credentials the deployment already holds** make inbound mail parsing feasible without new infrastructure. | L |

### 12.2 What it must never do

- Write a number that the report did not compute. (A test feeds the prompt builder a fixture and
  asserts every figure in it came from the facts object.)
- Post, approve, or send anything on its own.
- Reorder the thread, hide a message, or summarise away a dissent.
- Become a dependency: with the model unreachable, drafting and summarising are simply absent.

### 12.3 How it is wired

- `services/assistant.ts` — pure prompt building (`buildBriefPrompt`, `buildDraftPrompt`,
  `buildSummaryPrompt`) plus one transport call, so the prompts are unit-tested with no network.
- `routes/assistant.ts` — `GET /api/assistant/job-orders/:id/brief`,
  `GET /api/assistant/threads/:id/summary`, `POST /api/assistant/draft`. Read-only, authenticated,
  rate-limited per user, scoped by the same rules as the thread.
- Config: `ASSISTANT_ENABLED`, `ASSISTANT_BASE_URL`, `ASSISTANT_MODEL`, `ASSISTANT_API_KEY`,
  `ASSISTANT_TIMEOUT_MS`, `ASSISTANT_MAX_TOKENS`, `ASSISTANT_REDACT_EMAILS`.
- `assistant_usage` table: who, thread, action, model, tokens, `accepted | edited | discarded` — the only
  way to know whether the assistant is earning its place.
- The deterministic half (score, tags, commitment dates) lives in `services/` as pure functions with
  tests; the model is an optional layer on top. **If the model were switched off for good, A1/A4/A5/A6
  would still work in template form** — that is the test of a useful assistant.

## 13. Non-goals for v1

Attachments, rich text, typing indicators, presence, websockets, inbound e-mail parsing, chat on
Projects/WBS levels, mobile push, translation, and any change to approvals or timesheets.

## 14. Phases (each shippable)

**P0 — the spine (no e-mail yet).** Tables + migration; owner on Job Order (Project Master picker, with
the fallback chain); thread drawer with kinds, sequence, context stamp, resolve; `/messages`; bell +
polling; scope checks + tests for every role. *Outcome: staff can hold the conversation in-app.*

**P1 — e-mail + no-login reply.** `notificationEmail` capture + the "no address" surfaces; outbox table +
worker (retry, batched replies); the HTML mail; signed tokens; the public reply page; acknowledge;
delivery truth on each message. *Outcome: the owner can answer from Outlook without an account.*

**P2 — decisions, clock, commitments.** Proposal-carrying decisions writing the real change; the
escalation ladder + the "oldest unanswered" number; **the commitment register (A4) with deterministic
date parsing and a human "not a promise" override**; **bottleneck tags (A5)**; thread export.
*Outcome: promises in prose become a ledger the yard can be held to.*

**P3 — the assistant.** A1 brief, A3 "where this stands", A2 drafting, A6 "what needs me today", with
`assistant_usage` instrumentation. Every one of them degrades to a template when no model is configured.
*Outcome: the same data, explained per role, without ever speaking for a person.*

**P4 — optional.** Semantic search over threads; reply-by-email via the IMAP credentials the deployment
already holds; the digest mail.

## 15. Decisions (frozen 19-10-2026)

1. **§7.1 layout** — drawer on the right (as drawn) or a full page per Job Order? The drawer keeps the
   register behind it; a page gives the thread more room.
2. **§7.1 item 14** — should the composer show your role every time, or only when it differs from the
   reader's?
3. **§7.2** — is "Conversations" a **new nav item**, or does it live inside the bell panel only?
4. **§7.3** — one mail per message (immediate) or the 10-minute batch described in §5.3?
5. **§7.4** — may a no-login recipient **see the whole history**, or only the message they were sent plus
   their own replies? (Whole history is friendlier; narrower is safer.)
6. **§7.5** — escalation banner: persistent until acknowledged, or also dismissible for 1 hour?
7. Confirmation that **`notificationEmail`** may be added to the account (this is the one place the
   feature needs a new personal field).

All seven are answered in §7.0, and `docs/plans/mocks/job-order-conversations.html` has been updated to
show the two things those answers changed: the **collapsible / expandable** drawer header, and the nav
entry that now carries the unread count.

**Next:** P0 starts on your word — the in-app spine (tables, owner on Project Master, drawer, the
Conversations page, the bell, scope checks with a test per role), with the assistant left until P3 so the
conversation is useful before anything is generated.
