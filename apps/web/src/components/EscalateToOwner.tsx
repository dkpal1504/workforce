/**
 * "Do you want to escalate to the Job Owner?" — the affordance that turns a Portfolio row into a
 * conversation.
 *
 * WHY A COMPONENT AND NOT A CELL: the popover has to appear when the pointer is anywhere on the ROW, so
 * the row owns the hover and the action cell owns the geometry. Two shells are exported: one for a table
 * whose row is a Job Order (Needs push, Schedule & delays) and one for a Project-structure node, which
 * owns several Job Orders and therefore has to offer them.
 *
 * THE CLICK IS THE ONLY THING THAT MOVES THE PAGE. Hovering shows a popover; nothing else navigates.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { claimPopover, closeAllPopovers, isPopoverOpen, releasePopover, subscribePopover } from "./hoverPopoverStore";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import {
  buildEscalateHref,
  escalationPrefill,
  type PortfolioOrigin,
} from "../pages/escalateLink";

type OwnerResponse = {
  owner: { userId: number | null; name: string; basis: string; email: string | null };
  deliveryNote: string | null;
};

/** One read per Job Order per session: the popover must not hit the API on every hover. */
const ownerCache = new Map<number, OwnerResponse>();

const BASIS_LABEL: Record<string, string> = {
  EXPLICIT: "named owner",
  SECTION_HOD: "Section HOD",
  DEPARTMENT_HOD: "Department HOD",
  NONE: "no owner set",
};

type JobOrderFacts = {
  id: number;
  code: string;
  name: string;
  project?: { id: number } | null;
  burnPct?: number | null;
  hoursBand?: string | null;
  scheduleBand?: string | null;
  daysToEnd?: number | null;
  qtyCompletePct?: number | null;
};


/**
 * Bind one row to the ONE popover slot.
 *
 * `open` is derived from the store, so a row cannot stay open after another row claims the slot: the
 * store notifies every subscriber and the displaced row re-renders closed in the same tick. That is the
 * difference between one popover and a cascade.
 */
function useSinglePopover(key: string): boolean {
  const [open, setOpen] = useState(() => isPopoverOpen(key));
  useEffect(() => {
    setOpen(isPopoverOpen(key));
    return subscribePopover((active) => setOpen(active === key));
  }, [key]);
  // Leaving the screen must not leave a popover behind.
  useEffect(() => () => releasePopover(key), [key]);
  return open;
}

type PopoverAnchor = { top: number; left: number } | null;

/** Shared popover shell, so the two row kinds cannot drift apart visually. */
function Popover(props: {
  anchor: PopoverAnchor;
  title: string;
  subtitle: string;
  facts: string;
  onEnter: () => void;
  onLeave: () => void;
  children: React.ReactNode;
}) {
  if (!props.anchor) return null;
  return createPortal(
    <div
      className="pf-escalate-pop"
      style={{ top: props.anchor.top, left: props.anchor.left }}
      role="dialog"
      aria-label={props.title}
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
    >
      <div className="pf-escalate-pop__title">{props.title}</div>
      <div className="pf-escalate-pop__who">{props.subtitle}</div>
      <div className="pf-escalate-pop__facts">{props.facts}</div>
      <div className="pf-escalate-pop__actions">{props.children}</div>
    </div>,
    document.body
  );
}

/**
 * The row shell for a table whose row IS a Job Order.
 *
 * `children` are the existing cells, unchanged, so adding the affordance cannot alter a table's
 * columns or its numbers — it appends one 30px cell.
 */
