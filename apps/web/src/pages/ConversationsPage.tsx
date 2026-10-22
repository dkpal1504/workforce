/**
 * Conversations — one thread per Job Order, newest first, with the composer that keeps the trail
 * moving and the documents that make a follow-up answerable.
 *
 * Theme: every colour is a token from styles/themes.css (`--bg-elevated`, `--border`, `--text`,
 * `--text-muted`, `--primary`, `--warning`, `--danger`). There is not one literal hex value in this
 * file, so Nocturne, Harbor and every other theme paint it correctly.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import { api, getToken, ApiError } from "../api/client";
import { formatStamp } from "./formatDate";
import {
  decideEscalationMode,
  escalationPrefill,
  parseEscalateIntent,
  portfolioReturnHref,
  ORIGIN_META,
  type EscalateIntent,
} from "./escalateLink";

type ThreadRow = {
  id: number;
  status: string;
  messageCount: number;
  lastMessageAt: string;
  unread: number;
  muted: boolean;
  jobOrder: {
    id: number;
    code: string;
    name: string;
    department: { name: string };
    section: { name: string } | null;
    project: { code: string; name: string };
  };
  lastMessage: {
    seq: number;
    kind: string;
    body: string;
    authorName: string;
    authorRole: string;
    createdAt: string;
    escalationDueAt: string | null;
    acknowledgedAt: string | null;
  } | null;
};

type Attachment = { id: number; filename: string; sizeBytes: number };

type Message = {
  id: number;
  seq: number;
  kind: string;
  authorName: string;
  authorRole: string;
  authorEmail: string;
  source: string;
  body: string;
  bodyRevision: number;
  createdAt: string;
  escalationDueAt: string | null;
  acknowledgedAt: string | null;
  contextJson: string | null;
  proposalJson: string | null;
  origin: string | null;
  recipients: Array<{ email: string; state: string; sentAt: string | null }>;
  commitments: Array<{ id: number; dueOn: string; text: string; state: string; ownerEmail: string }>;
  attachments: Attachment[];
  /** One of the eight delay causes, when the author was the owner or a PM. */
  reasonCode: string | null;
  /**
   * The response clock, computed by the server with one "now". Null-free: a message with no clock carries
   * state NONE, so the screen never has to decide whether silence means "no clock" or "not loaded".
   */
  sla: {
    targetHours: number;
    state: "NONE" | "ANSWERED" | "OPEN" | "DUE_SOON" | "OVERDUE";
    elapsedHours: number;
    remainingHours: number;
    answeredAt: string | null;
    ladderStep: string | null;
  } | null;
};

type Thread = {
  id: number;
  status: string;
  messageCount: number;
  jobOrder: {
    id: number;
    code: string;
    name: string;
    status: string;
    project: { code: string; name: string };
    projectWbs: { wbsCode: string };
    network: { code: string } | null;
    department: { name: string };
    section: { name: string } | null;
  };
  messages: Message[];
  participants: Array<{ id: number; email: string; roleAtJoin: string; mutedAt: string | null; lastReadSeq: number }>;
};

type ConversationResponse = {
  jobOrder: { id: number; code: string; name: string; project: { code: string; name: string } };
  owner: { userId: number | null; email: string | null; name: string; basis: string };
  thread: Thread | null;
  canPostKinds: string[];
  recoveries: Recovery[];
  commitment: Commitment | null;
  emailEnabled: boolean;
  /** True only when the server is configured to send reminders on its own. Off is the default. */
  remindersEnabled: boolean;
  me: { id: number; name: string; role: string; email: string };
};

type ReasonOption = { code: string; label: string };

type Recovery = {
  id: number;
  messageId: number;
  state: "PROPOSED" | "ACCEPTED" | "REJECTED" | "SUPERSEDED";
  revisedFinishDate: string;
  manpowerPlanJson: string | null;
  note: string | null;
  proposedByName: string;
  proposedByUserId: number | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  slipDays: number | null;
  planMoved: boolean;
};

type Commitment = {
  plannedEndDate: string | null;
  committedFinishDate: string | null;
  committedRecoveryId: number | null;
};

type Hindrance = {
  id: number;
  projectWbsId: number;
  wbsCode: string | null;
  category: string;
  description: string;
  ownerEmail: string | null;
  raisedAt: string;
  raisedByEmail: string;
  raisedByUserId: number | null;
  targetDate: string | null;
  impactDays: number | null;
  state: "OPEN" | "CLOSED";
  closedAt: string | null;
  closedByName: string | null;
  closureNote: string | null;
  age: { days: number; stale: boolean };
};
type ThreadInsights = {
  total: number;
  uncoded: number;
  top: Array<{ code: string; label: string; count: number; share: number; averageOpenDays: number }>;
};

type BriefResponse = {
  facts: Array<{ label: string; value: string }>;
  numbers?: {
    burnPct: number | null;
    hoursBand: string | null;
    scheduleBand: string | null;
    daysToEnd: number | null;
    qtyCompletePct: number | null;
  };
  template: string;
  brief: string;
  assisted: boolean;
  reason?: string;
};

const KIND_OPTIONS = [
  { value: "FOLLOW_UP", label: "Follow-up" },
  { value: "INSTRUCTION", label: "Instruction" },
  { value: "ESCALATION", label: "Escalation" },
  { value: "REPLY", label: "Reply" },
  { value: "DECISION", label: "Decision" },
];

/**
 * Code → label for a chip on a message that carries a cause.
 *
 * The eight codes are fixed by design, so a local map cannot drift into a wrong label — only an
 * incomplete one, and the fallback shows the code rather than nothing. The composer's list still comes
 * from the server, which stays authoritative about which causes are offered.
 */
const REASON_LABELS: Record<string, string> = {
  MANPOWER: "manpower",
  MATERIAL: "material",
  DRAWING: "drawing",
  PERMIT: "permit",
  EQUIPMENT: "equipment",
  WEATHER: "weather",
  CLIENT_HOLD: "client hold",
  REWORK: "rework",
};
function reasonLabelOf(code: string): string {
  return REASON_LABELS[code] ?? code.toLowerCase();
}

const KIND_TONE: Record<string, string> = {
  FOLLOW_UP: "conv-kind",
  INSTRUCTION: "conv-kind conv-kind--instruction",
  ESCALATION: "conv-kind conv-kind--escalation",
  REPLY: "conv-kind",
  DECISION: "conv-kind conv-kind--decision",
  SYSTEM: "conv-kind conv-kind--system",
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function contextLine(json: string | null): string | null {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as {
      burnPct: number | null;
      hoursBand: string;
      scheduleBand: string;
      daysToEnd: number | null;
      qtyCompletePct: number | null;
      revisionNo: number | null;
    };
    const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
    const schedule =
      data.scheduleBand === "DELAYED" && data.daysToEnd !== null && data.daysToEnd < 0
        ? `DELAYED ${Math.abs(data.daysToEnd)}d`
        : data.scheduleBand.replace(/_/g, " ");
    return [
      `Burn ${pct(data.burnPct)} ${data.hoursBand}`,
      `Schedule ${schedule}`,
      `Qty ${pct(data.qtyCompletePct)}`,
      data.revisionNo === null ? "no budget revision" : `Budget rev ${data.revisionNo}`,
    ].join(" · ");
  } catch {
    return null;
  }
}

