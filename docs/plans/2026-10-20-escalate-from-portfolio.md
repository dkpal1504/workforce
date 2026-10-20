# Escalate from the Portfolio — hover → popover → the Job Order's thread

**Status:** P1, P2 and P3 SHIPPED 20-10-2026 (commit `feat(portfolio): escalate from a row`). P4 remains open.
**Date:** 20-10-2026
**Touches:** `apps/web/src/pages/PortfolioDashboardPage.tsx`, `apps/web/src/pages/ConversationsPage.tsx`,
`apps/web/src/components/…` (new), `apps/api/src/routes/conversations.ts`, one additive migration.

---

## 1. What is being asked

On the Portfolio Dashboard, in the row-based sections, hovering a row should raise a small popover —
**"Do you want to escalate to the Job Owner?"** — and clicking it should land on the Job Order's
conversation, already addressed to that Job Order, in that Project, with the escalation ready to send.

In practice that is three things joined up: an affordance on the row, a deep link that carries the
Job Order, and a composer that arrives pre-armed.

## 2. What already exists and can be leaned on

| Piece | Where | Note |
|---|---|---|
| `/conversations?jobOrder=<id>` opens the drawer on that Job Order | `ConversationsPage.tsx` | shipped; the URL is already the contract |
| `ESCALATION` message kind, e-mailed to the owner, 8h/24h clock | `conversations.ts` + `conversationScheduler.ts` | unchanged |
| Owner resolution (explicit → Section HOD → Dept HOD) | `services/jobOrderContext.ts` | the popover can name the person it will address |
| Frozen context stamp on every message | `services/jobOrderContext.ts` | the escalation arrives with the numbers already in it |
| Scope (PM = assigned projects, HOD = dept/section, PM/COO/ADMIN = all) | `conversationScope.ts` | a row visible in the report is already inside the reader's conversation scope |

Nothing new is needed in the conversation engine. This is a **join**, not a second feature.

## 3. The rows, and the one real fork

The tabs the user named hold **two different kinds of row**:

1. **Needs push** and **Schedule & delays** — one row per **Job Order**: `PortfolioJobRow` carries
   `id` (the Job Order), `code`, `name`, `project`, `wbs`, `department`, and the bands
   (`hoursBand`, `scheduleBand`, `daysToEnd`, `qtyCompletePct`, `attentionScore`). A link is trivial:
   `/conversations?jobOrder=${row.id}`.
2. **Project structure** — a **tree**: Project → WBS → Network, each node carrying `jobOrderIds[]`,
   not one Job Order. A node therefore cannot escalate "to the Job Order" without choosing one.

**Resolved (20-10-2026):** the third tab is **Project structure** — the Project → WBS → Network tree
that already exists. There is no "Project schedule" tab and none is being added. A structure node's
popover offers that node's Job Orders (worst first, by the same attention score) and, when the node
holds exactly one, goes straight there.

**Also resolved:** the affordance appears on those THREE tabs only — Needs push, Schedule & delays,
Project structure. **Job work** (the full register) deliberately does NOT get it, so a stray hover in a
300-row table cannot raise an escalation.

## 4. The interaction

- **Hover intent, not hover-accident.** The popover appears after **350 ms** on the row and closes
  after a **150 ms** grace period, so travelling into the popover does not dismiss it and sweeping the
  mouse across a table does not strobe. It never navigates by itself — only the click does.
- **Where it appears:** anchored to the row's right edge, flipped above/below to stay inside the
  viewport, ~240 px wide, one line plus one button. It is rendered **once** (a single portal element
  positioned from `getBoundingClientRect`) rather than once per row — these tables run to hundreds of
  rows and a popover per row would be hundreds of nodes.
- **What it says:**
  `Escalate to Job Owner?` / `Ramesh Mahalingam · Section HOD` / `B1049 · 6 days late · 36% qty ·
  82% burn AMBER` / button `Escalate`.
  The owner name comes from a new lightweight read (see §6) and is cached for the session; while it
  loads the line reads "the Job Order's owner". With no owner resolvable it says **"No owner set — the
  Section HOD will be addressed"**, never a blank.
- **Keyboard and touch.** The affordance is a real `<button>` in a 28 px action column, reachable by
  Tab, opening the same popover on focus and on Enter. On a touch screen the column is always visible
  at full opacity (there is no hover to reveal it). `Escape` closes; `aria-haspopup="dialog"`,
  `aria-expanded`, and the popover labelled by the row's Job Order.
- **Only where the role may escalate.** The affordance renders only when `capabilities.viewConversations`
  is true. The API already refuses an out-of-scope escalation, so this is courtesy, not security.

## 5. The deep link

```
/conversations?jobOrder=366&intent=escalate&kind=ESCALATION&from=needs-push&projectId=15
```

- `jobOrder` — opens the drawer (already supported).
- `intent=escalate` — puts the drawer in escalation mode: kind preselected `ESCALATION`, the composer
  focus in the textarea, and a dismissible strip at the top:
  **`Escalating from Portfolio · Needs push`** with `← Back to the portfolio`.
- `kind` — kept explicit so a future "follow up" affordance reuses the same link shape.
- `from` — the tab id, recorded with the message (see §6) and used for the banner and the return link.
- `projectId` — display only: it lets the drawer show "CSR.014 · Ocean Citrine" while the thread
  loads, and lets the return link restore the Project filter.

