/**
 * The `% Qty` cell formatting rule — the ONE place a quantity-completion FRACTION
 * becomes the text a reader sees.
 *
 * WHY THIS IS A SEPARATE PURE MODULE. The three surfaces (web `% Qty`, Excel `%Qty`,
 * PDF `%Qty`) all render the API's `qtyCompletePct`, and the divide-by-zero rule is the
 * kind of thing that gets subtly wrong when it is inlined in JSX — a stray `?? "—"` or an
 * unguarded `toFixed` turns a real 0% into a blank or a literal `"NaN%"`. Kept here it is
 * unit-testable under `node:test` with no DOM, and the page imports the function instead of
 * re-deriving the rule.
 *
 * THE API CONTRACT says `qtyCompletePct` is ALWAYS a finite number (achieved/target when
 * the target is positive and finite, otherwise exactly 0 — never NaN, Infinity or null).
 * So, strictly, no guard is needed. We guard anyway because the browser can hold a STALE
 * BUNDLE or an OLD CACHED PAYLOAD from before the field existed (an old `/reports/portfolio`
 * response without `qtyCompletePct`, or a user mid-deploy). In that case `value` is
 * `undefined`, and `(undefined * 100).toFixed(1)` would print the literal "NaN%" into a
 * numeric column that otherwise looks authoritative. A blank would read as "no data" when
 * the honest reading of a missing progress figure is "zero complete". So a non-finite value
 * falls back to "0.0%" — the same string a genuine zero produces — rather than a defect.
 *
 * BEHAVIOUR:
 *   - the argument is a FRACTION (0.55 = 55%), matching the API's `qtyCompletePct`;
 *   - a finite number renders with exactly one decimal: 0 -> "0.0%", 0.55 -> "55.0%",
 *     1.5 -> "150.0%" (over-achievement is NOT clamped, so >100% is shown as-is);
 *   - null/undefined/NaN/±Infinity render "0.0%" (never "NaN%", never "").
 */

/** Render a quantity-completion fraction as the `% Qty` cell text. Never returns NaN or blank. */
export function fmtQtyCompletePct(value: number | null | undefined): string {
  // See the module header: the guard exists for a stale bundle / cached payload, not because
  // the API contract permits a non-finite value.
  if (value === null || value === undefined || !Number.isFinite(value)) return "0.0%";
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * A short note that explains WHICH zero a 0.0% is, or null when the number speaks for itself.
 *
 * A 0.0% from "nothing completed yet" (a positive target, zero achieved) and a 0.0% from
 * "there is no quantity budget to measure against" are different facts that share the number
 * 0. The former is already legible from a positive QTY BDG beside a QTY Prgsd of 0, so it
 * needs no note. The latter does, because the row would otherwise read as ordinary slow
 * progress; `targetQty <= 0` (or a junk non-finite target) is exactly that case.
 *
 * WHY NOT `qtyBand`: the API's `qtyBand` is NOT_MEASURABLE both when there is no quantity
 * budget AND when there is no APPROVED progress row yet — two situations a single badge
 * cannot tell apart. `targetQty` can, so the note keys off it. Kept to one short phrase so it
 * cannot widen the column.
 */
export function qtyCompleteNote(targetQty: number): string | null {
  // Mirror the API's own "is there a denominator" test: a target that is not positive/finite
  // means no quantity budget to measure against.
  if (!Number.isFinite(targetQty) || !(targetQty > 0)) return "no qty budget";
  return null;
}
