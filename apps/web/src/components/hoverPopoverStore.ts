/**
 * ONE popover at a time, across the whole dashboard.
 *
 * WHY A STORE AND NOT ROW STATE: every row owning an `open` boolean is what produced the strobe — move
 * the pointer down a table and each row's own timer opens its own popover, so several are alive at once
 * and they overlap the rows beneath them. The rule "at most one" cannot be enforced per row; it needs a
 * single owner.
 *
 * Claiming is exclusive and instant: when a row claims, whoever held it is told to close in the same
 * tick, so the old popover never survives to overlap the new one. Releasing is ownership-checked — a
 * row that has already been displaced cannot close the row that replaced it.
 *
 * Pure and framework-free (no React import) so the invariant is a unit test rather than a screenshot.
 */

export type PopoverKey = string;

type Listener = (open: PopoverKey | null) => void;

let openKey: PopoverKey | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener(openKey);
}

/** Take the one slot. The previous holder loses it immediately. */
export function claimPopover(key: PopoverKey): void {
  if (openKey === key) return;
  openKey = key;
  notify();
}

/** Give the slot back — only if it is still ours. */
export function releasePopover(key: PopoverKey): void {
  if (openKey !== key) return;
  openKey = null;
  notify();
}

/** Used when the drawer opens, the tab changes or the page unmounts: nothing may linger. */
export function closeAllPopovers(): void {
  if (openKey === null) return;
  openKey = null;
  notify();
}

export function currentPopover(): PopoverKey | null {
  return openKey;
}

export function isPopoverOpen(key: PopoverKey): boolean {
  return openKey === key;
}

export function subscribePopover(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget everything. */
export function resetPopoverStore(): void {
  openKey = null;
  listeners.clear();
}