**The prefill is deterministic, never AI.** The body arrives as plain text built from the row's own
numbers:

> B1049 is 6 days past its planned end with 36% quantity complete and 82% of budget hours used (AMBER).
> Please confirm the recovery date and the crew plan for the remaining scope.

Same figures the row is showing, so the message cannot contradict the screen. The **Draft with
assistant** button stays available inside the composer for anyone who wants prose; it is not on the
click path, so this works with the assistant switched off.

## 6. Server side — three small additions

1. **`origin` on the message** (nullable `String`, `POST /conversations/messages` accepts it, validated
   against a closed list: `PORTFOLIO_NEEDS_PUSH`, `PORTFOLIO_SCHEDULE`, `PORTFOLIO_STRUCTURE`).
   Why a column and not a field inside `contextJson`: the trail should be **queryable** — "how many
   escalations were raised from the dashboard last month, and did they get answered" is the whole point
   of putting the button there. One additive column, no backfill, no index needed at first.
2. **Owner for the popover** — `GET /api/job-orders/:id/conversation/owner`, returning
   `{ owner: { name, basis, email } }` from the existing `resolveOwner`, scope-checked by the existing
   `canAccessJobOrder`. Two queries per hover, cached client-side; no new logic.
3. **The structure-node picker** — extend `GET /api/conversations/job-orders` with optional
   `projectId`, `wbsId`, `networkId` filters (intersected with scope, never widening). The popover then
   lists that node's Job Orders without bloating the report payload with a second copy of the register.

## 7. Duplicate protection — the one rule that matters

An escalation is not a note; it starts an 8-hour clock and e-mails somebody. So before prefilling:

- If the thread already has an **unacknowledged `ESCALATION`**, do **not** prefill a second one. The
  drawer opens on that message, scrolled to it, with the composer in `REPLY` and a line:
  *"An escalation from 19-10 14:32 is still unanswered (#7). Reply to it instead?"* — with the
  **Escalate again** option behind a confirmation, because sometimes a second one is right.
- If the thread is `RESOLVED`, the first message reopens it (existing rule) — the banner says so.

This is the difference between a useful button and a machine for duplicating escalations.

## 8. The return journey

The banner's `← Back to the portfolio` returns to `/portfolio` with the tab, the filters and the section
the reader came from. The tab is currently **not** in the URL (a deliberate decision recorded in
`portfolioTabs.ts`: the tab is a view, not a contract). For this feature it has to travel — but only
as a **return hint**: `?returnTab=needs-push` on the conversations URL, read once by the banner and
never by the report fetch. That keeps the report's contract intact.

## 9. Phases

**P1 — the link and the landing (most of the value, no schema change).**
Action column + row-hover popover on Needs push and Schedule & delays; deep link with
`intent=escalate`; kind preselected; deterministic prefill; banner with the return link; owner name
resolved lazily. Tests: URL builder, prefill text, the dedupe rule, and that a row's numbers are the
ones in the prefill.

**P2 — the structure tab.** Node popover listing the node's Job Orders, worst first, plus the
`projectId/wbsId/networkId` filters on the picker endpoint.

**P3 — measurement.** `origin` column and its migration; a line in the portfolio export and in
`assistant_usage`-style reporting: escalations raised from the dashboard, median hours to first reply.

**P4 — optional polish.** The same affordance on the Reports tables (identical rows, same component);
a "needs escalation" filter chip on the dashboard; per-user popover delay in settings.

## 10. Test plan

- **Unit (web, node --test):** the link builder produces exactly the five parameters; the prefill quotes
  the row's numbers and nothing else; the dedupe function picks "existing" over "new" when an
  unacknowledged escalation is present; `from` is refused if it is not a tab id.
- **API:** `origin` accepted from the closed list and refused otherwise; the owner endpoint refuses a
  foreign Job Order (403) and an unknown one (404); picker filters intersect scope.
- **Live probe** (extend `probe-conv.sh`): as a Project Manager, escalate from a row of an assigned
  project → 201 with `origin` persisted; from a foreign project → 403; second escalate on the same
  thread lands in reply mode.
- **Visual:** Nocturne and Harbor, keyboard-only walk, touch-width column, and a 200-row table to
  confirm the single portal element does not lag.

## 11. Deliberately out of scope

- No Gantt/“Project schedule” view — that is a new report, not a link.
- No bulk escalation of a selection (it invites a mail storm; can come later with a cap).
- No new permission: the six conversation roles and their existing scopes decide.
- No AI in the click path.

## 12. Scope, confirmed 20-10-2026

Locked, and nothing outside it:

- **Three tabs only:** Needs push, Schedule & delays (one row = one Job Order) and Project structure
  (a node offers its Job Orders, worst first; one Job Order goes straight through). Job work and the
  other sections stay untouched.
- **Hover intent, never hover navigation:** 350 ms in, 150 ms grace out, popover opened by the row's
  action button on focus too; the click is the only thing that moves the page.
- **The prefill is built from the row's own figures** — no model in the click path.
- **An open escalation is never duplicated**: the drawer opens in reply mode on the live one.
- **`origin` recorded** so "raised from the dashboard" is answerable later.
- Roles: only an account holding `viewConversations` sees the affordance; the API enforces scope
  regardless.

Next step is P1 (§9). No code has been written.
