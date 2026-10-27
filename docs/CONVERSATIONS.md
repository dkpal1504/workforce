# Job Order conversations — operating manual

One thread per Job Order. Follow-ups, instructions, escalations, replies and decisions, each e-mailed
once, with the whole trail readable without an account.

This is the manual for the people who run and use it. The reasoning behind each rule is in
`docs/plans/2026-10-19-job-order-conversations.md` (the feature) and
`docs/plans/2026-10-20-escalate-from-portfolio.md` (the dashboard button).

**Contents**

1. Who sees what
2. The three screens
3. Escalating from the Portfolio
4. E-mail: who it comes from, and the reply link
5. The escalation clock, and promises
6. Documents
7. The assistant
8. Configuration
9. Releasing this to production
10. Troubleshooting
11. Not shipped yet

---

## 1. Who sees what

| Role | Reads |
|---|---|
| `PROJECT_MANAGER` | every Job Order of the Projects assigned to it in **Project managers** |
| `HOD` | its Department, narrowed to its Section set (no set = the whole Department) |
| `DEPT_HEAD` | its Department |
| `PM`, `COO`, `ADMIN` | everything |

Scope is resolved from the database on **every request** (`services/conversationScope.ts`) and intersected
with the Job Order. No token or query string can widen it. An unassigned Project Manager, an unmapped
head, or any role outside those six reads nothing and sees no screen and no nav item.

`DECISION` messages — the only kind that can carry a change to a Job Order — are limited to `PM` and
`ADMIN`, the two roles that already hold Project Master. Everybody else may follow up, instruct,
escalate and reply.

**The owner** a message is addressed to is, in order: the account named on the Job Order (Project master
→ Job Orders → owner), the HOD of that Job Order's Section, the department-wide HOD. The screen always
says which applied, and says **no owner** when none does — it never silently mails `itsupport`.

People are e-mailed at `users.notification_email`. If that is empty and the login is an
`@employee.local` handle, the message records **"not emailed — no address on file"** instead of failing
quietly. Fill the **notification address** on Role assignment for anyone who raises or answers
escalations; `User.email` is usually a login handle, not a mailbox.

## 2. The three screens

**The list** (`/conversations`, under Operations, with an unread badge on the rail). New first, and said
out loud: a `NEW n` heading carries the unread threads, `EARLIER` follows, and an unread row shows
`n new` with a bolder title and a solid preview. The order is decided on the server by `orderThreads`
(pure, tested): unread before read, an **unanswered** escalation first inside each group because it is
the only row with a clock running, then most recent activity. An acknowledged escalation no longer
floats — it is history.

The rail badge counts unread **messages** across the reader's scope, not threads.

**The search box** answers one question: "where is the conversation about X". It matches, in one pass:

| Type | Matches |
|---|---|
| a Job Order | its code (`M4122`) or its name |
| a Project | its code (`CSR.008`) or its name (`Ocean`) — and returns **every** Job Order under it that has a thread |
| a Project id | a bare number (`15`), and nothing else, so a project number is never confused with a Job Order code that happens to contain that digit |

The search runs **on the server**, over the reader's whole scope. It used to filter only the hundred threads
the page had already loaded, which meant a project's conversations were found only if they happened to be in
that page — and the rest were silently missing. Typing narrows instantly against what is loaded while the
request is in flight, so the two never disagree. Scope and search are ANDed: a search can only ever narrow
what a role may see, never widen it.

Matching is case-sensitive, like the Job Order code search it extends: codes are stored upper case, so type
`CSR.008`, not `csr.008`.

The **Start a follow-up** picker takes the same terms, so a planner can type a project code and pick the Job
Order to open.

**The drawer.** Header: the Job Order, its project, the owner and the thread state. Then a chip row —
`✦ Bottleneck brief`, `Where this stands`, `Expand all / Collapse all` — then the trail, then the
composer.

- **One message, one row.** `+ · kind · who · first words · time`, opened by clicking the row. The newest
  message opens by itself. This is what keeps a forty-message thread scannable.
- **The assistant is a dialog.** Both chips open a 680 px panel with the full text and the fact chips,
  closed with `×`, Escape or a click on the backdrop.
- **`⤢`** takes the drawer full-page for a long trail; **`⌃`** collapses it to the header.
- The composer is three rows and scrolls. **Ctrl+Enter sends.** "Reply as *Name (Role)*" is always shown.
- A message that was answered by e-mail is marked **via e-mail**; one raised from the dashboard carries
  its tab as a chip.

**The no-login reply page** (`/thread/<token>`), opened from the e-mail button. It renders that Job
Order's whole trail, newest first, and appends a reply. It cannot list threads, open another Job Order,
or approve anything.

## 3. Escalating from the Portfolio

