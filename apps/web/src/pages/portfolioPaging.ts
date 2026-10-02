/**
 * Pure pagination rules for the operations dashboard tables.
 *
 * Lives here (not in the page component) because the job-order table can show up to 63 rows
 * in one unbroken scroll, and every decision below is one a page would otherwise re-derive —
 * and get subtly wrong — on each render. The three that matter:
 *
 *  - EMPTY IS NOT AN ERROR. An empty list still reports pageCount 1 / page 1, so the pager
 *    never renders "page 0 of 0" and the caller never has to special-case "there are no rows".
 *  - THE PAGE IS CLAMPED, NOT REJECTED. A filter change can shrink the list under the page the
 *    operator is standing on (they were on page 3, the filter now yields 12 rows). The correct
 *    behaviour is to show the nearest valid page — never crash, and never leave an empty table
 *    with a live Next button.
 *  - from/to ARE FOR THE READER: 1-based, inclusive, so the pager can say
 *    "Showing 26-50 of 63" verbatim. With no rows they are 0, so the sentence can never read
 *    the misleading "Showing 1-0 of 0".
 *
 * Strictly pure: no React, no DOM, no I/O. It takes a readonly array and returns a plain
 * value, so it can be unit-tested without a browser and reused by any table on the dashboard.
 */

/** The default rows-per-page for the dashboard tables; a caller may pass its own. */
export const PAGE_SIZE = 25;

export type PageSlice<T> = {
  /** The rows on this page: a contiguous, in-order slice of the original array. */
  rows: T[];
  /** The clamped page actually shown (1-based). */
  page: number;
  /** Total number of pages; at least 1, even for an empty list. */
  pageCount: number;
  /** Total number of rows across every page. */
  total: number;
  /** 1-based inclusive number of the first row shown, or 0 when there are no rows. */
  from: number;
  /** 1-based inclusive number of the last row shown, or 0 when there are no rows. */
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
};

/**
 * A page size is only usable if it is a positive finite integer. Anything else (0, a negative,
 * NaN, Infinity, 7.5) would produce NaN or fractional page arithmetic downstream, so it falls
 * back to the module default rather than being propagated. `Number.isInteger` rejects every one
 * of those in a single test.
 */
function normalizePageSize(pageSize: number | undefined): number {
  if (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1) return PAGE_SIZE;
  return pageSize;
}

/**
 * A requested page is a display index: anything that is not a positive finite number falls
 * back to 1, and a fractional page is floored (2.5 is page 2, the page the reader can actually
 * see). Normalising here is what guarantees we never return NaN or a fractional page.
 */
function normalizePage(page: number): number {
  if (typeof page !== "number" || !Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

/** A page count is a count: at least 1, integral. Defensive, since callers may pass their own. */
function normalizeCount(pageCount: number): number {
  if (typeof pageCount !== "number" || !Number.isFinite(pageCount)) return 1;
  return Math.max(1, Math.floor(pageCount));
}

/**
 * Clamp a requested page into [1, pageCount].
 *
 * Used directly by the pager for the Next/Prev targets, and internally by `paginate` so that a
 * shrunk list lands on the nearest valid page instead of an empty one.
 */
export function clampPage(page: number, pageCount: number): number {
  return Math.min(normalizePage(page), normalizeCount(pageCount));
}

/**
 * Slice a list for one page, with every display number a pager needs.
 *
 * `page` is CLAMPED into range (see the header): a page past the end shows the last page and a
 * page below 1 shows the first, so a stale page index from a previous, larger result set can
 * never render an empty table with a live Next button.
 */
export function paginate<T>(rows: readonly T[], page: number, pageSize?: number): PageSlice<T> {
  const size = normalizePageSize(pageSize);
  const total = rows.length;
  // Empty list is still ONE page: the pager shows "1", not "0 of 0", and needs no special case.
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = clampPage(page, pageCount);

  const start = (current - 1) * size;
  const pageRows = rows.slice(start, start + size);

  // 1-based inclusive display numbers; both 0 when there are no rows (never "1-0 of 0").
  const from = total === 0 ? 0 : start + 1;
  const to = total === 0 ? 0 : start + pageRows.length;

  return {
    rows: pageRows,
    page: current,
    pageCount,
    total,
    from,
    to,
    hasPrev: current > 1,
    hasNext: current < pageCount,
  };
}

/** Contiguous inclusive integer range, used to render "all pages" when they fit within `max`. */
function range(fromInclusive: number, toInclusive: number): number[] {
  const out: number[] = [];
  for (let n = fromInclusive; n <= toInclusive; n += 1) out.push(n);
  return out;
}

/**
 * The numbered buttons to render, at most `max` of them (default 7).
 *
 * Why window: with 100 pages a full list is unreadable and would push the job table off screen.
 * The window always keeps the first and last page — the reader needs a way back to the start
 * and a way to reach the end — and slides the interior run around `current` so the current page
 * is always among them.
 *
 * Robustness: pageCount 0/1 and a `max` below 3 are handled explicitly rather than throwing.
 * The result never contains an out-of-range number, a duplicate, or a fractional value.
 */
export function pageNumbers(current: number, pageCount: number, max = 7): number[] {
  const count = Math.floor(pageCount);
  if (!Number.isFinite(count) || count <= 0) return [];
  if (count === 1) return [1];

  // A max that is not a positive integer is unusable; fall back to the default rather than
  // producing an empty or negative-length window.
  const limit = typeof max === "number" && Number.isFinite(max) && Math.floor(max) >= 1 ? Math.floor(max) : 7;

  // Everything fits: show every page.
  if (limit >= count) return range(1, count);

  // Degenerate maxima cannot satisfy "first AND last" without exceeding the limit; return a
  // single valid page rather than an out-of-range or duplicate pair.
  if (limit === 1) return [clampPage(current, count)];

  // Two slots are reserved for the first and last page. With `limit === 2` there is no interior
  // run, and the two endpoints are exactly the two buttons.
  const interior = limit - 2;
  if (interior === 0) return [1, count];

  // Place a run of `interior` consecutive interior pages (each in [2, count-1]) around current.
  // The run may reach up to count-1 (one below the reserved last page) but no further, so it can
  // never collide with the reserved endpoints and its length is always exactly `interior`.
  const maxStart = count - interior; // last start whose run ends at count-1
  const start = Math.max(2, Math.min(normalizePage(current) - Math.floor(interior / 2), maxStart));

  return [1, ...range(start, start + interior - 1), count];
}
