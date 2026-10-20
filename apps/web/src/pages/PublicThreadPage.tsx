/**
 * The page the e-mail button opens: no login, one signed link, one Job Order's whole trail.
 *
 * It shows the conversation newest-first and lets the addressed person reply. It cannot list threads,
 * cannot open another Job Order, and the token expires in 30 days. Attachments download through the
 * same token, so a recipient can read the drawing that the message is about.
 *
 * Theme: token colours only, so the page follows the same palette as the app it belongs to.
 */

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { formatStamp } from "./formatDate";

type PublicMessage = {
  id: number;
  seq: number;
  kind: string;
  authorName: string;
  authorRole: string;
  body: string;
  createdAt: string;
  contextJson: string | null;
  acknowledgedAt: string | null;
  attachments: Array<{ id: number; filename: string; sizeBytes: number }>;
};

type PublicThread = {
  thread: {
    id: number;
    status: string;
    messageCount: number;
    jobOrder: {
      code: string;
      name: string;
      project: { code: string; name: string };
      projectWbs: { wbsCode: string };
      network: { code: string } | null;
      department: { name: string };
      section: { name: string } | null;
    };
    messages: PublicMessage[];
  };
  me: { email: string; name: string; role: string };
  expiresAt: string;
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PublicThreadPage() {
  const { token = "" } = useParams();
  const [data, setData] = useState<PublicThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/thread/${encodeURIComponent(token)}`)
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!alive) return;
        if (!response.ok) setError(payload?.error ?? "This link cannot be opened.");
        else setData(payload as PublicThread);
      })
      .catch(() => alive && setError("This link cannot be opened."));
    return () => {
      alive = false;
    };
  }, [token]);

  const send = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/thread/${encodeURIComponent(token)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(payload?.error ?? "Your reply could not be sent.");
      } else {
        setSent(`Reply #${payload.seq} sent. It is on the record and the others have been e-mailed.`);
        setBody("");
        const refreshed = await fetch(`/api/thread/${encodeURIComponent(token)}`).then((r) => r.json());
        setData(refreshed as PublicThread);
      }
    } catch {
      setError("Your reply could not be sent.");
    } finally {
      setBusy(false);
    }
  };

  if (error && !data) {
    return (
      <main className="public-thread">
        <div className="public-thread__card">
          <h1>This link cannot be opened</h1>
          <p className="muted">{error}</p>
          <p className="muted">
            Ask the sender for a new message — a link is valid for 30 days and only for the Job Order it was sent
            from.
          </p>
        </div>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="public-thread">
        <div className="public-thread__card">
          <p className="muted">Opening the conversation…</p>
        </div>
      </main>
    );
  }

  const { thread, me } = data;
  const newestFirst = thread.messages.slice().reverse();

  return (
    <main className="public-thread">
      <div className="public-thread__card">
        <header className="public-thread__head">
          <div className="conv-head__project">
            {thread.jobOrder.project.code} · {thread.jobOrder.project.name}
          </div>
          <h1>
            {thread.jobOrder.code} · {thread.jobOrder.name}
          </h1>
          <div className="conv-head__sub">
            {thread.jobOrder.projectWbs.wbsCode}
            {thread.jobOrder.network ? ` · ${thread.jobOrder.network.code}` : ""} ·{" "}
            {thread.jobOrder.section?.name ?? thread.jobOrder.department.name}
            <span className={`conv-flag${thread.status === "OPEN" ? " conv-flag--open" : ""}`}>{thread.status.toLowerCase()}</span>
          </div>
          <p className="muted public-thread__who">
            You are replying as <strong>{me.name}</strong> ({me.role}) · {me.email}
          </p>
        </header>

        <div className="conv-thread">
          {newestFirst.map((message) => (
            <article key={message.id} className={`conv-msg${message.kind === "SYSTEM" ? " conv-msg--system" : ""}`}>
              <header className="conv-msg__head">
                <span className="conv-kind">{message.kind.toLowerCase().replace(/_/g, " ")}</span>
                <strong>{message.authorName}</strong>
                <span className="muted">{message.authorRole}</span>
                <span className="conv-seq">#{message.seq}</span>
                <time className="muted">{formatStamp(message.createdAt)}</time>
              </header>
              <p className="conv-msg__body">{message.body}</p>
              {message.attachments.length > 0 && (
                <ul className="conv-files">
                  {message.attachments.map((file) => (
                    <li key={file.id}>
                      <a
                        className="conv-chip conv-chip--file"
                        href={`/api/thread/${encodeURIComponent(token)}/attachments/${file.id}`}
                      >
                        {file.filename} <em>{humanSize(file.sizeBytes)}</em>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          ))}
        </div>

        <div className="conv-composer">
          <div className="conv-composer__row">
            <span className="conv-as">
              Reply as <strong>{me.name}</strong> ({me.role})
            </span>
          </div>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={5}
            maxLength={4000}
            placeholder="Reply to this thread…"
            aria-label="Reply"
          />
          {error && <div className="conv-notice conv-notice--error">{error}</div>}
          {sent && <div className="conv-notice">{sent}</div>}
          <div className="conv-composer__foot">
            <span className="conv-hintline">Your reply is added to the Job Order&rsquo;s record and e-mailed to the others.</span>
            <button type="button" className="conv-btn" onClick={() => void send()} disabled={busy || !body.trim()}>
              {busy ? "Sending…" : "Send reply"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