On **Needs push**, **Schedule & delays** and **Project structure**, resting the pointer on a row for a
moment raises a popover — *Escalate to Job Owner?* — naming the owner it will address and quoting the
row's own figures. Clicking **Escalate** opens that Job Order's thread with the kind set to Escalation
and the message already written:

> M4157 is carrying no planned window at all, 0% quantity complete, 154% of budget hours used (RED).
> Please set the planned window and the quantity target, and confirm the date the work will be
> complete.

The text is arithmetic on the report's own figures, never generated, so it works with the assistant off
and cannot contradict the row.

- **Project structure** nodes own several Job Orders: a node with one goes straight through, a node with
  several lists them, worst first.
- **An open escalation is never duplicated.** If the thread already carries an unacknowledged
  escalation, the drawer opens on that one in reply mode and says so.
- Every message raised this way records an `origin`, shown as a chip; the drawer header prints
  *"N escalations raised from the dashboard in the last 90 days · median first reply 4h"*.
- **Job work has no affordance** on purpose: a 300-row register is no place for a hover that starts an
  escalation.
- Exactly one popover can exist at a time, and it is cancelled the moment the pointer moves on.

## 4. E-mail: who it comes from, and the reply link

The mailbox that **authenticates** and the name the reader **sees** are separated on purpose:

```
From:     "Sunil Babariya (Project Manager) - Workforce" <noreply@swan.co.in>
Reply-To: sunil.babariya@swan.co.in
```

- **From** stays the one service mailbox, because that is the address SPF, DKIM and DMARC check.
  Pointing it at the person without Send As rights means spoofing `swan.co.in`: fine under `p=none`,
  junked or refused under `p=quarantine`/`p=reject`.
- **Reply-To** is the author's own address, so Reply writes to the person who raised it.
- The display name is the author's name and role, sanitised — a name from the users table cannot break
  the header. A hyphen, not a middle dot: a non-ASCII character forces the whole name into an RFC 2047
  encoded word, which logs and some clients show raw.
- **`CONVERSATION_FROM_MODE=sender`** puts the person's address in From. Use it only after IT has
  granted the service account Send As on the mailboxes (Exchange/Graph). It degrades to `display` on its
  own when the author has no routable address.

**The reply link.** Each mail carries one button to `/thread/<43-char token>`. The token is stored only
as a SHA-256 hash, is bound to one address and one thread, expires in 30 days, and can only render that
thread and append a reply. Following the link changes nothing — a mail scanner that GETs it consumes
nothing — only the reply button POSTs. A forged or expired token is refused with 404 / 410.

One mail per message, no batching. The author is never mailed their own message; a recipient may mute a
thread.

## 5. The escalation clock, and promises

An `ESCALATION` is unanswered until somebody presses **Acknowledge** or replies. The 15-minute sweep then
writes SYSTEM lines into the same thread:

- **8 h** — reminded to the Section HOD and HOD;
- **24 h** — escalated to the COO and the Project Manager.

Each rung is written once, ever: the sweep reads the SYSTEM lines already in the thread, so a restart or
a double tick cannot repeat it. **The clock does nothing unless `CONVERSATION_SCHEDULER_ENABLED=true`.**

Promises found in a reply ("spools resume Friday") are registered with their due date and chased once on
the day — a false promise is worse than a missed one, so a sentence needs both a forward-looking verb and
a recognisable date before it counts.

## 6. Documents

Up to **5 per message, 10 MB each**. Allowed: PDF, PNG, JPG, WEBP, XLS(X), CSV, DOC(X), PPT(X), TXT, ZIP.
HTML, SVG, JS, EXE and every other script or executable is refused by extension; bytes are stored under a
random name with a SHA-256 in the row; every download is `Content-Disposition: attachment` + `nosniff`
and is re-authorised against the reader's scope (or the reply token's thread).

**There is no anti-virus scanner on the host.** The allow-list is a mitigation, not a guarantee. Uploads
that were never sent are deleted after 24 hours by the sweep.

The bytes live in `ATTACHMENT_DIR`, which **must be the `attachments` volume** in
`compose.production.yml` — the api container is `read_only: true` and has no other writable path.

## 7. The assistant

Three things, all optional, all read-only:

- **Bottleneck brief** — three sentences and an `Action for <role>:` line, built from the Job Order's own
  burn, schedule and quantity;
- **Where this stands** — three bullets over the last 20 messages;
- **Draft with assistant** — writes the composer's text; it is a draft, labelled *review before sending*.

It is a layer, never a dependency: with `ASSISTANT_ENABLED=false`, or the endpoint down, the brief falls
back to the deterministic template, the summary reports itself unavailable, and sending is unaffected.
The prompt carries only figures the report computed; a reasoning model's scratchpad is stripped before
anything reaches the screen.

