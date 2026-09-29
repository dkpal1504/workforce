import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { syncBadge, lastTriggerNote, formatRefreshedAt, BADGE_TIMEZONE, type SyncStatus } from "./syncBadge";

/**
 * Admin-only "Last refreshed" badge.
 *
 * WHY it exists: "is the LabourWorks refresh happening on time?" could only be answered by
 * running SQL against audit_log, so nobody checked. The data was already durable — the run
 * records added by SYNC_SCHEDULED_RUN / SYNC_ONE_SHOT_RUN / ADMIN_BADGEVIEW_SYNC and
 * Employee.lastSyncedAt — but it had no view. This is that view.
 *
 * Two deliberate choices:
 *  - the badge NEVER decides freshness itself. The API returns the state and the threshold it
 *    was judged against (derived from the configured cron), so the badge and the server cannot
 *    disagree about what "overdue" means, and the threshold tracks the schedule instead of a
 *    hardcoded 24 hours.
 *  - every rendered time NAMES its timezone (IST). These timestamps are stored UTC while the
 *    operator reads IST, and a bare "00:30" is exactly what makes a 06:00 run look like it
 *    never happened. That confusion is the reason this badge exists.
 *
 * The full detail is in the tooltip and behind the click, but the headline shows the time —
 * that is the one thing the operator asked for.
 */

/** Refresh the badge on this cadence; it is a freshness indicator, so it must not go stale. */
const POLL_MS = 60_000;

export function SyncStatusBadge() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await api<SyncStatus>("/admin/sync/status");
      if (mounted.current) {
        setStatus(data);
        setFailed(false);
      }
    } catch {
      // A badge must never break the shell it sits in. Say "unavailable" and stop.
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load]);

  if (failed || !status) return null;

  const badge = syncBadge(status, BADGE_TIMEZONE);
  const detail = `${badge.detail}\n${lastTriggerNote(status)}`;

  return (
    <div className={`sync-badge sync-badge--${badge.tone} ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="sync-badge__button"
        title={detail}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="sync-badge__dot" aria-hidden />
        <span className="sync-badge__text">{badge.headline}</span>
      </button>
      {open && (
        <div className="sync-badge__popover" role="status">
          <p className="sync-badge__detail">{badge.detail}</p>
          <p className="sync-badge__detail">{lastTriggerNote(status)}</p>
          {status.recentRuns.length > 0 && (
            <>
              <p className="sync-badge__label">Recent runs</p>
              <ul className="sync-badge__runs">
                {status.recentRuns.map((run) => (
                  <li key={`${run.action}-${run.at}`}>
                    <span className={`sync-badge__run-state sync-badge__run-state--${run.ok === false ? "bad" : "ok"}`}>
                      {run.ok === false ? "failed" : run.ok === true ? "ok" : "ended"}
                    </span>{" "}
                    {run.trigger}
                    {/* Named timezone here too: this list sits under text that already says
                        IST, and a bare browser-local clock next to it reads as a mismatch. */}
                    {formatRefreshedAt(run.at) ? ` · ${formatRefreshedAt(run.at)}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className="sync-badge__meta">
            Schedule: {status.cron}
            {status.schedule ? ` · expected within ${status.schedule.overdueAfterHours}h` : " · cadence not recognised"}
            {status.openExceptions > 0 ? ` · ${status.openExceptions} unimported row(s)` : ""}
          </p>
          {!status.enabled && (
            <p className="sync-badge__meta">
              The scheduled refresh is off. Load the roster with a one-shot run, or set BADGEVIEW_SYNC_ENABLED=true.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
