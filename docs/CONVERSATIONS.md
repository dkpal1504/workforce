# Job Order conversations — operator guide

One thread per Job Order. Follow-ups, instructions, escalations, replies and decisions, each e-mailed
once, with the whole trail readable without an account. The design and the reasoning are in
`docs/plans/2026-10-19-job-order-conversations.md`; this page is what an operator needs.

## Who sees what

| Role | Reads |
|---|---|
| `PROJECT_MANAGER` | every Job Order of the Projects assigned to it in Project managers |
| `HOD` | its Department, narrowed to its Section set (no set = the whole Department) |
| `DEPT_HEAD` | its Department |
| `PM`, `COO`, `ADMIN` | everything |

Scope is resolved from the database on **every request** (`services/conversationScope.ts`) and then
intersected with the Job Order. There is no token or query-string widening. An account with no
assignment, an unmapped head or any role outside the six above reads nothing and sees no screen.

`DECISION` messages — the ones that can carry a change to the Job Order — are limited to `PM` and `ADMIN`,
the two roles that already hold Project Master.

## The owner

Each Job Order addresses an **owner**:
1. the account named on the Job Order (Project master → Job Orders → *Discuss* → owner), else
2. the HOD of that Job Order's Section, else
3. the department-wide HOD.

The UI always says which of the three applied, and says **"no owner"** when none does — it never
silently mails `itsupport`.

A person is e-mailed at `users.notification_email`. If that is empty and their login is an
`@employee.local` handle, the message records **"not emailed — no address on file"**. Fill their
notification address on Role assignment to fix it.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CONVERSATION_EMAIL_ENABLED` | `true` | `false` records recipients as `EMAIL_OFF` and sends nothing |
| `APP_BASE_URL` | `http://localhost:5173` | the host used in the reply link |
| `CONVERSATION_FROM` | `SMTP_FROM` | the From: address |
| `CONVERSATION_SCHEDULER_ENABLED` | `false` | turns on the 15-minute sweep |
| `CONVERSATION_SCHEDULER_MINUTES` | `15` | sweep interval |
| `ATTACHMENT_DIR` | `./data/attachments` | where uploads live — **must be a mounted volume** |
| `ASSISTANT_ENABLED` | `false` | turns on the assistant layer |
| `ASSISTANT_BASE_URL` | — | OpenAI-compatible base, e.g. `http://10.5.1.40:8000/v1` |
| `ASSISTANT_MODEL` | `default` | the id from `GET {base}/v1/models` |
| `ASSISTANT_API_KEY` | — | only if the endpoint needs one |
| `ASSISTANT_TIMEOUT_MS` | `25000` | per request |
| `ASSISTANT_MAX_TOKENS` | `320` | the answer is a paragraph, not a report |

The assistant is a layer, never a dependency: with it off, or the endpoint down, the brief falls back to
the deterministic template and sending is unaffected.

## Escalating from the Portfolio

On **Needs push**, **Schedule & delays** and **Project structure**, hovering a row for half a second
raises a small popover — *Escalate to Job Owner?* — naming the owner it will address and quoting the
row's own figures. Clicking **Escalate** opens that Job Order's thread with the kind set to Escalation
and the message already written:

> M4157 is carrying no planned window at all, 0% quantity complete, 154% of budget hours used (RED).
> Please set the planned window and the quantity target, and confirm the date the work will be
> complete.

The text is built from the report's own numbers, not by the assistant, so it works with the assistant
off and can never contradict the row.

- **Project structure** nodes own several Job Orders: a node with one goes straight through, a node
  with several lists them (worst first) to choose from.
- **An open escalation is never duplicated.** If the thread already carries an unacknowledged
  escalation, the drawer opens on that one in reply mode and says so.
- Every message raised this way records an `origin` (`PORTFOLIO_NEEDS_PUSH`, `PORTFOLIO_SCHEDULE`,
  `PORTFOLIO_STRUCTURE`), shown as a chip on the message. The Conversations header prints what they
  came to: *"N escalations raised from the dashboard in the last 90 days · median first reply 4h"*.
- **Job work** deliberately has no affordance: a 300-row register is not a place for a hover that
  starts an escalation.

## The escalation clock

An `ESCALATION` message is unanswered until somebody presses **Acknowledge** (in the app) or replies.
The sweep then writes SYSTEM lines into the same thread:

- **8 h** — reminded to the Section HOD and HOD;
- **24 h** — escalated to the COO and the Project Manager.

Each rung is written once, ever: the sweep reads the SYSTEM lines already in the thread, so a restart or
a double tick cannot repeat it. Promises found in a reply are chased on their due day, once.

## Attachments

Up to 5 per message, 10 MB each. Allowed: PDF, PNG, JPG, WEBP, XLS(X), CSV, DOC(X), PPT(X), TXT, ZIP.
HTML, SVG, JS, EXE and every other script or executable is refused by extension, the bytes are stored
under a random name, and every download is `Content-Disposition: attachment` + `nosniff`. Downloads are
authorised again against the reader's scope (or the reply token's thread).

**There is no anti-virus scanner on the host.** The allow-list is a mitigation, not a guarantee. Unsent
uploads are deleted after 24 hours by the sweep.

## The e-mail link

Each mail carries one button to `/thread/<43-char token>`. The token is stored **only as a SHA-256 hash**,
is bound to one address and one thread, expires in 30 days, and can only render that thread and append a
reply. Following the link changes nothing (a mail scanner that GETs it consumes nothing); only the reply
button POSTs. A forged or expired token is refused with 404 / 410.

## Migrations

Three, all additive:

- `20261020000000_job_order_conversations` — the nine tables, plus four nullable columns;
- `20261020000100_thread_read_seq` — the unread counter;
- `20261020000200_message_attachments` — the attachment index.

`prisma migrate deploy` on the production database. Rolling the code back leaves the new tables inert.

## Not shipped yet

- accepting a `DECISION` still writes nothing — the proposal is stored and displayed, and the Project
  Master change is made by hand;
- no reply-by-email (IMAP), no semantic search, no weekly digest;
- the assistant's drafts are drafts: nothing is sent without a person pressing Send.