## 8. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CONVERSATION_EMAIL_ENABLED` | `true` | `false` records recipients as `EMAIL_OFF` and sends nothing |
| `APP_BASE_URL` | `http://localhost:5173` | the address in the reply link — must be the real one |
| `CONVERSATION_FROM` | `SMTP_FROM` | the authenticated mailbox |
| `CONVERSATION_FROM_MODE` | `display` | `display` (recommended) or `sender` (needs Send As) |
| `CONVERSATION_SCHEDULER_ENABLED` | `false` | runs the sweep: the clock, the attachment cleanup, the chases |
| `CONVERSATION_SCHEDULER_MINUTES` | `15` | sweep interval |
| `CONVERSATION_REMINDERS_ENABLED` | `false` | **whether the application may mail anybody on its own** — the 8 h reminder and the 24 h escalation. Off means the clock is recorded (`escalationDueAt`, the review's by-age panel) but no rung is ever *sent*; person-posted mail is unaffected. The API prints `reminders: ON/OFF` at boot so an operator can see why the ladder is quiet |
| `ATTACHMENT_DIR` | `./data/attachments` | must be the mounted volume in production |
| `ASSISTANT_ENABLED` | `false` | the assistant layer |
| `ASSISTANT_BASE_URL` | — | OpenAI-compatible base, e.g. `http://10.5.1.178:8000/v1` |
| `ASSISTANT_MODEL` | `default` | the id from `GET {base}/models` |
| `ASSISTANT_API_KEY` | — | only if the endpoint needs one |
| `ASSISTANT_TIMEOUT_MS` | `25000` | per request |
| `ASSISTANT_MAX_TOKENS` | `320` | the answer is a paragraph, not a report |

## 9. Releasing this to production

Four migrations, **all additive**. No existing row is rewritten, nothing is dropped, there is no
backfill.

| Migration | What it does |
|---|---|
| `20261020000000_job_order_conversations` | creates 9 tables (threads, messages, participants, per-recipient delivery, reply tokens, commitments, attachments index, assistant usage); adds `users.notification_email`, `job_orders.owner_user_id`, `owner_assigned_by`, `owner_assigned_at` |
| `20261020000100_thread_read_seq` | `ADD COLUMN last_read_seq INTEGER NOT NULL DEFAULT 0` — constant default, metadata-only in PostgreSQL |
| `20261020000200_message_attachments` | creates `job_order_message_attachments` with its two indexes and three foreign keys |
| `20261020000300_message_origin` | `ADD COLUMN origin TEXT` (nullable) |

Before the deploy, on the production `.env.production`:

- `APP_BASE_URL` — the address people actually open, or every reply button 404s;
- `CONVERSATION_SCHEDULER_ENABLED=true` — otherwise no reminder and no escalation ever fires;
- `ATTACHMENT_DIR=/app/data/attachments` — matching the new `attachments` volume;
- `ASSISTANT_*` — optional; leave `ASSISTANT_ENABLED=false` until the endpoint is confirmed.

The release also **adds a named volume** to `compose.production.yml`. Existing uploads do not exist yet,
so there is nothing to migrate; the volume is created on the first `up`.

Rolling the code back leaves the new tables and columns inert — the older code never selects them. There
is no down-migration, and `migrate deploy` only moves forward.

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Not emailed — no address on file" | `notification_email` empty, login is a handle | fill the notification address on Role assignment |
| The rail badge counts higher than the list | badge counts messages, list counts threads | expected |
| `× new` never appears | already read, or you are the author | opening a thread marks it read |
| No reminder after 8 h | scheduler off | `CONVERSATION_SCHEDULER_ENABLED=true`, restart api |
| Upload fails / message loses its file | `ATTACHMENT_DIR` is not the volume, the volume is missing, or it is root-owned and the api runs as `node` | `docker compose … exec api ls -la /app/data` must show `attachments` owned by `node`; if it does not, `docker compose … run --rm --user root api chown -R node:node /app/data` |
| "Draft with assistant" answers *Not Found* | the button called a path the API does not serve | fixed; hard-reload the tab |
| The brief is a wall of `Thinking Process:` text | the model's scratchpad leaked | fixed: `enable_thinking:false` plus a cleaner; hard-reload |
| A screen looks unchanged after a deploy | the tab is serving the previous bundle | hard-reload (Ctrl+Shift+R), then check the code is mounted |

## 11. Not shipped yet

- accepting a `DECISION` still writes nothing — the proposal is stored and displayed, and the Project
  Master change is made by hand;
- no reply-by-email (IMAP), no semantic search, no weekly digest;
- the assistant's drafts are drafts: nothing is sent without a person pressing Send;
- no anti-virus scanning for attachments.
