/**
 * Conversations — one thread per Job Order, newest first, with the composer that keeps the trail
 * moving and the documents that make a follow-up answerable.
 *
 * Theme: every colour is a token from styles/themes.css (`--bg-elevated`, `--border`, `--text`,
 * `--text-muted`, `--primary`, `--warning`, `--danger`). There is not one literal hex value in this
 * file, so Nocturne, Harbor and every other theme paint it correctly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  emailEnabled: boolean;
  me: { id: number; name: string; role: string; email: string };
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
          {visible.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className={`conv-row${openJobOrder === row.jobOrder.id ? " conv-row--open" : ""}${row.unread ? " conv-row--unread" : ""}`}
                onClick={() => setParams({ jobOrder: String(row.jobOrder.id) }, { replace: true })}
              >
                <span className="conv-row__top">
                  <strong>{row.jobOrder.code}</strong>
                  {row.lastMessage?.kind === "ESCALATION" && !row.lastMessage.acknowledgedAt && (
                    <span className="conv-flag conv-flag--escalation">escalation</span>
                  )}
                  {row.status === "RESOLVED" && <span className="conv-flag">resolved</span>}
                  {row.unread > 0 && <span className="conv-flag conv-flag--unread">{row.unread}</span>}
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
  const [showBrief, setShowBrief] = useState(false);
  const [showSummary, setShowSummary] = useState(false);

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
                className={`conv-chip conv-chip--action${showBrief ? " is-open" : ""}`}
                onClick={() => setShowBrief((value) => !value)}
                aria-expanded={showBrief}
                title={brief.brief}
              >
                ✦ Bottleneck brief
                <em>{brief.assisted ? "AI assisted" : "from the facts"}</em>
              </button>
              {data.thread && messages.length > 1 && (
                <button
                  type="button"
                  className={`conv-chip conv-chip--action${showSummary ? " is-open" : ""}`}
                  onClick={() => {
                    if (!showSummary && !summary) void onSummary();
                    setShowSummary((value) => !value);
                  }}
                  aria-expanded={showSummary}
                >
                  Where this stands
                </button>
              )}
              <span className="conv-assist__hint">the trail is the record — the briefing is on demand</span>
            </div>
          )}

          {showSummary && summary && (
            <div className="brief brief--summary">
              <div className="brief__title">Where this stands</div>
              <ul>
                {summary.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}

          {showBrief && (
            <div className="brief">
              <div className="brief__title">Bottleneck brief</div>
              <p className="brief__text">{brief?.brief}</p>
              <div className="brief__facts">
                {(brief?.facts ?? []).map((fact) => (
                  <span key={fact.label} className="conv-chip">
                    <em>{fact.label}</em> {fact.value}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="conv-thread">
            {newestFirst.length === 0 && (
              <p className="conv-empty">
                No messages yet{data.owner.userId ? ` — the first one is addressed to ${data.owner.name}` : ""}. The trail
                is the Job Order&rsquo;s record, not a chat that disappears.
              </p>
            )}
            {newestFirst.map((message) => (
              <MessageCard key={message.id} message={message} meRole={data.me.role} onAck={async () => {
                if (!data.thread) return;
                await api(`/conversations/${data.thread.id}/messages/${message.id}/acknowledge`, { method: "POST" });
                await load();
                onChanged();
              }} />
            ))}
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
          />
        </>
      )}
    </aside>
  );
}

function MessageCard(props: { message: Message; meRole: string; onAck: () => Promise<void> }) {
  const { message } = props;
  const line = contextLine(message.contextJson);
  const isEscalation = message.kind === "ESCALATION";

  return (
    <article className={`conv-msg${message.kind === "SYSTEM" ? " conv-msg--system" : ""}`}>
      <header className="conv-msg__head">
        <span className={KIND_TONE[message.kind] ?? "conv-kind"}>{message.kind.toLowerCase().replace(/_/g, " ")}</span>
        <strong>{message.authorName}</strong>
        <span className="muted">{message.authorRole}</span>
        <span className="conv-seq">#{message.seq}</span>
        <time className="muted">{formatStamp(message.createdAt)}</time>
        {message.source === "MAGIC_LINK" && <span className="conv-flag">via e-mail</span>}
        {message.origin && (
          <span className="conv-flag" title="Raised from the dashboard">
            {ORIGIN_META[message.origin as keyof typeof ORIGIN_META]?.label.replace("Portfolio · ", "") ?? message.origin}
          </span>
        )}
        {message.bodyRevision > 1 && <span className="conv-flag">edited</span>}
      </header>

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
        {isEscalation && (
          message.acknowledgedAt ? (
            <span className="conv-flag">acknowledged</span>
          ) : (
            <button type="button" className="conv-btn conv-btn--ghost" onClick={() => void props.onAck()}>
              Acknowledge
            </button>
          )
        )}
      </footer>
    </article>
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
}) {
  const { data, onSent, initialKind, initialBody, origin } = props;
  const startingKind =
    initialKind && data.canPostKinds.includes(initialKind)
      ? initialKind
      : data.canPostKinds.includes("FOLLOW_UP")
        ? "FOLLOW_UP"
        : data.canPostKinds[0] ?? "REPLY";
  const [kind, setKind] = useState(startingKind);
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

      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void send();
        }}
        placeholder="What do you need, from whom, by when?"
        rows={5}
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