export function EscalatableRow(props: {
  jobOrder: JobOrderFacts;
  origin: PortfolioOrigin;
  children: React.ReactNode;
  className?: string;
}) {
  const { jobOrder, origin, children, className } = props;
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverKey = `jo:${jobOrder.id}`;
  const open = useSinglePopover(popoverKey);
  const [owner, setOwner] = useState<OwnerResponse | null>(ownerCache.get(jobOrder.id) ?? null);
  const [anchor, setAnchor] = useState<PopoverAnchor>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const dwellTimer = useRef<number | undefined>(undefined);

  const facts = escalationPrefill(jobOrder, jobOrder);
  const href = buildEscalateHref({ jobOrderId: jobOrder.id, origin, projectId: jobOrder.project?.id ?? null });

  const openNow = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // To the LEFT of the action column, so the row's own numbers stay readable. Vertically the
    // popover sits ON the row; it flips above the row only when there is no room beneath it, rather
    // than being clamped to the bottom of the window where it would cover unrelated content.
    const height = 168;
    const top = rect.top + height > window.innerHeight - 8 ? Math.max(8, rect.top - height + 28) : Math.max(8, rect.top - 6);
    const left = Math.max(8, rect.left - 286);
    setAnchor({ top, left });
    // Exclusive: taking the slot closes whatever row held it, before this one paints.
    claimPopover(popoverKey);
  }, [popoverKey]);

  // FAST, but not accidental: a 120 ms dwell is enough to feel immediate while still swallowing the
  // pointer sweeping down a long table. The previous popover is closed by the claim, never by a timer.
  const show = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(dwellTimer.current);
    dwellTimer.current = window.setTimeout(openNow, 120);
  }, [openNow]);

  const scheduleHide = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => releasePopover(popoverKey), 120);
  }, [popoverKey]);

  useEffect(() => {
    if (!open || owner) return;
    let alive = true;
    api<OwnerResponse>(`/job-orders/${jobOrder.id}/conversation/owner`)
      .then((data) => {
        ownerCache.set(jobOrder.id, data);
        if (alive) setOwner(data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, owner, jobOrder.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAllPopovers();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <tr className={className} onMouseEnter={show} onMouseLeave={scheduleHide}>
      {children}
      <td className="pf-actions">
        <button
          ref={buttonRef}
          type="button"
          className={`pf-escalate-btn${open ? " is-open" : ""}`}
          onFocus={show}
          onBlur={scheduleHide}
          onClick={() => navigate(href)}
          aria-label={`Escalate ${jobOrder.code} to its owner`}
          title="Escalate to Job Owner"
        >
          ⚡
        </button>
        <Popover
          anchor={open ? anchor : null}
          title="Escalate to Job Owner?"
          subtitle={
            owner
              ? `${owner.owner.name} · ${BASIS_LABEL[owner.owner.basis] ?? owner.owner.basis}${owner.deliveryNote ? ` · ${owner.deliveryNote}` : ""}`
              : "the Job Order's owner"
          }
          facts={facts}
          onEnter={openNow}
          onLeave={scheduleHide}
        >
          <button type="button" className="conv-btn" onClick={() => navigate(href)}>
            Escalate
          </button>
        </Popover>
      </td>
    </tr>
  );
}

type NodeJobOrder = {
  id: number;
  code: string;
  name: string;
  thread: { id: number; messageCount: number } | null;
};

/**
 * The row shell for a Project-structure node (Project / WBS / Network).
 *
 * A node is not one Job Order, so the popover asks the API which Job Orders sit under it and lists them
 * worst-first. A node with exactly one goes straight through — the same one-click behaviour as a
 * job-order row, without a pointless list of one.
 */
export function EscalatableNodeRow(props: {
  node: { id: number; code: string; name: string | null; jobOrderCount: number };
  scope: { projectId: number; wbsId?: number; networkId?: number };
  origin: PortfolioOrigin;
  children: React.ReactNode;
  className?: string;
}) {
  const { node, scope, origin, children, className } = props;
  const navigate = useNavigate();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverKey = `node:${scope.projectId}:${scope.wbsId ?? 0}:${scope.networkId ?? 0}:${node.id}`;
  const open = useSinglePopover(popoverKey);
  const [rows, setRows] = useState<NodeJobOrder[] | null>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const dwellTimer = useRef<number | undefined>(undefined);

  const query = new URLSearchParams({ projectId: String(scope.projectId) });
  if (scope.wbsId) query.set("wbsId", String(scope.wbsId));
  if (scope.networkId) query.set("networkId", String(scope.networkId));

  const openNow = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const height = 190;
    setAnchor({
      top: rect.top + height > window.innerHeight - 8 ? Math.max(8, rect.top - height + 28) : Math.max(8, rect.top - 6),
      left: Math.max(8, rect.left - 300),
    });
    claimPopover(popoverKey);
  }, [popoverKey]);

  const show = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(dwellTimer.current);
    dwellTimer.current = window.setTimeout(openNow, 120);
  }, [openNow]);

  const scheduleHide = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => releasePopover(popoverKey), 120);
  }, [popoverKey]);

  useEffect(() => {
    if (!open || rows) return;
    let alive = true;
    api<{ jobOrders: NodeJobOrder[] }>(`/conversations/job-orders?${query.toString()}`)
      .then((data) => alive && setRows(data.jobOrders))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [open, rows, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeAllPopovers();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const single = rows?.length === 1 ? rows[0] : null;
  const facts = single
    ? `${single.code} · ${single.name}`
    : `${node.jobOrderCount} job order${node.jobOrderCount === 1 ? "" : "s"} under this node`;

  return (
    <tr className={className} onMouseEnter={show} onMouseLeave={scheduleHide}>
      {children}
      <td className="pf-actions">
        <button
          ref={buttonRef}
          type="button"
          className={`pf-escalate-btn${open ? " is-open" : ""}`}
          onFocus={show}
          onBlur={scheduleHide}
          disabled={node.jobOrderCount === 0}
          onClick={() => {
            if (single) navigate(buildEscalateHref({ jobOrderId: single.id, origin, projectId: scope.projectId }));
            else show();
          }}
          aria-label={`Escalate a job order under ${node.code}`}
          title="Escalate to Job Owner"
        >
          ⚡
        </button>
        <Popover
          anchor={open ? anchor : null}
          title="Escalate to Job Owner?"
          subtitle={node.name ? `${node.code} · ${node.name}` : node.code}
          facts={facts}
          onEnter={openNow}
          onLeave={scheduleHide}
        >
          {rows === null && <span className="pf-escalate-pop__muted">Loading job orders…</span>}
          {rows?.length === 0 && <span className="pf-escalate-pop__muted">No job order is in your scope here.</span>}
          {single && (
            <button
              type="button"
              className="conv-btn"
              onClick={() => navigate(buildEscalateHref({ jobOrderId: single.id, origin, projectId: scope.projectId }))}
            >
              Escalate
            </button>
          )}
          {rows && rows.length > 1 && (
            <ul className="pf-escalate-pop__list">
              {rows.slice(0, 6).map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className="pf-escalate-pop__item"
                    onClick={() => navigate(buildEscalateHref({ jobOrderId: row.id, origin, projectId: scope.projectId }))}
                  >
                    <strong>{row.code}</strong>
                    <span>{row.name}</span>
                    {row.thread && row.thread.messageCount > 0 && <em>{row.thread.messageCount} msg</em>}
                  </button>
                </li>
              ))}
              {rows.length > 6 && <li className="pf-escalate-pop__muted">and {rows.length - 6} more — open the register</li>}
            </ul>
          )}
        </Popover>
      </td>
    </tr>
  );
}
