import { useEffect, useMemo, useRef, useState } from "react";

/**
 * A compact multi-select checkbox dropdown — the control the filter bar is built from.
 *
 * WHY THIS EXISTS RATHER THAN A ROW OF BUTTONS OR A NATIVE <select multiple>
 *   The dashboard's filter bar had one button per Project, laid out in a wrapping flex row. With 14
 *   projects that stacked vertically down the left of the panel and pushed the real filters halfway
 *   down the page — the layout defect this control removes. A native `<select multiple>` is the
 *   obvious alternative and it is worse: it is unusable on a phone (no keyboard-accessible
 *   multi-select), it shows a fixed-height scroll box rather than a summary, and it cannot show an
 *   "All" affordance. So: every dimension becomes one control of this shape, all on ONE row.
 *
 * WHAT IT GUARANTEES (each of these is a bug that was worth preventing)
 *   1. The label always states what is selected — "All projects", "3 selected" or the single name —
 *      so a collapsed control is never ambiguous about whether a filter is active.
 *   2. Clicking outside closes it. A dropdown that stays open across a click elsewhere is the classic
 *      way a filter bar becomes unusable: the next click lands in the panel instead of the page.
 *   3. Escape closes it, and it reports `aria-expanded` so assistive tech can tell open from closed.
 *   4. A search box appears ONLY when the list is long enough to need one. 86 WBS codes or 27
 *      departments cannot be scanned, so those get a filter; a 3-item Status list does not, and
 *      showing a search box over 3 options is noise.
 *   5. An "All (clear)" row is always present for the multi-select case, because "clear this filter"
 *      must not require re-finding every ticked row to untick it.
 *
 * Pure presentation: it owns open/closed and the search term only. Selection lives in the caller's
 * filter state, so the URL round-trip and the export query stay the single source of truth.
 */

export type MultiSelectOption = {
  id: number | string;
  /** The primary text — an ecNo, a code, a name. */
  label: string;
  /** Optional secondary text, shown muted after the label (a project name after its code). */
  detail?: string;
  /**
   * When set, the option is offered but cannot be ticked, and this sentence explains why. Used for a
   * WBS or Section whose parent Project/Department is filtered out — the operator sees the row and
   * reads the reason instead of concluding the list is broken.
   */
  disabledReason?: string;
};

type Props = {
  label: string;
  /** The empty-state text, e.g. "All projects". Shown when nothing is selected. */
  allLabel: string;
  options: MultiSelectOption[];
  selected: Array<number | string>;
  onChange: (next: Array<number | string>) => void;
  /** Options at or above this count get a search box. Below it, a search box is noise. */
  searchThreshold?: number;
  /** Placeholder for the search box. */
  searchPlaceholder?: string;
  /** Minimum width of the control, in px. Keeps the single row from collapsing to slivers. */
  minWidth?: number;
};

export function MultiSelectFilter({
  label,
  allLabel,
  options,
  selected,
  onChange,
  searchThreshold = 12,
  searchPlaceholder = "Search…",
  minWidth = 168,
}: Props) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Clicking anywhere outside closes the panel. Without this the dropdown swallows the next click:
  // the operator clicks a table header or another control and the list stays in the way.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Focusing the search box on open means the keyboard path is "click, type, space" rather than
  // "click, tab past the control, type".
  useEffect(() => {
    if (open && options.length >= searchThreshold) searchRef.current?.focus();
  }, [open, options.length, searchThreshold]);

  const showSearch = options.length >= searchThreshold;
  const needle = term.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!needle) return options;
    return options.filter((option) =>
      `${option.label} ${option.detail ?? ""}`.toLowerCase().includes(needle)
    );
  }, [options, needle]);

  const selectedCount = selected.length;
  /** The collapsed label: never ambiguous about whether a filter is active. */
  const summary =
    selectedCount === 0
      ? allLabel
      : selectedCount === 1
        ? options.find((option) => option.id === selected[0])?.label ?? "1 selected"
        : `${selectedCount} selected`;

  function toggle(id: number | string) {
    onChange(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]);
  }

  return (
    <div className="filter-field pf-ms" ref={wrapRef} style={{ minWidth }}>
      <label>{label}</label>
      <button
        type="button"
        className={`pf-ms__control${selectedCount ? " pf-ms__control--active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={summary}
      >
        <span className="pf-ms__summary">{summary}</span>
        <span className="pf-ms__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="pf-ms__panel" role="listbox" aria-multiselectable="true">
          {showSearch && (
            <div className="pf-ms__search">
              <input ref={searchRef} value={term} onChange={(event) => setTerm(event.target.value)} placeholder={searchPlaceholder} />
            </div>
          )}

          <div className="pf-ms__list">
            {/* Clear is always offered for a multi-select: unticking a dozen rows to clear a filter
                is the kind of small friction that makes an operator stop using the filter at all. */}
            <label className="pf-ms__row pf-ms__row--all">
              <input
                type="checkbox"
                checked={selectedCount === 0}
                onChange={() => onChange([])}
              />
              <span>{allLabel}</span>
            </label>

            {visible.length === 0 && <div className="pf-ms__empty">No match for “{term}”.</div>}

            {visible.map((option) => {
              const disabled = Boolean(option.disabledReason);
              return (
                <label
                  key={option.id}
                  className={`pf-ms__row${disabled ? " pf-ms__row--disabled" : ""}`}
                  title={option.disabledReason ?? option.detail ?? option.label}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(option.id)}
                    disabled={disabled}
                    onChange={() => toggle(option.id)}
                  />
                  <span className="pf-ms__row-label">{option.label}</span>
                  {option.detail && <span className="pf-ms__row-detail">{option.detail}</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