/** The file is behind the same scope check as the thread, so it is fetched with the token, not linked. */
async function downloadAttachment(path: string, filename: string) {
  const token = getToken();
  const response = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) return;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ConversationsPage() {
  const [params, setParams] = useSearchParams();
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [stats, setStats] = useState<{
    raisedFromPortfolio: number;
    answered: number;
    unanswered: number;
    medianHoursToFirstReply: number | null;
    windowDays: number;
  } | null>(null);

  const openJobOrder = Number(params.get("jobOrder")) || null;
  const intent = parseEscalateIntent(params);

  const load = useCallback(async () => {
    try {
      const data = await api<{ threads: ThreadRow[] }>(`/conversations/threads${filter === "unread" ? "?unread=1" : ""}`);
      setThreads(data.threads);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load conversations.");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    api<{ raisedFromPortfolio: number; answered: number; unanswered: number; medianHoursToFirstReply: number | null; windowDays: number }>(
      "/conversations/escalation-stats"
    )
      .then(setStats)
      .catch(() => undefined);
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter(
      (row) =>
        row.jobOrder.code.toLowerCase().includes(needle) ||
        row.jobOrder.name.toLowerCase().includes(needle) ||
        row.jobOrder.project.name.toLowerCase().includes(needle)
    );
  }, [threads, query]);

  // The server sends unread first; splitting them here lets the list SAY so, and keeps the two groups
  // in that order even when somebody sorts the array differently by accident.
  const unreadRows = useMemo(() => visible.filter((row) => row.unread > 0), [visible]);
  const readRows = useMemo(() => visible.filter((row) => row.unread === 0), [visible]);

  return (
    <div className="conv-layout">
      <section className="conv-list" aria-label="Job Order conversations">
        <div className="conv-list__head">
          <h2>Conversations</h2>
          <div className="conv-tabs" role="tablist">
            <button
              type="button"
              className={filter === "all" ? "active" : ""}
              onClick={() => setFilter("all")}
              role="tab"
              aria-selected={filter === "all"}
            >
              All
            </button>
            <button
              type="button"
              className={filter === "unread" ? "active" : ""}
              onClick={() => setFilter("unread")}
              role="tab"
              aria-selected={filter === "unread"}
            >
              Unread
            </button>
          </div>
        </div>
        <button type="button" className="conv-btn conv-new" onClick={() => setPicking(true)}>
          Start a follow-up
        </button>
        {stats && stats.raisedFromPortfolio > 0 && (
          <p className="conv-stats">
            ⚡ {stats.raisedFromPortfolio} escalation{stats.raisedFromPortfolio === 1 ? "" : "s"} raised from the
            dashboard in the last {stats.windowDays} days ·{" "}
            {stats.medianHoursToFirstReply !== null
              ? `median first reply ${stats.medianHoursToFirstReply}h`
              : "none answered yet"}
          </p>
        )}
        <input
          className="conv-search"
          type="search"
          placeholder="Filter by Job Order, project…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Filter conversations"
        />

        {loading && <p className="conv-empty">Loading…</p>}
        {error && <p className="conv-empty conv-empty--error">{error}</p>}
        {!loading && !error && visible.length === 0 && (
          <p className="conv-empty">
            No conversations yet. Open a Job Order and start a follow-up — it appears here for everyone in its
            scope, with the whole trail.
          </p>
        )}

        <ul className="conv-rows">
          {/* NEW FIRST, and said out loud. The server already orders unread threads first; the heading
              is what turns an ordering into something a reader can trust at a glance. */}
          {unreadRows.length > 0 && filter === "all" && (
            <li className="conv-group">
              <span>New</span>
              <span className="conv-group__count">{unreadRows.length}</span>
            </li>
          )}
          {unreadRows.map((row) => (
            <ThreadListItem
              key={row.id}
              row={row}
              active={openJobOrder === row.jobOrder.id}
              onOpen={() => setParams({ jobOrder: String(row.jobOrder.id) }, { replace: true })}
            />
          ))}
          {readRows.length > 0 && filter === "all" && unreadRows.length > 0 && (
            <li className="conv-group conv-group--muted">
              <span>Earlier</span>
            </li>
          )}
          {readRows.map((row) => (
            <ThreadListItem
              key={row.id}
              row={row}
              active={openJobOrder === row.jobOrder.id}
              onOpen={() => setParams({ jobOrder: String(row.jobOrder.id) }, { replace: true })}
            />
          ))}
        </ul>
      </section>

      {picking && (
        <JobOrderPicker
          onPick={(id) => {
            setPicking(false);
            setParams({ jobOrder: String(id) }, { replace: true });
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {openJobOrder ? (
        <ThreadDrawer
          jobOrderId={openJobOrder}
          intent={intent}
          // Once the escalation is sent the intent has done its job: the URL goes back to a plain
          // deep link so a refresh cannot re-arm it.
          onConsumeIntent={() => setParams({ jobOrder: String(openJobOrder) }, { replace: true })}
          onClose={() => setParams({}, { replace: true })}
          onChanged={() => void load()}
        />
      ) : (
        <section className="conv-hint">
          <p>Select a Job Order to read its thread and reply.</p>
          <p className="muted">
            Everything you send is addressed to that Job Order&rsquo;s owner, e-mailed once per message, and kept in
            order — newest first — with the numbers frozen at the moment of writing.
          </p>
        </section>
      )}
    </div>
  );
}

/**
 * "Start a follow-up" — a Job Order search, scoped by the API (never by the client). A Job Order that
 * already has a thread shows its message count, so the picker doubles as a way back into a thread.
 */

/**
 * One row of the conversation list.
 *
 * The unread count is a filled marker rather than a quiet pill, because "3 new" on a Job Order is the
 * reason somebody opened this screen at all.
 */
function ThreadListItem(props: { row: ThreadRow; active: boolean; onOpen: () => void }) {
  const { row, active, onOpen } = props;
  return (
    <li>
      <button
        type="button"
        className={`conv-row${active ? " conv-row--open" : ""}${row.unread ? " conv-row--unread" : ""}`}
        onClick={onOpen}
        aria-label={`${row.jobOrder.code} ${row.jobOrder.name}${row.unread ? `, ${row.unread} unread` : ""}`}
      >
        <span className="conv-row__top">
          <strong>{row.jobOrder.code}</strong>
          {row.lastMessage?.kind === "ESCALATION" && !row.lastMessage.acknowledgedAt && (
            <span className="conv-flag conv-flag--escalation">escalation</span>
          )}
          {row.status === "RESOLVED" && <span className="conv-flag">resolved</span>}
          {row.unread > 0 && (
            <span className="conv-flag conv-flag--unread" title={`${row.unread} unread`}>
              {row.unread} new
            </span>
          )}
        </span>
        <span className="conv-row__name">{row.jobOrder.name}</span>
        <span className="conv-row__meta">
          {row.jobOrder.project.code} · {row.jobOrder.section?.name ?? row.jobOrder.department.name}
        </span>
        {row.lastMessage && (
          <span className="conv-row__excerpt">
            <em>{row.lastMessage.authorName}</em> · {row.lastMessage.body.slice(0, 90)}
          </span>
        )}
        <span className="conv-row__time">{formatStamp(row.lastMessageAt)}</span>
      </button>
    </li>
  );
}

function JobOrderPicker(props: { onPick: (jobOrderId: number) => void; onClose: () => void }) {
  const { onPick, onClose } = props;
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<
    Array<{
      id: number;
      code: string;
      name: string;
      status: string;
      project: { code: string; name: string };
      section: { name: string } | null;
      department: { name: string };
      thread: { id: number; messageCount: number } | null;
    }>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const handle = window.setTimeout(() => {
      api<{ jobOrders: typeof rows }>(`/conversations/job-orders${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`)
        .then((data) => alive && setRows(data.jobOrders))
        .catch(() => alive && setRows([]))
        .finally(() => alive && setLoading(false));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(handle);
    };
  }, [query]);

  return (
    <div className="conv-modal" role="dialog" aria-modal="true" aria-label="Choose a Job Order">
      <div className="conv-modal__card">
        <header className="conv-head">
          <div>
            <h2>Start a follow-up</h2>
            <div className="conv-head__sub">Only Job Orders inside your scope are listed.</div>
          </div>
          <button type="button" className="conv-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <input
          className="conv-search conv-search--modal"
          type="search"
          autoFocus
          placeholder="Job Order code or description…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search Job Orders"
        />
        <ul className="conv-rows conv-rows--modal">
          {loading && <li className="conv-empty">Loading…</li>}
          {!loading && rows.length === 0 && <li className="conv-empty">No Job Order matches that.</li>}
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" className="conv-row" onClick={() => onPick(row.id)}>
                <span className="conv-row__top">
                  <strong>{row.code}</strong>
                  {row.thread && row.thread.messageCount > 0 && (
                    <span className="conv-flag">{row.thread.messageCount} messages</span>
                  )}
                </span>
                <span className="conv-row__name">{row.name}</span>
                <span className="conv-row__meta">
                  {row.project.code} · {row.section?.name ?? row.department.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ThreadDrawer(props: {
  jobOrderId: number;
  intent: EscalateIntent;
  onClose: () => void;
  onChanged: () => void;
  onConsumeIntent: () => void;
}) {
  const { jobOrderId, intent, onClose, onChanged, onConsumeIntent } = props;
  const [data, setData] = useState<ConversationResponse | null>(null);
  const [brief, setBrief] = useState<BriefResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [summary, setSummary] = useState<string[] | null>(null);
  // Both assistant blocks are COLLAPSED by default: the trail is the screen, the briefing is on demand.
  // The assistant's text is a DIALOG now: inline, it was squeezed to two lines by the flex column and
  // could not be read at all. One of these at a time, closed with the × or Escape.
  const [assist, setAssist] = useState<"brief" | "summary" | null>(null);
  // Which messages are open. `expanded` above is the full-page toggle — different thing.
  const [openMessages, setOpenMessages] = useState<number[]>([]);
  // The causes recorded on this Job Order. Small and deterministic: the server counts, this renders.
  const [insights, setInsights] = useState<ThreadInsights | null>(null);
  const [hindrances, setHindrances] = useState<Hindrance[]>([]);
  const [dialog, setDialog] = useState<"recovery" | "hindrance" | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [conversation, facts] = await Promise.all([
        api<ConversationResponse>(`/job-orders/${jobOrderId}/conversation`),
        api<BriefResponse>(`/assistant/job-orders/${jobOrderId}/conversation/brief`).catch(() => null),
      ]);
      setData(conversation);
      setBrief(facts);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not open this conversation.");
    }
  }, [jobOrderId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Open the newest message when the thread (or its last message) changes; leave the rest folded.
  // Declared BEFORE the guards below: a hook after an early return would change the hook count.
  const newestMessageId = data?.thread?.messages?.length
    ? data.thread.messages[data.thread.messages.length - 1].id
    : null;
  useEffect(() => {
    if (newestMessageId != null) setOpenMessages([newestMessageId]);
  }, [newestMessageId, jobOrderId]);

  // Causes on this Job Order. Depends on ids and the message count, never on `data` itself, so a
  // re-render that only reorders nothing refetches. Declared here with the other hooks: a hook after
  // the guards below renders once too many and React refuses the whole screen.
  const threadIdForInsights = data?.thread?.id ?? null;
  const messageCountForInsights = data?.thread?.messageCount ?? 0;
  useEffect(() => {
    if (threadIdForInsights == null) {
      setInsights(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const [causes, bars] = await Promise.all([
          api<ThreadInsights>(`/job-orders/${jobOrderId}/conversation/insights`),
          api<{ hindrances: Hindrance[] }>(`/job-orders/${jobOrderId}/hindrances`).catch(() => ({ hindrances: [] })),
        ]);
        if (!cancelled) {
          setInsights(causes);
          setHindrances(bars.hindrances);
        }
      } catch {
        if (!cancelled) setInsights(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobOrderId, threadIdForInsights, messageCountForInsights]);

  if (error) {
    return (
      <aside className="conv-drawer">
        <header className="conv-head">
          <h2>Conversation</h2>
          <button type="button" className="conv-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="conv-empty conv-empty--error">{error}</p>
      </aside>
    );
  }
  if (!data) {
    return (
      <aside className="conv-drawer">
        <p className="conv-empty">Loading…</p>
      </aside>
    );
  }

  const messages = data.thread?.messages ?? [];
  const newestFirst = messages.slice().reverse();
  // Who may close a hindrance or decide a recovery. Ownership of an individual row narrows this further
  // (a PM cannot accept his own offer), which the card and the strip each check.
  // PM is the older name for the authority PROJECT_MANAGER carries; both decide, ADMIN corrects.
  const managerRole = data.me.role === "PM" || data.me.role === "PROJECT_MANAGER" || data.me.role === "ADMIN";
  const canDecide = managerRole;

  // Arriving from a Portfolio row: an escalation is already written, or — if one is still unanswered —
  // the drawer opens in reply mode on that one instead of raising a second.
  const escalation = intent.active ? decideEscalationMode(messages) : null;
  const initialKind = escalation ? (escalation.mode === "REPLY_TO_OPEN" ? "REPLY" : "ESCALATION") : undefined;
  const initialBody =
    escalation?.mode === "NEW" && brief?.numbers
      ? escalationPrefill({ code: data.jobOrder.code, name: data.jobOrder.name }, brief.numbers)
      : undefined;
  const originLabel = intent.active && intent.origin ? ORIGIN_META[intent.origin].label : null;


  const onSummary = async () => {
    if (!data.thread) return;
    try {
      const result = await api<{ bullets: string | null }>(`/assistant/conversations/${data.thread.id}/summary`);
      setSummary(
        result.bullets
          ? result.bullets
              .split(/\n+/)
              .map((line) => line.replace(/^[-•*]\s*/, "").trim())
              .filter(Boolean)
              .slice(0, 4)
          : null
      );
    } catch {
      setSummary(null);
    }
  };


  return (
    <aside className={`conv-drawer${expanded ? " conv-drawer--full" : ""}${collapsed ? " conv-drawer--collapsed" : ""}`}>
      <header className="conv-head">
        <div>
          <div className="conv-head__project">
            {data.jobOrder.project.code} · {data.jobOrder.project.name}
          </div>
          <h2>
            {data.jobOrder.code} · {data.jobOrder.name}
          </h2>
          <div className="conv-head__sub">
            Owner: <strong>{data.owner.name}</strong>
            {data.owner.basis !== "EXPLICIT" && (
              <span className="conv-flag">{data.owner.basis === "NONE" ? "no owner" : "default owner"}</span>
            )}
            {data.thread && <span className={`conv-flag${data.thread.status === "RESOLVED" ? "" : " conv-flag--open"}`}>{data.thread.status.toLowerCase()}</span>}
            {data.thread && data.thread.messageCount > 0 && <span className="conv-count">{data.thread.messageCount} messages</span>}
            {!data.remindersEnabled && (
              <span
                className="conv-flag conv-flag--quiet"
                title="Reminders and automatic escalation are switched off in this server's configuration. A person posting a message still e-mails the thread."
              >
                SLA reminders off
              </span>
            )}
          </div>
        </div>
        <div className="conv-head__actions">
          <button
            type="button"
            className="conv-icon"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expand" : "Collapse"}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "⌄" : "⌃"}
          </button>
          <button
            type="button"
            className="conv-icon"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? "Back to drawer" : "Full page"}
            title={expanded ? "Back to drawer" : "Full page"}
          >
            {expanded ? "⤡" : "⤢"}
          </button>
          <button type="button" className="conv-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
      </header>

      {!collapsed && (
        <>
          {intent.active && (
            <div className={`conv-escalate-banner${escalation?.mode === "REPLY_TO_OPEN" ? " conv-escalate-banner--open" : ""}`}>
              <div>
                <strong>
                  {escalation?.mode === "REPLY_TO_OPEN" ? "This Job Order already has an open escalation" : "Escalating to the Job Owner"}
                </strong>
                <span>
                  {escalation?.mode === "REPLY_TO_OPEN"
                    ? ` #${escalation.seq} from ${formatStamp(escalation.createdAt)} is still unanswered — reply to it below, or raise a second one deliberately.`
                    : ` Raised from ${originLabel ?? "the portfolio"}. The message is written from the row's own figures — check it, then send.`}
                </span>
              </div>
              <div className="conv-escalate-banner__actions">
                <Link to={intent.active ? portfolioReturnHref(intent) : "/portfolio"}>← Back to the portfolio</Link>
                <button type="button" className="conv-icon" onClick={onConsumeIntent} aria-label="Dismiss">
                  ✕
                </button>
              </div>
            </div>
          )}

          {brief && (
            <div className="conv-assist">
              <button
                type="button"
                className="conv-chip conv-chip--action"
                onClick={() => setAssist("brief")}
                aria-haspopup="dialog"
                title={brief.brief}
              >
                ✦ Bottleneck brief
                <em>{brief.assisted ? "AI assisted" : "from the facts"}</em>
              </button>
              {data.thread && messages.length > 1 && (
                <button
                  type="button"
                  className="conv-chip conv-chip--action"
                  onClick={() => {
                    if (!summary) void onSummary();
                    setAssist("summary");
                  }}
                  aria-haspopup="dialog"
                >
                  Where this stands
                </button>
              )}
              <button
                type="button"
                className="conv-chip conv-chip--action"
                onClick={() => setOpenMessages(openMessages.length ? [] : messages.map((message) => message.id))}
              >
                {openMessages.length ? "Collapse all" : "Expand all"}
              </button>
              <span className="conv-assist__hint">
                {messages.length} message{messages.length === 1 ? "" : "s"} · click a row to open it
              </span>
            </div>
          )}

          {dialog === "recovery" && (
            <RecoveryDialog
              jobOrderId={data.jobOrder.id}
              plannedEndDate={data.commitment?.plannedEndDate ?? null}
              onClose={() => setDialog(null)}
              onDone={async () => {
                setDialog(null);
                await load();
                onChanged();
              }}
            />
          )}

          {dialog === "hindrance" && (
            <HindranceDialog
              jobOrderId={data.jobOrder.id}
              onClose={() => setDialog(null)}
              onDone={async () => {
                setDialog(null);
                await load();
                onChanged();
              }}
            />
          )}

          {assist === "brief" && (
            <AssistDialog
              title="Bottleneck brief"
              aside={brief?.assisted ? "drafted by the assistant" : "from the facts"}
              onClose={() => setAssist(null)}
            >
              <p className="conv-dialog__text">{brief?.brief}</p>
              <div className="conv-dialog__facts">
                {(brief?.facts ?? []).map((fact) => (
                  <span key={fact.label} className="conv-chip">
                    <em>{fact.label}</em> {fact.value}
                  </span>
                ))}
              </div>
            </AssistDialog>
          )}

          {assist === "summary" && (
            <AssistDialog
              title="Where this stands"
              aside={summary ? "from the conversation" : "reading the thread…"}
              onClose={() => setAssist(null)}
            >
              {summary ? (
                <ul className="conv-dialog__list">
                  {summary.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="conv-dialog__text">
                  The assistant is reading this thread. If it is switched off, the brief above already carries the
                  facts.
                </p>
              )}
            </AssistDialog>
          )}

          <div className="conv-thread">
            {insights && insights.total > 0 && (
              <div className="conv-insight">
                <div className="conv-insight__head">
                  <span>Delay causes on this Job Order</span>
                  <span className="conv-insight__count">
                    {insights.total} report{insights.total === 1 ? "" : "s"}
                  </span>
                </div>
                <ul>
                  {insights.top.map((reason) => (
                    <li key={reason.code}>
                      <span className={`conv-chip conv-chip--reason${reason.code === insights.top[0].code ? " conv-chip--reason-top" : ""}`}>
                        {reason.label.toLowerCase()}
                      </span>
                      <span className="conv-insight__n">
                        {reason.count} · {reason.share}%
                      </span>
                      <span className="conv-insight__age">avg {reason.averageOpenDays.toFixed(1)} d since reported</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(hindrances.length > 0 || data.thread) && (
              <div className="conv-hind">
                <div className="conv-hind__head">
                  <span>Hindrances on this WBS</span>
                  <button type="button" className="conv-chip conv-chip--action" onClick={() => setDialog("hindrance")}>
                    + Raise
                  </button>
                </div>
                {hindrances.length === 0 ? (
                  <p className="conv-hind__empty muted">Nothing raised. A constraint recorded here is what Central Planning reads.</p>
                ) : (
                  <ul>
                    {hindrances.slice(0, 6).map((row) => (
                      <li key={row.id} className={row.state === "CLOSED" ? "conv-hind__row--closed" : ""}>
                        <span className={`conv-sla ${row.state === "CLOSED" ? "conv-sla--answered" : row.age.stale ? "conv-sla--overdue" : "conv-sla--due_soon"}`}>
                          {row.state === "CLOSED" ? "closed" : row.age.stale ? `${row.age.days}d stale` : `${row.age.days}d`}
                        </span>
                        <span className={`conv-chip conv-chip--reason${row.category === "OTHER" ? "" : ""}`}>{row.category.toLowerCase()}</span>
                        <span className="conv-hind__text">
                          {row.description}
                          <em className="muted">
                            {row.wbsCode ? ` · WBS ${row.wbsCode}` : ""}
                            {row.ownerEmail ? ` · owner ${row.ownerEmail}` : ""}
                            {row.impactDays ? ` · impact ${row.impactDays} d` : ""}
                            {row.state === "CLOSED" && row.closedByName ? ` · closed by ${row.closedByName}` : ""}
                          </em>
                        </span>
                        {row.state === "OPEN" && (data.me.id === row.raisedByUserId || canDecide) && (
                          <button
                            type="button"
                            className="conv-btn conv-btn--ghost conv-btn--tiny"
                            onClick={async () => {
                              await api(`/hindrances/${row.id}/close`, {
                                method: "POST",
                                body: JSON.stringify({ closureNote: "Closed from the Job Order conversation." }),
                              });
                              await load();
                              onChanged();
                            }}
                          >
                            Close
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {newestFirst.length === 0 && (
              <p className="conv-empty">
                No messages yet{data.owner.userId ? ` — the first one is addressed to ${data.owner.name}` : ""}. The trail
                is the Job Order&rsquo;s record, not a chat that disappears.
              </p>
            )}
            {newestFirst.map((message) => {
              const recovery = data.recoveries.find((row) => row.messageId === message.id) ?? null;
              const canDecide =
                data.me.role === "ADMIN" ||
                ((data.me.role === "PM" || data.me.role === "PROJECT_MANAGER") && recovery?.proposedByUserId !== data.me.id);
              return (
              <Fragment key={message.id}>
              <MessageCard
                key={message.id}
                message={message}
                meRole={data.me.role}
                expanded={openMessages.includes(message.id)}
                onToggle={() =>
                  setOpenMessages((current) =>
                    current.includes(message.id)
                      ? current.filter((id) => id !== message.id)
                      : [...current, message.id]
                  )
                }
                onAck={async () => {
                  if (!data.thread) return;
                  await api(`/conversations/${data.thread.id}/messages/${message.id}/acknowledge`, { method: "POST" });
                  await load();
                  onChanged();
                }}
              />
              {recovery && (
                <RecoveryCard
                  recovery={recovery}
                  commitment={data.commitment}
                  canDecide={canDecide}
                  meId={data.me.id}
                  busy={busy}
                  onDecide={async (decision, note) => {
                    await api(`/conversations/recoveries/${recovery.id}/decide`, {
                      method: "POST",
                      body: JSON.stringify({ decision, note: note || undefined }),
                    });
                    await load();
                    onChanged();
                  }}
                />
              )}
              </Fragment>
              );
            })}
          </div>

          <Composer
            key={`${data.thread?.id ?? `new-${jobOrderId}`}-${initialKind ?? "manual"}`}
            data={data}
            initialKind={initialKind}
            initialBody={initialBody}
            origin={intent.active && intent.origin ? intent.origin : null}
            onSent={async () => {
              await load();
              onChanged();
              onConsumeIntent();
            }}
            onProposeRecovery={() => setDialog("recovery")}
          />
        </>
      )}
    </aside>
  );
}

/**
 * One message, collapsed to a single line until somebody opens it.
 *
 * WHY COLLAPSED: a Job Order lives for months and its thread grows with it. Forty fully-open messages
 * is a wall of text that hides the one thing a reader came for — what changed last. The newest message
 * opens by itself; everything else is a scannable row with the kind, who, when and the first line.
 */
function MessageCard(props: {
  message: Message;
  meRole: string;
  expanded: boolean;
  onToggle: () => void;
  onAck: () => Promise<void>;
}) {
  const { message, expanded, onToggle } = props;
  const line = contextLine(message.contextJson);
  const isEscalation = message.kind === "ESCALATION";
  const firstLine = message.body.replace(/\s+/g, " ").trim();

  return (
    <article
      className={`conv-msg${expanded ? " conv-msg--open" : ""}${message.kind === "SYSTEM" ? " conv-msg--system" : ""}`}
    >
      <button
        type="button"
        className="conv-msg__summary"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Open"} message ${message.seq} from ${message.authorName}`}
      >
        <span className="conv-msg__twisty" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
        <span className={KIND_TONE[message.kind] ?? "conv-kind"}>
          {message.kind.toLowerCase().replace(/_/g, " ")}
        </span>
        <strong className="conv-msg__who">{message.authorName}</strong>
        <span className="conv-msg__role">{message.authorRole}</span>
        {message.sla && message.sla.state !== "NONE" && (
          <span
            className={`conv-sla conv-sla--${message.sla.state.toLowerCase()}`}
            title={
              message.sla.state === "ANSWERED"
                ? `Answered ${message.sla.elapsedHours}h after it was asked (target ${message.sla.targetHours}h)`
                : `Target ${message.sla.targetHours}h · ${message.sla.remainingHours < 0 ? `${Math.abs(message.sla.remainingHours)}h late` : `${message.sla.remainingHours}h left`}`
            }
          >
            {message.sla.state === "ANSWERED"
              ? `answered in ${message.sla.elapsedHours}h`
              : message.sla.state === "OVERDUE"
                ? `overdue ${Math.abs(message.sla.remainingHours)}h`
                : message.sla.state === "DUE_SOON"
                  ? `due in ${message.sla.remainingHours}h`
                  : `${message.sla.remainingHours}h left`}
          </span>
        )}
        {message.reasonCode && (
          <span className="conv-chip conv-chip--reason conv-chip--reason-inline" title="Recorded delay cause">
            {reasonLabelOf(message.reasonCode)}
          </span>
        )}
        {!expanded && <span className="conv-msg__excerpt">{firstLine}</span>}
        <span className="conv-seq">#{message.seq}</span>
        <time className="conv-msg__time">{formatStamp(message.createdAt)}</time>
      </button>

      {expanded && (
        <div className="conv-msg__detail">
          <div className="conv-msg__flags">
            {message.source === "MAGIC_LINK" && <span className="conv-flag">via e-mail</span>}
            {message.origin && (
              <span className="conv-flag" title="Raised from the dashboard">
                {ORIGIN_META[message.origin as keyof typeof ORIGIN_META]?.label.replace("Portfolio · ", "") ?? message.origin}
              </span>
            )}
            {message.bodyRevision > 1 && <span className="conv-flag">edited</span>}
            {isEscalation && !message.acknowledgedAt && <span className="conv-flag conv-flag--escalation">unanswered</span>}
            {isEscalation && message.acknowledgedAt && <span className="conv-flag">acknowledged</span>}
          </div>

          {line && <div className="conv-msg__context">{line}</div>}

          <p className="conv-msg__body">{message.body}</p>

          {message.proposalJson && (
            <div className="conv-msg__proposal">
              <div className="brief__title">Proposed change</div>
              <code>{message.proposalJson}</code>
            </div>
          )}

          {(message.attachments ?? []).length > 0 && (
            <ul className="conv-files">
              {(message.attachments ?? []).map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    className="conv-chip conv-chip--file"
                    onClick={() => void downloadAttachment(`/api/conversations/attachments/${file.id}`, file.filename)}
                  >
                    {file.filename} <em>{humanSize(file.sizeBytes)}</em>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {message.commitments.length > 0 && (
            <div className="conv-promises">
              {message.commitments.map((commitment) => (
                <div key={commitment.id} className="conv-promise">
                  <span className="conv-promise__tag">promise</span>
                  due {commitment.dueOn.slice(0, 10)} · {commitment.state.toLowerCase()} · {commitment.text.slice(0, 120)}
                </div>
              ))}
            </div>
          )}

          <footer className="conv-msg__foot">
            {message.recipients.length > 0 && (
              <span className="muted">
                {message.recipients
                  .map((recipient) =>
                    recipient.state === "SENT"
                      ? `emailed ${recipient.email}${recipient.sentAt ? ` ${formatStamp(recipient.sentAt).slice(-5)}` : ""}`
                      : recipient.state === "FAILED"
                        ? `could not email ${recipient.email}`
                        : recipient.state === "EMAIL_OFF"
                          ? "not emailed — e-mail is off"
                          : recipient.state === "MUTED"
                            ? `${recipient.email} muted`
                            : `queued ${recipient.email}`
                  )
                  .join(" · ")}
              </span>
            )}
            {isEscalation && !message.acknowledgedAt && (
              <button type="button" className="conv-btn conv-btn--ghost" onClick={() => void props.onAck()}>
                Acknowledge
              </button>
            )}
          </footer>
        </div>
      )}
    </article>
  );
}

/**
 * The assistant's text as a DIALOG.
 *
 * Inline it was unreadable: a flex column squeezed two paragraphs into two lines with their own
 * scrollbars. A dialog gives the text the width and height to be read, closes on × or Escape, and
 * leaves the trail untouched underneath.
 */
/**
 * Propose a recovery: a revised finish date, the manpower that makes it credible, and why.
 *
 * The manpower plan is deliberately a short list, not a grid: eight lines is what a section head will
 * actually fill in, and a plan nobody fills in is worse than none.
 */
function RecoveryDialog(props: { jobOrderId: number; plannedEndDate: string | null; onClose: () => void; onDone: () => Promise<void> }) {
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState([{ trade: "", headcount: 1, hoursPerDay: 8 }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slip = date && props.plannedEndDate
    ? Math.round((new Date(`${date}T00:00:00Z`).getTime() - new Date(props.plannedEndDate).getTime()) / 86_400_000)
    : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/job-orders/${props.jobOrderId}/conversation/recovery`, {
        method: "POST",
        body: JSON.stringify({
          revisedFinishDate: date,
          note: note || undefined,
          manpowerPlan: lines.filter((line) => line.trade.trim()),
        }),
      });
      await props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not propose the recovery.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AssistDialog title="Propose a recovery" aside="the owner offers; a Project Manager decides" onClose={props.onClose}>
      <div className="conv-form">
        <label>
          <span>Revised finish date</span>
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          {slip != null && (
            <em className={slip > 0 ? "conv-form__slip" : ""}>
              {slip === 0 ? "same day as the plan" : `${slip > 0 ? "+" : ""}${slip} days against the plan`}
            </em>
          )}
        </label>

        <div className="conv-form__plan">
          <span className="conv-form__label">Manpower plan</span>
          {lines.map((line, index) => (
            <div className="conv-form__line" key={index}>
              <input
                placeholder="Trade (fitters, riggers…)"
                value={line.trade}
                onChange={(event) => setLines((current) => current.map((row, i) => (i === index ? { ...row, trade: event.target.value } : row)))}
              />
              <input
                type="number"
                min={1}
                max={500}
                value={line.headcount}
                aria-label="Headcount"
                onChange={(event) => setLines((current) => current.map((row, i) => (i === index ? { ...row, headcount: Number(event.target.value) } : row)))}
              />
              <input
                type="number"
                min={1}
                max={24}
                step={0.5}
                value={line.hoursPerDay}
                aria-label="Hours per day"
                onChange={(event) => setLines((current) => current.map((row, i) => (i === index ? { ...row, hoursPerDay: Number(event.target.value) } : row)))}
              />
              {lines.length > 1 && (
                <button type="button" className="conv-icon conv-icon--tiny" onClick={() => setLines((current) => current.filter((_, i) => i !== index))} aria-label="Remove line">
                  ✕
                </button>
              )}
            </div>
          ))}
          {lines.length < 8 && (
            <button type="button" className="conv-chip conv-chip--action" onClick={() => setLines((current) => [...current, { trade: "", headcount: 1, hoursPerDay: 8 }])}>
              + Add trade
            </button>
          )}
        </div>

        <label>
          <span>Why this date</span>
          <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Material lands 24 Oct; two shifts until 5 Dec." />
        </label>

        {error && <div className="conv-notice">{error}</div>}
        <div className="conv-form__foot">
          <button type="button" className="conv-btn conv-btn--ghost" onClick={props.onClose}>Cancel</button>
          <button type="button" className="conv-btn conv-btn--primary" disabled={busy || !date} onClick={() => void submit()}>
            {busy ? "Proposing…" : "Send proposal"}
          </button>
        </div>
      </div>
    </AssistDialog>
  );
}

/** Raise a hindrance against this Job Order's WBS. */
function HindranceDialog(props: { jobOrderId: number; onClose: () => void; onDone: () => Promise<void> }) {
  const [category, setCategory] = useState("MATERIAL");
  const [description, setDescription] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [impactDays, setImpactDays] = useState<number | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/job-orders/${props.jobOrderId}/hindrances`, {
        method: "POST",
        body: JSON.stringify({
          category,
          description,
          ownerEmail: ownerEmail || undefined,
          impactDays: impactDays === "" ? undefined : Number(impactDays),
        }),
      });
      await props.onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not raise the hindrance.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AssistDialog title="Raise a hindrance" aside="what is holding this work up, and who owns it" onClose={props.onClose}>
      <div className="conv-form">
        <div className="conv-reasons">
          <span className="conv-reasons__label">Cause</span>
          <div className="conv-reasons__chips">
            {["MATERIAL", "MANPOWER", "DRAWING", "PERMIT", "EQUIPMENT", "WEATHER", "CLIENT_HOLD", "REWORK", "OTHER"].map((code) => (
              <button
                key={code}
                type="button"
                className={`conv-chip conv-chip--reason${category === code ? " conv-chip--on" : ""}`}
                aria-pressed={category === code}
                onClick={() => setCategory(code)}
              >
                {REASON_LABELS[code] ?? code.toLowerCase()}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span>What is holding it up</span>
          <textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Vendor spools three weeks late; promise was 14 Oct." />
        </label>
        <div className="conv-form__row">
          <label>
            <span>Owner (optional)</span>
            <input value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="who must clear it" />
          </label>
          <label>
            <span>Impact (days)</span>
            <input type="number" min={0} max={365} value={impactDays} onChange={(event) => setImpactDays(event.target.value === "" ? "" : Number(event.target.value))} />
          </label>
        </div>
        {error && <div className="conv-notice">{error}</div>}
        <div className="conv-form__foot">
          <button type="button" className="conv-btn conv-btn--ghost" onClick={props.onClose}>Cancel</button>
          <button type="button" className="conv-btn conv-btn--primary" disabled={busy || !description.trim()} onClick={() => void submit()}>
            {busy ? "Raising…" : "Raise hindrance"}
          </button>
        </div>
      </div>
    </AssistDialog>
  );
}

/**
 * The recovery offer, as a card under the message that made it.
 *
 * PROPOSED shows the dates and the manpower and asks a PM to decide. ACCEPTED shows the commitment next to
 * the plan it was measured against, and warns when a later upload has moved the plan — the promise is not
 * wrong, the plan simply is no longer the one it replaced.
 */
function RecoveryCard(props: {
  recovery: Recovery;
  commitment: Commitment | null;
  canDecide: boolean;
  meId: number;
  busy: boolean;
  onDecide: (decision: "ACCEPT" | "REJECT", note: string) => Promise<void>;
}) {
  const { recovery } = props;
  const [note, setNote] = useState("");
  const [deciding, setDeciding] = useState(false);
  const plan: Array<{ trade: string; headcount: number; hoursPerDay: number; fromDate: string | null; toDate: string | null }> =
    recovery.manpowerPlanJson ? JSON.parse(recovery.manpowerPlanJson) : [];
  const iso = (value: string | null) => (value ? value.slice(0, 10) : "—");
  const slip = recovery.slipDays;

  const tone =
    recovery.state === "ACCEPTED" ? "conv-recovery--ok" : recovery.state === "REJECTED" ? "conv-recovery--no" : recovery.state === "SUPERSEDED" ? "conv-recovery--gone" : "";

  return (
    <div className={`conv-recovery ${tone}`}>
      <div className="conv-recovery__head">
        <span>
          Recovery {recovery.state.toLowerCase()} · #{recovery.messageId} · {recovery.proposedByName}
        </span>
        {recovery.state === "PROPOSED" && <span className="conv-sla conv-sla--due_soon">awaiting a decision</span>}
        {recovery.state === "ACCEPTED" && <span className="conv-sla conv-sla--answered">accepted</span>}
      </div>

      <div className="conv-recovery__grid">
        <span className="k">Revised finish</span>
        <span>
          <strong>{iso(recovery.revisedFinishDate)}</strong>
          {slip != null && <span className="muted"> {slip >= 0 ? "+" : ""}{slip} days against the plan</span>}
        </span>
        {recovery.state === "ACCEPTED" && (
          <>
            <span className="k">Committed</span>
            <span><strong>{iso(props.commitment?.committedFinishDate ?? recovery.revisedFinishDate)}</strong></span>
            <span className="k">Planned (CLMS)</span>
            <span>{iso(props.commitment?.plannedEndDate ?? null)} <span className="muted">— owned by the plan upload</span></span>
          </>
        )}
        <span className="k">Manpower</span>
        <span>
          {plan.length === 0 ? <span className="muted">none stated</span> : plan.map((line) => `${line.trade} ${line.headcount} × ${line.hoursPerDay}h`).join(" · ")}
        </span>
        {recovery.note && (
          <>
            <span className="k">Note</span>
            <span>{recovery.note}</span>
          </>
        )}
        {recovery.state === "REJECTED" && (
          <>
            <span className="k">Rejected by</span>
            <span>{recovery.decidedByName ?? "—"} {recovery.decisionNote ? `— ${recovery.decisionNote}` : ""}</span>
          </>
        )}
      </div>

      {recovery.planMoved && recovery.state === "ACCEPTED" && (
        <div className="conv-recovery__warn">
          ⚠ The planned date changed after this was accepted. The commitment of {iso(recovery.revisedFinishDate)} still stands.
        </div>
      )}

      {recovery.state === "PROPOSED" && props.canDecide && (
        <div className="conv-recovery__decide">
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Reason (optional, recorded with the decision)"
            aria-label="Decision note"
          />
          <button
            type="button"
            className="conv-btn conv-btn--ghost"
            disabled={deciding || props.busy}
            onClick={async () => {
              setDeciding(true);
              try {
                await props.onDecide("REJECT", note);
              } finally {
                setDeciding(false);
              }
            }}
          >
            Reject
          </button>
          <button
            type="button"
            className="conv-btn conv-btn--primary"
            disabled={deciding || props.busy}
            onClick={async () => {
              setDeciding(true);
              try {
                await props.onDecide("ACCEPT", note);
              } finally {
                setDeciding(false);
              }
            }}
          >
            {deciding ? "Saving…" : "Accept revision"}
          </button>
        </div>
      )}

      {recovery.state === "PROPOSED" && !props.canDecide && (
        <div className="conv-recovery__foot muted">
          A Project Manager decides this. {props.meId === recovery.proposedByUserId ? "You proposed it, so somebody else must accept it." : ""}
        </div>
      )}
    </div>
  );
}

function AssistDialog(props: {
  title: string;
  aside: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return createPortal(
    <div className="conv-overlay" role="presentation" onClick={props.onClose}>
      <div
        className="conv-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="conv-dialog__head">
          <div>
            <div className="conv-dialog__title">{props.title}</div>
            <div className="conv-dialog__aside">{props.aside}</div>
          </div>
          <button type="button" className="conv-icon" onClick={props.onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="conv-dialog__body">{props.children}</div>
      </div>
    </div>,
    document.body
  );
}

function Composer(props: {
  data: ConversationResponse;
  /** Preselected when the drawer was opened from a Portfolio row. */
  initialKind?: string;
  /** The escalation text built from the row's own figures. */
  initialBody?: string;
  /** Recorded on the message: which Portfolio tab it was raised from. */
  origin?: string | null;
  onSent: () => Promise<void>;
  /** Opens the recovery dialog; only offered to the owner and PMs. */
  onProposeRecovery?: () => void;
}) {
  const { data, onSent, initialKind, initialBody, origin, onProposeRecovery } = props;
  const startingKind =
    initialKind && data.canPostKinds.includes(initialKind)
      ? initialKind
      : data.canPostKinds.includes("FOLLOW_UP")
        ? "FOLLOW_UP"
        : data.canPostKinds[0] ?? "REPLY";
  const [kind, setKind] = useState(startingKind);
  // The causes come from the server (the table is the source of truth, not a constant in this file).
  const [reasons, setReasons] = useState<ReasonOption[]>([]);
  const [reasonCode, setReasonCode] = useState<string>("");
  // A cause belongs to the person accountable for the work, or to a PM speaking for him. The server
  // enforces this too; hiding the chips here is courtesy, not security.
  const mayStampReason =
    data.owner.userId != null
      ? data.owner.userId === data.me.id || data.me.role === "PM" || data.me.role === "PROJECT_MANAGER" || data.me.role === "ADMIN"
      : data.me.role === "PM" || data.me.role === "PROJECT_MANAGER" || data.me.role === "ADMIN";
  const [body, setBody] = useState(initialBody ?? "");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<Array<{ id: number; filename: string; sizeBytes: number }>>([]);
  const [uploading, setUploading] = useState(0);
  const [emailOwner, setEmailOwner] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftLabel, setDraftLabel] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = async (list: FileList | null) => {
    if (!list) return;
    const room = 5 - files.length;
    const chosen = Array.from(list).slice(0, Math.max(0, room));
    setUploading(chosen.length);
    for (const file of chosen) {
      try {
        const token = getToken();
        const response = await fetch(
          `/api/job-orders/${data.jobOrder.id}/conversation/attachments?filename=${encodeURIComponent(file.name)}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/octet-stream",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: file,
          }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          setNotice(payload?.error ?? `${file.name} could not be attached.`);
        } else if (payload?.attachment) {
          setFiles((current) => [...current, payload.attachment]);
        }
      } catch {
        setNotice(`${file.name} could not be attached.`);
      } finally {
        setUploading((count) => Math.max(0, count - 1));
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  useEffect(() => {
    if (!mayStampReason) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api<{ reasons: ReasonOption[] }>("/conversations/reasons");
        if (!cancelled) setReasons(result.reasons);
      } catch {
        // A missing list is not worth an error banner: the reply still sends, just without a cause.
        if (!cancelled) setReasons([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mayStampReason]);

  const draft = async () => {
    setDrafting(true);
    setNotice(null);
    try {
      // The assistant's routes live under /assistant, like the brief. Calling the bare job-order path
      // returned 404 "Not Found" — a route that never existed, not a model failure.
      const result = await api<{ draft: string; assisted: boolean }>(`/assistant/job-orders/${data.jobOrder.id}/conversation/draft`, {
        method: "POST",
        body: JSON.stringify({ kind }),
      });
      setBody(result.draft);
      setDraftLabel(result.assisted ? "Draft — review before sending" : "Template — review before sending");
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "The assistant is not available.");
    } finally {
      setDrafting(false);
    }
  };

  const send = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await api<{ message: { seq: number; deliveries: string[] } }>(
        `/job-orders/${data.jobOrder.id}/conversation/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            kind,
            body,
            emailOwner,
            reasonCode: reasonCode || undefined,
            origin: origin ?? undefined,
            attachmentIds: files.map((file) => file.id),
          }),
        }
      );
      const deliveries = result.message.deliveries.filter((line) => !line.startsWith("queued"));
      setNotice(`#${result.message.seq} sent.${deliveries.length ? ` ${deliveries.join(" · ")}` : ""}`);
      setBody("");
      setFiles([]);
      setDraftLabel(null);
      await onSent();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Could not send.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conv-composer">
      {draftLabel && <div className="conv-draft-label">{draftLabel}</div>}
      <div className="conv-composer__row">
        <select value={kind} onChange={(event) => setKind(event.target.value)} aria-label="Message type">
          {KIND_OPTIONS.filter((option) => data.canPostKinds.includes(option.value)).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="conv-as">
          Reply as <strong>{data.me.name}</strong> ({data.me.role})
        </span>
      </div>

      {mayStampReason && reasons.length > 0 && (
        <div className="conv-reasons" role="group" aria-label="Cause of the delay">
          <span className="conv-reasons__label">
            Why is it delayed? <em>optional · never blocks sending</em>
          </span>
          <div className="conv-reasons__chips">
            {reasons.map((reason) => (
              <button
                key={reason.code}
                type="button"
                className={`conv-chip conv-chip--reason${reasonCode === reason.code ? " conv-chip--on" : ""}`}
                aria-pressed={reasonCode === reason.code}
                onClick={() => setReasonCode((current) => (current === reason.code ? "" : reason.code))}
                title={reasonCode === reason.code ? "Click again to clear" : reason.label}
              >
                {reason.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void send();
        }}
        placeholder="What do you need, from whom, by when?"
        rows={3}
        maxLength={4000}
        aria-label="Message"
      />

      {files.length > 0 && (
        <ul className="conv-files conv-files--compose">
          {files.map((file) => (
            <li key={file.id}>
              <span className="conv-chip conv-chip--file">
                {file.filename} <em>{humanSize(file.sizeBytes)}</em>
                <button
                  type="button"
                  className="conv-icon conv-icon--tiny"
                  onClick={() => setFiles((current) => current.filter((item) => item.id !== file.id))}
                  aria-label={`Remove ${file.filename}`}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="conv-composer__foot">
        <div className="conv-composer__left">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            accept=".pdf,.png,.jpg,.jpeg,.webp,.xls,.xlsx,.csv,.doc,.docx,.ppt,.pptx,.txt,.zip"
            onChange={(event) => void upload(event.target.files)}
          />
          <button
            type="button"
            className="conv-btn conv-btn--ghost"
            onClick={() => fileInput.current?.click()}
            disabled={files.length >= 5 || uploading > 0}
            title="Attach documents (up to 5, 10 MB each)"
          >
            {uploading > 0 ? `Uploading ${uploading}…` : "Attach"}
          </button>
          <button type="button" className="conv-btn conv-btn--ghost" onClick={() => void draft()} disabled={drafting}>
            {drafting ? "Drafting…" : "Draft with assistant"}
          </button>
          {onProposeRecovery &&
            (data.owner.userId === data.me.id ||
              data.me.role === "PM" ||
              data.me.role === "PROJECT_MANAGER" ||
              data.me.role === "ADMIN") && (
              <button type="button" className="conv-btn conv-btn--ghost" onClick={onProposeRecovery}>
                Propose recovery
              </button>
            )}
          {data.owner.email && (
            <label className="conv-check">
              <input type="checkbox" checked={emailOwner} onChange={(event) => setEmailOwner(event.target.checked)} />
              e-mail {data.owner.name}
            </label>
          )}
          {!data.emailEnabled && <span className="conv-flag">e-mail is switched off on this server</span>}
        </div>
        <button type="button" className="conv-btn" onClick={() => void send()} disabled={busy || !body.trim()}>
          {busy ? "Sending…" : "Send reply"}
        </button>
      </div>
      {notice && <div className="conv-notice">{notice}</div>}
      <div className="conv-hintline">
        Ctrl+Enter sends. The thread keeps the numbers as they were when each message was written.
        <Link to="/portfolio"> Open the portfolio</Link>
      </div>
    </div>
  );
}
